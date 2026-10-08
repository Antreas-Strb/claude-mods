import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, On, RenderChildren, RenderElement, RenderSurface, Timer } from 'claude-code'

import type {
  GlanceFile,
  GlanceChecklist,
  GlanceHelper,
  GlanceHistoryEntry,
  GlanceHistoryView,
  GlancePhase,
  GlanceTask,
  GlanceTaskSize,
  GlanceUsage,
} from '../types'
import {
  HISTORY_PREFIX,
  WEEK_DAYS,
  SIZE_WEIGHT,
  clockTime,
  dayFromArgument,
  dayKey,
  entryFiles,
  entryFromChecklist,
  expiredHistoryKeys,
  filesNote,
  longDay,
  projectName,
  shiftDay,
  teamReport,
  weekSummary,
  paceFromHistory,
  upsertEntry,
} from './history'
import { findSecrets, maskPrivate } from './privacy'
import { GLYPH, TONE, TONE_TEXT, badgeSvg, blankSvg, dotsSvg, iconSvg, meterSvg, openRingSvg, ringSvg } from './look'
import type { IconName, Tone } from './look'

const PLUGIN = 'glanceflow'
const PLAN_TOOL = `mcp__${PLUGIN}__plan_steps`
const PROGRESS_TOOL = `mcp__${PLUGIN}__report_progress`
const ALWAYS_ALLOWED = new Set([
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
  PLAN_TOOL,
  PROGRESS_TOOL,
])
const STORE_KEY = 'glanceEnabled'
const DETAIL_KEY = 'glanceDetail'
const SOUND_KEY = 'glanceSound'
const CALM_KEY = 'glanceCalm'
const GUARD_KEY = 'glanceGuard'
const APPROVE_KEY = 'glanceApprove'
const NOTICE_KEY = 'glanceNotice'
const TOUR_KEY = 'glanceTour'
/** The welcome, three short cards the first time: what the checklist is, what Needs you means, where the rest lives. */
const TOUR = [
  'A checklist shows here when you ask Claude for something with a few steps: each step, how far along it is, and about how long is left.',
  'When Claude needs you, the checklist says Needs you in yellow, and what to do. Turn on sounds or desktop notices in Settings to hear or see it from another app.',
  'Settings, below, holds every choice. History shows your past jobs and Your week. To see this welcome again, type /glanceflow tour.',
]
const HANDOFF_KEY = 'lastHandoff'
const MAX_NAME = 40
// Below this width the mode button drops the name; below METER_MIN_COLUMNS the bars go, so step names keep their room.
const NARROW = 60
const METER_MIN_COLUMNS = 50
// Longer plans fold finished and later steps into one line each; the Plan panel has them all.
const COMPACT_AFTER = 5
const MAX_SUMMARY = 100
const METER = 10
const LABEL_WIDTH = 7
const TICK_MS = 250
// Calm mode redraws only to keep times current.
const CALM_TICK_MS = 5000
// A job shorter than this finishes without a sound.
const LONG_JOB_MS = 60_000
const COLLAPSE_MS = 5000
const RESEND_WINDOW_MS = 2 * 60 * 1000
const LIMIT_WARN = 80
const LIMIT_ALERT = 95
// How full the chat gets before the band offers to tidy it up, unless the person picks another point.
const TIDY_AT_DEFAULT = 50
const TIDY_CHOICES = [0, 40, 50, 60, 75] as const
const TIDY_KEY = 'glanceTidyAt'
const CHECKPOINT_KEY = 'lastCheckpoint'
// Each recent chat's checklist, by session id, so a resumed chat picks up where it was.
const RESUME_KEY = 'glanceResume'
const RESUME_KEEP = 20
const LIMIT_LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', spend_limit: 'spending' }

const DENIED = 'you said no to a step, so Claude paused'
const FAILING = 'a step keeps failing, Claude is trying another way'
const STALLED = 'no news for 3 minutes. Press Esc to stop Claude, or give it a little longer'
// No sign of life from Claude (a piece of its reply, a tool starting or ending) for this long while it works.
const STALL_MS = 3 * 60_000
const PERMISSION = "Answer Claude's request in the chat"
const QUESTION = "Answer Claude's question in the chat"
const WAITING = 'Reply to Claude in the box below'
const APPROVE = 'Read the plan, then press Start or tell Claude what to change'

const enabledAtom = atom({ plugin: 'glanceflow', key: 'glanceEnabled' } as const, true)
const detailAtom = atom({ plugin: 'glanceflow', key: 'detailLevel' } as const, 'simple')
const checklistAtom = atom({ plugin: 'glanceflow', key: 'checklist' } as const, null)
const tickAtom = atom({ plugin: 'glanceflow', key: 'tick' } as const, 0)
const NO_USAGE: GlanceUsage = { limits: [], limitPercent: null, limitLabel: null, limitResetsAt: null, contextPercent: null, costUsd: null }
const usageAtom = atom({ plugin: 'glanceflow', key: 'usage' } as const, NO_USAGE)
const soundAtom = atom({ plugin: 'glanceflow', key: 'soundMode' } as const, 'off')
const calmAtom = atom({ plugin: 'glanceflow', key: 'isCalm' } as const, false)
const guardAtom = atom({ plugin: 'glanceflow', key: 'isGuarded' } as const, true)
const approveAtom = atom({ plugin: 'glanceflow', key: 'approvePlan' } as const, false)
const noticeAtom = atom({ plugin: 'glanceflow', key: 'isNoticing' } as const, false)
const tourAtom = atom({ plugin: 'glanceflow', key: 'tourStep' } as const, null)
const tidyAtAtom = atom({ plugin: 'glanceflow', key: 'tidyAt' } as const, TIDY_AT_DEFAULT)
const checkpointAtom = atom({ plugin: 'glanceflow', key: 'checkpointAt' } as const, null)
const recapAtom = atom({ plugin: 'glanceflow', key: 'isRecapShown' } as const, false)
const historyAtom = atom({ plugin: 'glanceflow', key: 'historyView' } as const, null)
const HISTORY_PANE = 'glanceflow-history'
const PLAN_PANE = 'glanceflow-plan'
const RECAP_PANE = 'glanceflow-recap'
const SETTINGS_PANE = 'glanceflow-settings'
const handoffAtom = atom({ plugin: 'glanceflow', key: 'handoffState' } as const, 'idle')
const HANDOFF_CONFIRM_MS = 8000
// What the Continue button sends, as the person's own words; turn.start knows it and keeps the job going.
const CONTINUE_TEXT = 'Please continue where you left off.'
// What the Start button sends when the person approves the plan.
const START_TEXT = 'The plan looks good. Please start.'
// The longest plain sentence Claude's own description of a tool call keeps.
const MAX_DETAIL = 90
const HANDOFF_PROMPT = `Write a handoff note so a brand-new chat can carry on this work without this conversation.
Cover, briefly: the goal; what is already done; what is left, in order; decisions made and why; the files, commands
or links that matter; and the very next step. Under 300 words, no preamble.
Start with exactly: "Continuing from an earlier chat. Here is where things stand:"`

const CHECKPOINT_PROMPT = `This chat is about to be compacted to free up room. Write a checkpoint so the work carries on
without losing anything that matters. Cover, briefly: the goal; what is already done; what is left, in order; decisions
made and why; what the person asked for or ruled out; the files, commands or links that matter; open questions; and the
very next step. Under 300 words, no preamble. Start with exactly: "Checkpoint:"`

const PROMPT_SECTION = `# GlanceFlow (progress checklist)
The person follows your work on a checklist above the prompt, in plain English.
- A question you can answer straight away, with no tools, needs no plan: just answer.
- Before you use any other tool, call plan_steps (tool ${PLAN_TOOL}) with 2 to 8 steps in order. If it is deferred, load it with ToolSearch first. If this session has TodoWrite or TaskCreate you may use that to-do list as the plan instead.
- Give each step a size in plan_steps' sizes list, in the same order: S (a few minutes), M, or L (the biggest pieces of work).
- Then call report_progress (tool ${PROGRESS_TOOL}) as real progress happens, and with percent 100 the moment a step finishes. With percent 100, add a summary: one short plain-English sentence on what the step got done, like "Added a pricing table with three plans".
- Write every step name in plain English a non-technical person understands, under 40 characters, starting with a verb, like "Build the pricing section".
- Never put file paths, file names, commands, code or tool names in a step name.`

const CODE_FILE =
  /\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kts?|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|bash|json|ya?ml|toml|css|scss|sass|less|html?|md|mdx|sql|vue|svelte|lock|env|xml|ini|cfg|conf|txt|csv|log)\W*$/i

const pad2 = (value: number) => String(value).padStart(2, '0')

/** "10:01:45 UTC" in the person's own time, "13:01:45" in Athens; a time without UTC, GMT or Z is left as written. */
export function localTimes(text: string, today = new Date()): string {
  return text.replace(/(?<![\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s?(?:UTC|GMT|Z)\b/g, (whole, hours, minutes, seconds) => {
    if (Number(hours) > 23 || Number(minutes) > 59) return whole
    const at = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), Number(hours), Number(minutes), Number(seconds ?? 0)))
    return `${pad2(at.getHours())}:${pad2(at.getMinutes())}${seconds === undefined ? '' : `:${pad2(at.getSeconds())}`}`
  })
}

/** When a plan window resets, in the person's own time: "at 18:40", or "on Thu at 09:00" when it is more than a day away. */
export function resetTime(resetsAt: string | null, at: number): string | null {
  const when = resetsAt ? new Date(resetsAt) : null
  if (when === null || Number.isNaN(when.getTime())) return null
  const time = `${pad2(when.getHours())}:${pad2(when.getMinutes())}`
  if (when.getTime() - at <= 24 * 3_600_000) return `at ${time}`
  return `on ${when.toLocaleDateString('en-GB', { weekday: 'short' })} at ${time}`
}

/** Turns any step or job name, or a step's summary, into short plain English. */
export function cleanName(raw: unknown, max = MAX_NAME): string {
  const words = localTimes(maskPrivate(String(raw ?? '')))
    .replace(/`[^`]*`/g, ' ')
    .replace(/`/g, ' ')
    .split(/\s+/)
    .filter(word => word && !word.includes('•') && !/[/\\]/.test(word) && !CODE_FILE.test(word))
  let name = words.join(' ').replace(/\s+/g, ' ').trim()
  if (!name) {
    return 'Working on it'
  }
  name = name.charAt(0).toUpperCase() + name.slice(1)
  if (name.length <= max) {
    return name
  }
  const cut = name.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')

  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–]+$/, '')}…`
}

/**
 * A name in Title Case ("Copy Mod With Button Choices") in the sentence case the checklist uses everywhere else. A
 * word with a capital past its first letter (GlanceFlow, PR) keeps its case; a name already in sentence case stays.
 */
export function sentenceCase(name: string): string {
  const words = name.split(' ')
  if (words.length < 3 || words.some(word => /^\p{Ll}/u.test(word))) return name
  return words.map((word, index) => (index === 0 || /\p{Lu}/u.test(word.slice(1)) ? word : word.toLowerCase())).join(' ')
}

function apiErrorSentence(kind: string, details = ''): string {
  if (/too long|context (window|length|limit)|max(imum)? context/i.test(details)) {
    return 'type /compact and try again'
  }
  if (kind === 'rate_limit' || kind === 'billing_error') {
    return 'you hit your usage limit, try again a little later'
  }
  if (kind === 'overloaded') {
    return "Claude's servers are busy, try again in a minute"
  }
  if (/authentication|oauth|credential/.test(kind)) {
    return 'type /login'
  }
  if (/network|connect|ECONN|ENOTFOUND|socket|fetch failed|offline/i.test(details)) {
    return 'the internet connection dropped'
  }

  return "Claude's servers are busy, try again in a minute"
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A duration where words flow (the desktop): a whole minute drops its seconds, `1m` rather than `1m 0s`. */
function durationWords(ms: number): string {
  return formatDuration(ms).replace(/^(\d+m) 0s$/, '$1')
}

/** Terminal cells a character takes: two for CJK and emoji, none for joiners and accents. */
function cellsOf(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code === 0x200d || (code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0
  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)

  return isWide ? 2 : 1
}

/** Pads or trims text to exactly `width` terminal cells, so columns line up in any script. */
export function fit(text: string, width: number): string {
  if (width <= 0) {
    return ''
  }
  const chars = Array.from(text)
  const total = chars.reduce((sum, char) => sum + cellsOf(char), 0)
  if (total <= width) {
    return text + ' '.repeat(width - total)
  }
  let kept = ''
  let used = 0
  for (const char of chars) {
    const size = cellsOf(char)
    if (used + size > width - 1) break
    kept += char
    used += size
  }

  return `${kept}…${' '.repeat(width - 1 - used)}`
}

function task(name: string, status: GlanceTask['status'], id = name, size: GlanceTaskSize = 'M'): GlanceTask {
  return { id, name, status, percent: status === 'done' ? 100 : 0, hasReported: status === 'done', size, summary: null, tokens: 0, cachedTokens: 0, startedAt: null, finishedAt: null }
}

/** Token counts move to the new plan's step of the same name; the rest go to its first step, so the job total holds. */
export function carryTokens(old: GlanceTask[], next: GlanceTask[]): GlanceTask[] {
  const used = new Set<string>()
  const carried = next.map(one => {
    const same = old.find(before => before.name === one.name && !used.has(before.id))
    if (!same) return one
    used.add(same.id)
    return { ...one, tokens: same.tokens, cachedTokens: same.cachedTokens, summary: same.summary, files: same.files }
  })
  const leftover = old.filter(before => !used.has(before.id))
  const [first, ...rest] = carried
  if (!first) return carried

  return [
    {
      ...first,
      tokens: first.tokens + leftover.reduce((sum, one) => sum + one.tokens, 0),
      cachedTokens: first.cachedTokens + leftover.reduce((sum, one) => sum + one.cachedTokens, 0),
    },
    ...rest,
  ]
}

/** 950 → 950, 12_400 → 12.4k, 3_200_000 → 3.2M. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 100_000 ? 1 : 0).replace(/\.0$/, '')}k`

  return `${(count / 1_000_000).toFixed(1)}M`
}

/** New tokens first (what really counts), then the cheap ones read back from the cache. */
export function tokenNote(tokens: number, cachedTokens: number): string {
  if (tokens <= 0) return ''
  if (cachedTokens <= 0) return `${formatTokens(tokens)} tokens`

  return `${formatTokens(tokens - cachedTokens)} new · ${formatTokens(cachedTokens)} cached`
}

function sizeOf(raw: unknown): GlanceTaskSize {
  const size = String(raw ?? '').trim().toUpperCase()

  return size === 'S' || size === 'L' ? size : 'M'
}

/** Overall progress: finished work out of the plan, S/M/L counting 1/2/3, the current step in part. */
export function overallProgress(
  tasks: GlanceTask[],
  activePercent?: number,
): { percent: number; doneCount: number; work: number } {
  const total = tasks.reduce((sum, one) => sum + SIZE_WEIGHT[one.size], 0)
  const work = tasks.reduce((sum, one) => {
    const weight = SIZE_WEIGHT[one.size]
    if (one.status === 'done') return sum + weight
    if (one.status === 'active' && activePercent !== undefined) return sum + (weight * activePercent) / 100
    if (one.status === 'active' && one.hasReported) return sum + (weight * one.percent) / 100
    return sum
  }, 0)

  return {
    percent: total ? Math.round((100 * work) / total) : 0,
    doneCount: tasks.filter(one => one.status === 'done').length,
    work: total ? work / total : 0,
  }
}

/** Each step's start and end time, stamped as its status changes. */
export function stampTimes(tasks: GlanceTask[], at: number): GlanceTask[] {
  return tasks.map(one => {
    if (one.status === 'upcoming') return one.startedAt === null && one.finishedAt === null ? one : { ...one, startedAt: null, finishedAt: null }
    if (one.status === 'active') return one.startedAt === null || one.finishedAt !== null ? { ...one, startedAt: one.startedAt ?? at, finishedAt: null } : one
    return one.finishedAt === null ? { ...one, startedAt: one.startedAt ?? at, finishedAt: at } : one
  })
}

// A step of size M is expected to take 3 minutes until this job's or this project's pace is known.
const DEFAULT_UNIT_MS = 90_000
// The project's pace from History counts as much as this many units of this job's own finished steps.
const PACE_WEIGHT = 2

/**
 * How far along the current step looks: time spent against the time this job's finished steps took per
 * unit of size. It fills gradually, stays below 100 until the step is checked off, and never falls below
 * what Claude reported.
 *
 * Time left is null once the step runs past what it should take: the percentage then sits near the top
 * whatever happens, so time spent against it would keep saying "under a minute". A lower percentage that
 * Claude reported still gives an estimate.
 */
export function stepEstimate(list: GlanceChecklist, one: GlanceTask, at: number) {
  const done = list.tasks.filter(
    step => step.status === 'done' && step.startedAt !== null && step.finishedAt !== null && step.finishedAt > step.startedAt,
  )
  const units = done.reduce((sum, step) => sum + SIZE_WEIGHT[step.size], 0)
  const spent = done.reduce((sum, step) => sum + (step.finishedAt! - step.startedAt!), 0)
  const prior = list.paceMs === null ? 0 : PACE_WEIGHT
  const unitMs = units + prior > 0 ? (spent + (list.paceMs ?? 0) * prior) / (units + prior) : DEFAULT_UNIT_MS
  const expected = Math.max(10_000, unitMs * SIZE_WEIGHT[one.size])
  const elapsedMs = one.startedAt === null ? 0 : Math.max(0, at - one.startedAt)
  const estimate = Math.min(95, Math.round((100 * elapsedMs) / expected))
  const reported = one.hasReported && one.percent > 0 && one.percent < LONG_STEP_REPORT ? one.percent : null
  // Past its expected time, time spent says nothing more: what Claude reported is the better guess.
  const percent = elapsedMs > expected && reported !== null ? reported : Math.min(99, Math.max(one.hasReported ? one.percent : 0, estimate))
  const leftMs =
    elapsedMs <= expected
      ? percent > 0
        ? (elapsedMs * (100 - percent)) / percent
        : expected
      : reported === null
        ? null
        : (elapsedMs * (100 - reported)) / reported

  return { percent, elapsedMs, expectedMs: expected, leftMs }
}

// Past its expected time, a step's own report below this still says how far along it is.
const LONG_STEP_REPORT = 90

/** A step's time left: short for the terminal's columns (`<1m left`), in words where text flows (`under a minute left`). */
function leftLabel(ms: number | null, isWords = false): string {
  if (ms === null) return 'taking longer'
  if (isWords) return ms < 60_000 ? 'under a minute left' : `about ${formatLeft(ms)} left`
  return ms < 60_000 ? '<1m left' : `~${formatLeft(ms)} left`
}

/**
 * Time left at this job's own pace since the plan once two steps are done. Before that, the steps left at
 * this project's usual pace from History; nothing when History doesn't know it yet.
 */
export function timeLeft(list: GlanceChecklist, at: number, activePercent?: number): number | null {
  const { doneCount, work } = overallProgress(list.tasks, activePercent)
  if (list.planAt === null || work >= 1) return null
  // A step running long makes any total a guess: say nothing rather than something too short.
  const active = list.tasks.find(one => one.status === 'active')
  if (active && stepEstimate(list, active, at).leftMs === null) return null
  if (doneCount >= 2 && work > 0) return Math.round(((at - list.planAt) / work) * (1 - work))
  if (list.paceMs === null) return null

  return Math.round(
    list.tasks
      .filter(one => one.status !== 'done')
      .reduce((sum, one) => sum + (stepEstimate(list, one, at).leftMs ?? 0), 0),
  )
}

/**
 * Steps still open after Claude answered. The last step alone still open counts as done:
 * Claude finished but forgot to report 100.
 */
function hasUnfinishedWork(tasks: GlanceTask[]): boolean {
  const open = tasks.filter(one => one.status !== 'done')

  return open.length > 1 || (open.length === 1 && open[0] !== tasks[tasks.length - 1])
}

/** Header details in order of importance; the least important drop first so the title stays readable. */
export function headerDetails(parts: string[], room: number): string {
  const kept = parts.filter(Boolean)
  while (kept.length > 1 && kept.map(one => ` · ${one}`).join('').length > room) {
    kept.pop()
  }

  return kept.map(one => ` · ${one}`).join('')
}

const SPINNER = ['◐', '◓', '◑', '◒']
const HELPERS_PER_STEP = 3

/** A model id as people say it: claude-haiku-4-5-20251001 → Haiku 4.5. */
export function prettyModel(model: string | null | undefined): string | null {
  if (!model) return null
  const match = /(opus|sonnet|haiku|fable)(?:[-_ ](\d+)(?:[-.](\d{1,2})(?!\d))?)?/i.exec(model)
  if (!match) return model
  const name = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase()

  return [name, [match[2], match[3]].filter(Boolean).join('.')].filter(Boolean).join(' ')
}

/** The step new helpers belong to: the current one, or the last one once all are done. */
function currentStepId(list: GlanceChecklist): string {
  return (list.tasks.find(one => one.status === 'active') ?? list.tasks[list.tasks.length - 1])?.id ?? ''
}

// The tools that write files, and the field each names the file in.
const FILE_TOOLS: Record<string, 'file_path' | 'notebook_path'> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }

/** A file's path within the project; outside it, just its name. */
export function projectPath(path: string, project: string): string {
  const root = project.replace(/[\\/]+$/, '')
  if (root !== '' && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))) return path.slice(root.length + 1)

  return path.split(/[\\/]/).pop() ?? path
}

export type BackgroundTask = { id: string; type: string; status: string; description: string }

/** Background tasks as the latest list has them: new ones join, ones no longer listed have finished. */
export function reconcileBackground(list: GlanceChecklist, tasks: readonly BackgroundTask[]): GlanceHelper[] {
  const listed = new Map(tasks.map(one => [`bg:${one.id}`, one]))
  const kept = list.helpers.map(helper => {
    if (helper.kind !== 'background' || helper.status !== 'running') return helper
    const still = listed.get(helper.id)
    return still ? helper : { ...helper, status: 'done' as const }
  })
  const known = new Set(kept.map(one => one.id))
  const added = tasks
    .filter(one => !known.has(`bg:${one.id}`))
    .map(
      (one): GlanceHelper => ({
        id: `bg:${one.id}`,
        stepId: currentStepId(list),
        kind: 'background',
        label: cleanName(one.description, MAX_DETAIL),
        type: one.type,
        model: null,
        effort: null,
        status: 'running',
        tokens: 0,
      }),
    )

  return [...kept, ...added]
}

/** What a tool call is doing, in plain words; null for planning tools and helpers, which show elsewhere. */
export function activityOf(tool: string, input: { command?: unknown }): string | null {
  if (tool === 'Read' || tool === 'NotebookRead') return 'Reading files'
  if (tool === 'Grep' || tool === 'Glob' || tool === 'LS') return 'Searching the project'
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'Editing files'
  if (tool === 'Write') return 'Writing files'
  if (tool === 'WebFetch') return 'Reading a web page'
  if (tool === 'WebSearch') return 'Searching the web'
  if (tool === 'Skill') return 'Following a skill'
  if (tool.startsWith('mcp__') && !tool.startsWith(`mcp__${PLUGIN}__`)) return 'Using a connected app'
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(input.command ?? '')
    if (/\b(test|tests|jest|vitest|pytest|mocha|playwright|rspec)\b/i.test(command)) return 'Running the tests'
    if (/\b(npm|pnpm|yarn|bun|pip3?|brew|cargo|gem)\s+(install|add|i)\b/i.test(command)) return 'Installing packages'
    if (/\bgit\s+\w+/.test(command)) return 'Working with git'
    if (/\b(build|tsc|compile)\b/i.test(command)) return 'Building the project'
    return 'Running a command'
  }
  return null
}

/** A job's cost in plain dollars: "$0.42", or "<$0.01" for less than a cent. */
export function formatCost(usd: number): string {
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

/** What the job has cost so far, from the session's spend; null where the host keeps no ledger. */
function jobCost(list: GlanceChecklist, usage: GlanceUsage): number | null {
  return usage.costUsd === null || list.costAtStart === null ? null : Math.max(0, usage.costUsd - list.costAtStart)
}

function isBusy(list: GlanceChecklist): boolean {
  return list.helpers.some(one => one.status === 'running')
}

/** The person's own words: notes an app adds around a prompt (<system-reminder>…) are not the request. */
/** A short "carry on" the person typed, in English or Greek: it continues the job instead of starting a new one. */
export function isContinueWords(text: string): boolean {
  const words = text.trim().toLowerCase().replace(/[.!…,;:]+$/g, '').replace(/\s+/g, ' ')
  return (
    /^(please )?(continue|go on|keep going|resume|carry on|proceed|go ahead)( please)?$/.test(words) ||
    /^(σε παρακαλώ |παρακαλώ )?(συνέχισε|συνεχισε|συνέχεια|συνεχεια|προχώρα|προχωρα)( σε παρακαλώ| παρακαλώ| παρακαλω)?$/.test(words)
  )
}

/** A short "go ahead" the person typed: it approves the plan. */
export function isStartWords(text: string): boolean {
  const words = text.trim().toLowerCase().replace(/[.!…,;:]+$/g, '').replace(/\s+/g, ' ')
  return /^(start|go|go ahead|ok|okay|yes|looks good|approved?|ξεκίνα|ξεκινα|ναι|οκ|εντάξει|ενταξει)( please)?$/.test(words)
}

/** Claude's last message ends by asking the person something. Greek writes its question mark as ";", so both count; a code block never does. */
export function asksQuestion(answer: string): boolean {
  return /[?;？؟]$/.test(answer.trimEnd().replace(/[*_"'”»)\s]+$/g, ''))
}

const MAX_QUESTION = 160

/** The question Claude ended on, as one plain line: its last sentence, or the whole last paragraph when that sentence is a few words. */
export function questionOf(answer: string): string | null {
  if (!asksQuestion(answer)) return null
  const paragraph = (answer.trim().split(/\n\s*\n/).pop() ?? '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim()
  const last = paragraph.split(/(?<=[.!?;？؟])\s+/).pop() ?? ''
  const line = maskPrivate(last.length >= 12 ? last : paragraph)

  return line === '' ? null : line.length > MAX_QUESTION ? `${line.slice(0, MAX_QUESTION - 1)}…` : line
}

/** True when the text has no letters outside the Latin alphabet, so it can stand as an English title. */
export function isLatinText(text: string): boolean {
  return !/(?!\p{Script=Latin})\p{L}/u.test(text)
}

/** What a tool call works on, for the Plan in Details: the command, a file's name or a site. */
export function activityTarget(input: { command?: unknown; file_path?: unknown; notebook_path?: unknown; url?: unknown }): string | null {
  if (typeof input.command === 'string' && input.command.trim()) {
    return maskPrivate(input.command.trim().split('\n')[0]!).slice(0, 160)
  }
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
  if (file) return file.split(/[\\/]/).pop() ?? null
  if (typeof input.url === 'string') {
    const host = /^[a-z]+:\/\/([^/]+)/i.exec(input.url)
    return host ? host[1]! : null
  }
  return null
}

const widthOf = (text: string) => Array.from(text).reduce((sum, char) => sum + cellsOf(char), 0)

export function ownWords(text: string): string {
  return text.replace(/<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, ' ').trim()
}

function formatLeft(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000))

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Keeps exactly one active step while any step is unfinished. */
function settle(tasks: GlanceTask[]): GlanceTask[] {
  const lastActive = tasks.map(one => one.status).lastIndexOf('active')
  const fixed = tasks.map((one, index) =>
    one.status === 'active' && index !== lastActive ? { ...one, status: 'upcoming' as const } : one,
  )
  if (lastActive !== -1) {
    return fixed
  }
  const next = fixed.findIndex(one => one.status === 'upcoming')

  return fixed.map((one, index) => (index === next ? { ...one, status: 'active' as const } : one))
}

/** Applies a progress report: earlier steps check off, 100 moves to the next. */
export function applyProgress(tasks: GlanceTask[], rawName: string, rawPercent: number): GlanceTask[] {
  const name = cleanName(rawName)
  const percent = Math.min(100, Math.max(0, Math.round(Number(rawPercent) || 0)))
  let list = [...tasks]
  let index = list.findIndex(one => one.name.toLowerCase() === name.toLowerCase())
  if (index === -1) {
    const active = list.findIndex(one => one.status === 'active')
    index = active === -1 ? list.length : active
    list.splice(index, 0, task(name, 'upcoming', `${name}#${list.length}`))
  }
  list = list.map((one, at) => {
    if (at < index) {
      return { ...one, status: 'done', percent: 100, hasReported: true }
    }
    if (at === index) {
      return { ...one, status: percent >= 100 ? 'done' : 'active', percent, hasReported: true }
    }
    return one.status === 'active' ? { ...one, status: 'upcoming' } : one
  })

  return settle(list)
}

function todosToTasks(
  todos: ReadonlyArray<{ content: string; status: string }>,
  previous: GlanceTask[],
): GlanceTask[] {
  return carryTokens(previous, settle(
    todos.map((todo, index) => {
      const name = cleanName(todo.content)
      const before = previous.find(one => one.name === name)
      const status = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'upcoming'
      const kept = before && before.status === status ? before : task(name, status, `todo#${index}`)

      return { ...kept, name, status }
    }),
  ))
}

type $ = EngineInterface

// Module state: a reload starts these over (session.start restarts the ticker).
let ticker: Timer | undefined
let collapse: Timer | undefined
let saveTimer: Timer | undefined
let failuresInARow = 0
// A message held back for a password: memory only, never stored, and only to let the same one through on a resend.
let heldMessage: { text: string; at: number } | null = null
let limitLevel = 0
// The main loop's running turn, for the Pause button; and whether a pause asked for its end.
let runningTurn: string | undefined
let isPausing = false
// Mirrors the calm setting for the ticker, which runs outside any hook.
let isCalmMode = false
/** The computer this runs on, asked when the session starts; null until known, and Claude Code plays the sounds itself. */
let platform: 'mac' | 'windows' | 'linux' | null = null
let tickerEvery = 0
// Signs of life: set as Claude's reply streams or a tool starts or ends, stamped by the ticker, which runs while Claude works.
let hasSign = false
let lastSignAt = 0
let isStalled = false

const now = ($: $) => $.clock.now()

const syncTicker = ($: $, list: GlanceChecklist | null) => {
  const isAnimated = list !== null && (list.phase === 'working' || list.phase === 'needsYou' || list.phase === 'background')
  // Calm mode: nothing moves, so the clock only ticks to keep the times current.
  const every = isCalmMode ? CALM_TICK_MS : TICK_MS
  if (ticker !== undefined && (!isAnimated || tickerEvery !== every)) {
    ticker.cancel()
    ticker = undefined
  }
  if (isAnimated && ticker === undefined) {
    tickerEvery = every
    ticker = $.clock.every(every, () => {
      void update($, tickAtom, tick => (tick ?? 0) + 1)
      void checkStall($)
    })
  }
}

/** Claude showed a sign of life; a job that looked stalled is working again. */
const noteSign = ($: $) => {
  hasSign = true
  if (isStalled) {
    isStalled = false
    void setWorking($)
  }
}

/** On each tick: a running turn with no sign of life for 3 minutes may be stuck. */
const checkStall = async ($: $) => {
  const at = await now($)
  if (hasSign || runningTurn === undefined) {
    hasSign = false
    lastSignAt = at
    return
  }
  if (isStalled || at - lastSignAt < STALL_MS || !(await read($, enabledAtom))) return
  if ((await read($, checklistAtom))?.phase !== 'working') return
  isStalled = true
  await setStuck($, STALLED)
}

const ALERTS: Partial<Record<GlancePhase, { asset: string; words: string }>> = {
  needsYou: { asset: 'sounds/needs-you.wav', words: 'Claude needs you' },
  stuck: { asset: 'sounds/stuck.wav', words: 'Claude is stuck' },
  done: { asset: 'sounds/done.wav', words: 'All done' },
}

const findPlatform = async ($: $) => {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows' as const
  const { stdout } = await $.process.run(['uname', '-s']).catch(() => ({ stdout: '' }))
  const name = stdout.trim()

  return name === 'Darwin' ? ('mac' as const) : name ? ('linux' as const) : null
}

/** Runs the first of these commands that this computer has; rejects when it has none. */
const runFirst = async ($: $, commands: readonly (readonly string[])[]) => {
  for (const argv of commands) {
    try {
      const { exitCode } = await $.process.run(argv)
      if (exitCode === 0) return
    } catch {
      // Not installed here: try the next one.
    }
  }
  throw new Error('No sound player on this computer')
}

/** Plays one of GlanceFlow's sounds: Claude Code's own player on a Mac, the computer's own player on Windows and Linux. */
const playSound = async ($: $, asset: string) => {
  if (platform === 'windows') {
    const file = `${$.plugin.root}\\${asset.replaceAll('/', '\\')}`.replaceAll("'", "''")
    return runFirst($, [['powershell', '-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${file}').PlaySync()`]])
  }
  if (platform !== 'linux') return $.audio.play({ asset })
  const file = `${$.plugin.root}/${asset}`
  return runFirst($, [['paplay', file], ['pw-play', file], ['aplay', '-q', file]])
}

/** Says a few words: the platform's own voice, or on Windows and Linux the speech tools they come with. */
const sayWords = async ($: $, words: string) => {
  try {
    await $.audio.speak(words)
  } catch (error) {
    if (platform !== 'windows' && platform !== 'linux') throw error
    const quoted = words.replaceAll("'", "''")
    await runFirst(
      $,
      platform === 'windows'
        ? [['powershell', '-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${quoted}')`]]
        : [['spd-say', '-w', words], ['espeak-ng', words], ['espeak', words]],
    )
  }
}

/** Windows' own toast, shown as Windows PowerShell's; the text comes in through the environment, never as script. */
const WINDOWS_TOAST = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$text = $xml.GetElementsByTagName('text')",
  '$text.Item(0).AppendChild($xml.CreateTextNode($env:GLANCEFLOW_TITLE)) | Out-Null',
  '$text.Item(1).AppendChild($xml.CreateTextNode($env:GLANCEFLOW_BODY)) | Out-Null',
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
].join('; ')

/** A desktop notice through the computer's own notifications: Windows, macOS or Linux. The text goes in as arguments or variables, never as script. */
const showNotice = async ($: $, title: string, body: string) => {
  if (platform === 'windows') {
    await $.process
      .run(['powershell', '-NoProfile', '-Command', WINDOWS_TOAST], { env: { GLANCEFLOW_TITLE: title, GLANCEFLOW_BODY: body } })
      .catch(() => undefined)
    return
  }
  const script = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run']
  try {
    await $.process.run(['osascript', ...script, title, body])
  } catch {
    // No osascript: not a Mac. notify-send is Linux's; elsewhere the band still shows it.
    await $.process.run(['notify-send', '--app-name=Claude Code', title, body]).catch(() => undefined)
  }
}

/** What the notice says under its title: why Claude waits or is stuck, or the job's name. */
const noticeBody = (list: GlanceChecklist) =>
  (list.phase === 'needsYou' ? needsText(list) : list.phase === 'stuck' ? list.stuckReason : null) ?? list.title

/** A desktop notice when Claude needs you, gets stuck or finishes a long job, as for the sounds. */
const noticeFor = async ($: $, list: GlanceChecklist) => {
  const alert = ALERTS[list.phase]
  if (!alert || !(await read($, noticeAtom)) || !(await read($, enabledAtom))) return
  if (list.phase === 'done' && (isBusy(list) || (list.finishedAt ?? (await now($))) - list.startedAt < LONG_JOB_MS)) return
  await showNotice($, alert.words, noticeBody(list))
}

/** A short sound (and, in voice mode, a few words) when Claude needs you, gets stuck or finishes a long job. */
const alertFor = async ($: $, list: GlanceChecklist) => {
  const alert = ALERTS[list.phase]
  const mode = await read($, soundAtom)
  if (!alert || mode === 'off' || !(await read($, enabledAtom))) return
  // A quick answer needs no sound, and a job whose helpers still run is not finished yet.
  if (list.phase === 'done' && (isBusy(list) || (list.finishedAt ?? (await now($))) - list.startedAt < LONG_JOB_MS)) return
  try {
    await playSound($, alert.asset)
    if (mode === 'voice') await sayWords($, alert.words)
  } catch {
    // No player or voice on this computer: the band still shows it.
  }
}

type SavedChecklists = Record<string, { at: number; list: GlanceChecklist }>

/** Keeps this chat's checklist, a second after it changes, for when the chat is resumed. */
const saveSoon = ($: $) => {
  if (saveTimer !== undefined) return
  saveTimer = $.clock.after(1000, () => {
    saveTimer = undefined
    void saveChecklist($).catch(() => undefined)
  })
}

const saveChecklist = async ($: $) => {
  const id = await $.session.id()
  const list = await read($, checklistAtom)
  const saved = ((await $.store.get(RESUME_KEY)) ?? {}) as SavedChecklists
  const others = Object.entries(saved)
    .filter(([key]) => key !== id)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, RESUME_KEEP - 1)
  await $.store.set(RESUME_KEY, Object.fromEntries(list === null ? others : [[id, { at: await now($), list }], ...others]))
}

/** A resumed chat gets its checklist back; work that was under way shows as paused, with Continue. */
const restoreChecklist = async ($: $) => {
  const id = await $.session.id().catch(() => null)
  const saved = id === null ? undefined : (((await $.store.get(RESUME_KEY)) ?? {}) as SavedChecklists)[id]
  if (saved === undefined || isFinished(saved.list)) return
  const list = saved.list
  // Still true after a restart: a plan waiting for Start, or Claude waiting for a reply. Anything else was cut off.
  const holds = list.phase === 'stopped' || (list.phase === 'needsYou' && (list.needsYouReason === APPROVE || list.needsYouReason === WAITING))
  const restored: GlanceChecklist = {
    ...list,
    activity: null,
    isCollapsed: false,
    helpers: list.helpers.filter(one => one.status !== 'running'),
    ...(holds ? {} : { phase: 'stopped' as const, stopKind: 'pause' as const, needsYouReason: null, stuckReason: null, finishedAt: saved.at }),
  }
  await update($, checklistAtom, () => restored)
  syncTicker($, restored)
}

const change = async ($: $, fn: (list: GlanceChecklist) => GlanceChecklist | null) => {
  const at = await now($)
  const before: { phase: GlancePhase | null } = { phase: null }
  const next = await update($, checklistAtom, list => {
    before.phase = list?.phase ?? null
    const changed = list ? fn(list) : list
    return changed ? { ...changed, tasks: stampTimes(changed.tasks, at) } : changed
  })
  syncTicker($, next)
  saveSoon($)
  if (next !== null && next.phase !== before.phase) {
    void alertFor($, next)
    void noticeFor($, next)
  }

  return next
}

/** This project's pace from the History of the last 30 days; null when it isn't known yet. */
const learnPace = async ($: $): Promise<number | null> => {
  try {
    const project = await $.session.cwd()
    const entries: GlanceHistoryEntry[] = []
    for (const key of await $.store.keys()) {
      const day = key.startsWith(HISTORY_PREFIX) ? await $.store.get(key) : null
      if (Array.isArray(day)) entries.push(...(day as GlanceHistoryEntry[]))
    }

    return paceFromHistory(entries, project)
  } catch {
    return null
  }
}

const startJob = async ($: $, text: string, jobId: string) => {
  const previous = await read($, checklistAtom)
  const list: GlanceChecklist = {
    // Until Haiku names it in English, a request in another language shows a neutral title.
    title: isLatinText(text.split('\n')[0] ?? '') ? cleanName(text.split('\n')[0]) : 'Working on your request',
    phase: 'working',
    tasks: stampTimes([task('Understand your request', 'active'), task('Plan the steps', 'upcoming')], await now($)),
    needsYouReason: null,
    stuckReason: null,
    startedAt: await now($),
    finishedAt: null,
    isCollapsed: false,
    hasPlan: false,
    jobId,
    planAt: null,
    plannedCount: 0,
    extraTokens: 0,
    extraCachedTokens: 0,
    stopKind: null,
    activity: null,
    approval: 'none',
    costAtStart: (await read($, usageAtom)).costUsd,
    paceMs: await learnPace($),
    // Work still running from the last job stays in view.
    helpers: (previous?.helpers ?? []).filter(one => one.status === 'running'),
  }
  failuresInARow = 0
  collapse?.cancel()
  await update($, checklistAtom, () => list)
  syncTicker($, list)
  saveSoon($)
  // Name the job in the background; a newer job wins.
  $.clock.after(0, () => void nameJob($, text, jobId))
}

const nameJob = async ($: $, text: string, jobId: string) => {
  try {
    const answer = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      timeoutMs: 15000,
      prompt:
        'Name this request in 2 to 6 plain English words that start with a verb, ' +
        'like "Build my landing page", in sentence case: only the first word and names get a capital. ' +
        'Always in English, even when the request is in another language. ' +
        'No file names, code, quotes or punctuation. ' +
        `Reply with the name only.\n\nRequest:\n${text.slice(0, 2000)}`,
    })
    if (!answer.isAnswered) {
      return
    }
    const title = sentenceCase(cleanName((answer.text.split('\n')[0] ?? '').replace(/["'.]/g, '')))
    await change($, list => (list.jobId === jobId ? { ...list, title } : list))
  } catch {
    // The placeholder title stays.
  }
}

// A plan waiting for Start stays on Needs you while Claude finishes laying it out.
const setWorking = ($: $) =>
  change($, list =>
    list.approval !== 'waiting' && (list.phase === 'needsYou' || list.phase === 'stuck')
      ? { ...list, phase: 'working', needsYouReason: null, question: null, stuckReason: null }
      : list,
  )

/** A job that ended: All done, or finished with a question for the person (Needs you, with a finish time). */
const isFinished = (list: GlanceChecklist) => list.phase === 'done' || (list.phase === 'needsYou' && list.finishedAt !== null)

/** Why the person is needed: what Claude asked, when it ended on a question, else the general reason. */
const needsText = (list: GlanceChecklist) =>
  (list.question && (list.needsYouReason === WAITING || list.needsYouReason === QUESTION) ? list.question : list.needsYouReason) ?? null

const setNeedsYou = ($: $, reason: string) =>
  change($, list =>
    list.phase === 'done' || list.phase === 'stopped' ? list : { ...list, phase: 'needsYou', needsYouReason: reason, question: null },
  )

/** Claude wrote or edited a file: the current step keeps it, created or changed, once. */
const noteFile = async ($: $, path: string, isNew: boolean) => {
  const file: GlanceFile = { path: projectPath(path, await $.session.cwd().catch(() => '')), isNew }
  await change($, list => {
    const stepId = currentStepId(list)
    return {
      ...list,
      tasks: list.tasks.map(one =>
        one.id !== stepId || (one.files ?? []).some(known => known.path === file.path) ? one : { ...one, files: [...(one.files ?? []), file] },
      ),
    }
  })
}

const setStuck = ($: $, reason: string) =>
  change($, list => ({ ...list, phase: 'stuck', stuckReason: reason, needsYouReason: null }))

/** Stops Claude's running turn; Continue picks it up again. */
const pauseJob = async ($: $) => {
  if (runningTurn === undefined) {
    $.ui.toast('Nothing is running right now.')
    return
  }
  isPausing = true
  try {
    await $.turn.abort({ turnId: runningTurn })
    $.ui.toast('Paused. Press Continue to pick up where Claude stopped.')
  } catch {
    isPausing = false
    $.ui.toast("Couldn't pause right now. Press Esc to stop instead.")
  }
}

/** Sends "continue" for the person: the same job goes on, nothing to type. */
const continueJob = async ($: $) => {
  try {
    await $.prompt.submit({ text: CONTINUE_TEXT, asUser: true })
  } catch {
    $.ui.toast("Couldn't continue right now. Type: continue")
  }
}

/** Loads one day of this project's history into the pane, and opens the pane when asked. */
const showHistory = async ($: $, day: string, isOpening: boolean) => {
  const project = await $.session.cwd()
  const stored = await $.store.get(`${HISTORY_PREFIX}${day}`)
  // Entries saved before the report fields existed get empty ones.
  const entries = (Array.isArray(stored) ? (stored as GlanceHistoryEntry[]) : [])
    .filter(one => one.project === project)
    .map(one => ({ ...one, doneSteps: one.doneSteps ?? [], openSteps: one.openSteps ?? [], isQuickAnswer: one.isQuickAnswer ?? false }))
  const today = dayKey(await now($))
  const saved = (await $.store.keys())
    .filter(key => key.startsWith(HISTORY_PREFIX))
    .map(key => key.slice(HISTORY_PREFIX.length))
  const days = [...new Set([today, day, ...saved])].sort().reverse()
  const myWeek: GlanceHistoryEntry[] = []
  for (let back = WEEK_DAYS - 1; back >= 0; back--) {
    const one = back === 0 ? stored : await $.store.get(`${HISTORY_PREFIX}${shiftDay(day, -back)}`)
    if (Array.isArray(one)) myWeek.push(...(one as GlanceHistoryEntry[]))
  }
  const filled = (one: GlanceHistoryEntry) => ({ ...one, doneSteps: one.doneSteps ?? [], openSteps: one.openSteps ?? [], isQuickAnswer: one.isQuickAnswer ?? false })
  await update($, historyAtom, view => ({
    day,
    project,
    entries,
    days,
    isReportShown: false,
    reportSpan: view?.reportSpan === 'week' ? 'week' : 'day',
    weekEntries: myWeek.filter(one => one.project === project).map(filled),
    myWeekEntries: myWeek.map(filled),
  }))

  return isOpening ? $.ui.open({ id: HISTORY_PANE, title: `History · ${projectName(project)}`, closeOnEscape: true }) : null
}

/** Opens the whole plan in a side panel: every step, what each got done, its time and helpers. */
const showPlan = ($: $) => $.ui.open({ id: PLAN_PANE, title: 'Plan', closeOnEscape: true })

/** Where we left off: the checkpoint Claude saved before the chat was tidied up, in a side panel. */
const showRecap = async ($: $) => {
  await update($, recapAtom, () => false)
  return $.ui.open({ id: RECAP_PANE, title: 'Where we left off', closeOnEscape: true })
}

/** Shows the team report for the day or the week, or your own week across projects, and copies it. */
const showReportSpan = async ($: $, span: GlanceHistoryView['reportSpan'], surface?: RenderSurface) => {
  await update($, historyAtom, view => (view ? { ...view, reportSpan: span } : view))
  const view = await read($, historyAtom)
  if (view !== null) await showReport($, true, reportOf(view), surface)
}

const reportOf = (view: GlanceHistoryView) =>
  view.reportSpan === 'mine'
    ? weekSummary(view.myWeekEntries, view.day)
    : view.reportSpan === 'week'
      ? teamReport({ ...view, entries: view.weekEntries }, 'week')
      : teamReport(view)

const showReport = async ($: $, isShown: boolean, text: string, surface?: RenderSurface) => {
  await update($, historyAtom, view => (view ? { ...view, isReportShown: isShown } : view))
  if (!isShown) return
  const copied = await $.ui.copy({ text, surface })
  const isMine = (await read($, historyAtom))?.reportSpan === 'mine'
  $.ui.toast(
    !copied.isCopied
      ? 'The report is in the panel: select it there to copy it.'
      : isMine
        ? 'Your week copied: paste it wherever you like.'
        : 'Team report copied: paste it into Slack, Teams or an email.',
  )
}

/** First press arms the Fresh chat button; a second press within 8 seconds starts the handoff. */
const pressHandoff = async ($: $) => {
  const state = await read($, handoffAtom)
  if (state === 'working') return
  if (state === 'idle') {
    await update($, handoffAtom, () => 'armed')
    $.clock.after(HANDOFF_CONFIRM_MS, () => {
      void update($, handoffAtom, current => (current === 'armed' ? 'idle' : current))
    })
    return
  }
  await startFreshChat($)
}

/** Writes a handoff note over this chat, clears it, and sends the note as the fresh chat's first message. */
const startFreshChat = async ($: $) => {
  await update($, handoffAtom, () => 'working')
  try {
    $.ui.toast('Writing a handoff note for the fresh chat…')
    const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
    if (!reply.isAnswered || !reply.text.trim()) {
      $.ui.toast(`Couldn't write the handoff note${reply.isAnswered ? '' : ` (${reply.reason})`}. Nothing was cleared.`)
      return
    }
    const note = reply.text.trim()
    // Kept in case anything below fails: /glanceflow handoff note puts it back in the prompt box.
    await $.store.set(HANDOFF_KEY, { at: await now($), note })
    try {
      await $.command.run({ command: 'clear', args: '' })
    } catch {
      $.ui.toast("Couldn't clear the chat. Type /glanceflow handoff note to get the handoff note.")
      return
    }
    try {
      await $.prompt.submit({ text: note, asUser: true })
      $.ui.toast('Fresh chat started from a handoff note.')
    } catch {
      await $.prompt.fill({ text: note })
      $.ui.toast('Chat cleared. The handoff note is in the prompt box: press Enter to send it.')
    }
  } finally {
    await update($, handoffAtom, () => 'idle')
  }
}

/** Saves the job to the day's history (this computer only) and refreshes an open history pane. */
const recordJob = async ($: $) => {
  try {
    const list = await read($, checklistAtom)
    if (list === null) return
    const project = await $.session.cwd()
    const day = dayKey(list.startedAt)
    const entries = upsertEntry(await $.store.get(`${HISTORY_PREFIX}${day}`), entryFromChecklist(list, project, jobCost(list, await read($, usageAtom))))
    await $.store.set(`${HISTORY_PREFIX}${day}`, entries)
    const view = await read($, historyAtom)
    if (view !== null && view.day === day && view.project === project) {
      await update($, historyAtom, () => ({ ...view, entries: entries.filter(one => one.project === project) }))
    }
  } catch {
    // The history is a convenience: a failed save never gets in the way of the work.
  }
}

/** Once Claude has answered: done, or still working in the background while helpers run. */
const settleFinished = async ($: $, at: number, isNewAnswer: boolean) => {
  let changed = isNewAnswer
  const list = await change($, current => {
    if (current.phase !== 'done' && current.phase !== 'background') return current
    const phase = isBusy(current) ? ('background' as const) : ('done' as const)
    if (phase === current.phase && !isNewAnswer) return current
    changed = true
    return { ...current, phase, finishedAt: phase === 'done' ? at : null, isCollapsed: false }
  })
  if (!changed || list === null) return
  await recordJob($)
  collapse?.cancel()
  if (list.phase === 'done') {
    const jobId = list.jobId
    collapse = $.clock.after(COLLAPSE_MS, () => {
      void change($, current =>
        current.jobId === jobId && current.phase === 'done' ? { ...current, isCollapsed: true } : current,
      )
    })
  }
}

const addHelper = ($: $, helper: Omit<GlanceHelper, 'stepId'>) =>
  change($, current => ({
    ...current,
    helpers: [...current.helpers.filter(one => one.id !== helper.id), { ...helper, stepId: currentStepId(current) }],
  }))

const noteHelperStep = async ($: $, agentId: string, model: string, effort: unknown) => {
  const list = await read($, checklistAtom)
  const helper = list?.helpers.find(one => one.id === agentId)
  const named = prettyModel(model)
  const level = effort === undefined || effort === null ? null : String(effort)
  if (!helper || (helper.model === named && helper.effort === level)) return
  await change($, current => ({
    ...current,
    helpers: current.helpers.map(one => (one.id === agentId ? { ...one, model: named, effort: level } : one)),
  }))
}

type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** One model request's tokens: to the step it worked for, and to the helper that made it. */
const addTokens = ($: $, agentId: string | undefined, usage: StepUsage) => {
  const total =
    usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  if (total <= 0) return Promise.resolve(null)

  const cached = usage.cache_read_input_tokens

  return change($, current => {
    const helper = agentId === undefined ? undefined : current.helpers.find(one => one.id === agentId)
    const stepId =
      helper && current.tasks.some(one => one.id === helper.stepId)
        ? helper.stepId
        : current.tasks.find(one => one.status === 'active')?.id
    // No step is running (Claude writing its final answer): the job's total only.
    if (stepId === undefined && !helper) {
      return {
        ...current,
        extraTokens: current.extraTokens + total,
        extraCachedTokens: current.extraCachedTokens + cached,
      }
    }
    return {
      ...current,
      tasks: current.tasks.map(one =>
        one.id === stepId
          ? { ...one, tokens: one.tokens + total, cachedTokens: one.cachedTokens + usage.cache_read_input_tokens }
          : one,
      ),
      helpers: helper
        ? current.helpers.map(one => (one.id === helper.id ? { ...one, tokens: one.tokens + total } : one))
        : current.helpers,
    }
  })
}

const finishHelper = async ($: $, agentId: string, status: 'done' | 'failed') => {
  const list = await change($, current => ({
    ...current,
    helpers: current.helpers.map(one => (one.id === agentId && one.status === 'running' ? { ...one, status } : one)),
  }))
  if (list?.phase === 'background') await settleFinished($, await now($), false)
}

/**
 * Tidies the chat up without forgetting: Claude first writes a checkpoint of the work, the compaction is told to keep
 * it, and it stays in Claude's instructions for the rest of this chat. Uses /compact itself when the engine refuses.
 */
const tidyUp = async ($: $) => {
  $.ui.toast('Saving a checkpoint, then tidying up the chat…')
  let note: string | null = null
  try {
    const reply = await $.model.fork({ prompt: CHECKPOINT_PROMPT })
    if (reply.isAnswered && reply.text.trim()) note = reply.text.trim()
  } catch {
    // Tidying up still helps without a checkpoint.
  }
  if (note !== null) {
    const at = await now($)
    await $.store.set(CHECKPOINT_KEY, { sessionId: await $.session.id(), at, note })
    await update($, checkpointAtom, () => at)
  } else {
    $.ui.toast("Couldn't save a checkpoint; tidying up anyway.")
  }
  const instructions = note === null ? '' : `Keep everything in this checkpoint; it is what the work needs to carry on.\n\n${note}`
  try {
    const done = await $.session.compact(note === null ? undefined : { instructions })
    if (done.skip !== undefined) $.ui.toast(`The chat was not tidied up: ${done.skip}`)
    else if (note !== null) await update($, recapAtom, () => true)
    return
  } catch (refused) {
    $.ui.log(`glanceflow: compaction refused: ${refused instanceof Error ? refused.message : String(refused)}`, { to: 'debug' })
  }
  try {
    await $.command.run({ command: 'compact', args: instructions })
  } catch (failed) {
    const reason = failed instanceof Error ? failed.message : String(failed)
    $.ui.toast(`Couldn't tidy up the chat (${reason.slice(0, 80)}). Type /compact to try again.`)
  }
}

/** The checkpoint saved before this chat was last tidied up; null in another chat or when there is none. */
const checkpointOf = async ($: $): Promise<string | null> => {
  const saved = (await $.store.get(CHECKPOINT_KEY)) as { sessionId?: string; note?: string } | undefined
  return saved?.note && saved.sessionId === (await $.session.id()) ? saved.note : null
}

const setTidyAt = async ($: $, percent: number) => {
  await update($, tidyAtAtom, () => percent)
  await $.store.set(TIDY_KEY, percent)
}

const holdSecretMessage = async ($: $, text: string, kinds: string[]) => {
  heldMessage = { text, at: await now($) }
  // Put it back in the box so nothing is lost.
  $.clock.after(50, () => void $.prompt.fill({ text }).catch(() => undefined))
  $.ui.toast(
    `This message looks like it has ${kinds.join(' and ')} in it, so it was not sent. ` +
      'Press Enter again to send it anyway, or take it out first.',
  )
}

const measureUsage = async ($: $, usage: GlanceUsage) => {
  await update($, usageAtom, () => usage)
  const level = usage.limitPercent === null ? 0 : usage.limitPercent >= LIMIT_ALERT ? 2 : usage.limitPercent >= LIMIT_WARN ? 1 : 0
  if (level > limitLevel && usage.limitPercent !== null) {
    const reset = resetTime(usage.limitResetsAt, await now($))
    const words = `You've used ${Math.round(usage.limitPercent)}% of your ${usage.limitLabel ?? ''} limit`.replace('  ', ' ')
    $.ui.toast(reset === null ? words : `${words}. It resets ${reset}.`)
    if ((await read($, noticeAtom)) && (await read($, enabledAtom))) {
      await showNotice($, 'Plan limit', reset === null ? words : `${words}. It resets ${reset}.`)
    }
  }
  limitLevel = level
}

const setEnabled = async ($: $, isEnabled: boolean) => {
  await update($, enabledAtom, () => isEnabled)
  await $.store.set(STORE_KEY, isEnabled)
  $.ui.toast(isEnabled ? 'GlanceFlow is on: tool details are hidden' : 'GlanceFlow is off: showing everything')
}

/** The one button: Simple → Details → Off → Simple. */
/** Sounds: off, a chime, or a chime and a few words. A chime plays at once so the person hears what they picked. */
const setSound = async ($: $, mode: 'off' | 'chime' | 'voice') => {
  await update($, soundAtom, () => mode)
  await $.store.set(SOUND_KEY, mode)
  if (mode !== 'off') void playSound($, 'sounds/needs-you.wav').catch(() => undefined)
}

/** Calm mode: nothing moves, statuses in bold; the band redraws only to keep times current. */
const setCalm = async ($: $, isOn: boolean) => {
  isCalmMode = isOn
  await update($, calmAtom, () => isOn)
  await $.store.set(CALM_KEY, isOn)
  syncTicker($, await read($, checklistAtom))
}

/** Moves the welcome on a card, or ends it for good. */
const stepTour = async ($: $, step: number | null) => {
  await update($, tourAtom, () => (step === null || step >= TOUR.length ? null : step))
  if (step === null || step >= TOUR.length) await $.store.set(TOUR_KEY, true)
}

/** Desktop notices: on shows one when Claude needs you, gets stuck or finishes a long job. A sample shows at once. */
const setNotice = async ($: $, isOn: boolean) => {
  await update($, noticeAtom, () => isOn)
  await $.store.set(NOTICE_KEY, isOn)
  if (isOn) void showNotice($, 'Claude needs you', 'This is how GlanceFlow will tell you.')
}

/** The password guard: on holds back a message that looks like it has a password or key in it. */
const setGuard = async ($: $, isOn: boolean) => {
  await update($, guardAtom, () => isOn)
  await $.store.set(GUARD_KEY, isOn)
}

/** Approve the plan first: Claude lays out its plan, then waits for Start or a change. */
const setApprove = async ($: $, isOn: boolean) => {
  await update($, approveAtom, () => isOn)
  await $.store.set(APPROVE_KEY, isOn)
}

/** With Approve the plan first on, a new plan waits for Start or a change; true when it now waits. */
const holdForApproval = async ($: $): Promise<boolean> => {
  if (!(await read($, approveAtom)) || (await read($, checklistAtom))?.approval === 'approved') {
    return false
  }
  await change($, list => ({ ...list, approval: 'waiting', phase: 'needsYou', needsYouReason: APPROVE }))

  return true
}

/** The person approves the plan: the same job starts. */
const startPlan = async ($: $) => {
  try {
    await $.prompt.submit({ text: START_TEXT, asUser: true })
  } catch {
    $.ui.toast("Couldn't start right now. Type: start")
  }
}

/** Picks Simple, Details or Off directly, as the settings panel does. */
const setView = async ($: $, view: 'simple' | 'detailed' | 'off') => {
  await update($, enabledAtom, () => view !== 'off')
  await $.store.set(STORE_KEY, view !== 'off')
  if (view !== 'off') {
    await update($, detailAtom, () => view)
    await $.store.set(DETAIL_KEY, view)
  }
}

/** Plays what the person picked, so they know what they will hear. */
const alertSample = async ($: $, mode: 'off' | 'chime' | 'voice') => {
  if (mode === 'off') return
  await playSound($, 'sounds/needs-you.wav').catch(() => undefined)
  if (mode === 'voice') await sayWords($, 'Claude needs you').catch(() => undefined)
}

/** Back to how GlanceFlow starts: Simple, no sounds or notices, calm off, password guard on, no plan approval, tidy up at 50%. */
const resetSettings = async ($: $) => {
  await setView($, 'simple')
  await setSound($, 'off')
  await setNotice($, false)
  await setCalm($, false)
  await setGuard($, true)
  await setApprove($, false)
  await setTidyAt($, TIDY_AT_DEFAULT)
  $.ui.toast('Settings are back to their defaults.')
}

const showSettings = ($: $) => $.ui.open({ id: SETTINGS_PANE, title: 'GlanceFlow settings', closeOnEscape: true })

const cycleMode = async ($: $, isEnabled: boolean, isDetailed: boolean) => {
  const nextEnabled = !(isEnabled && isDetailed)
  const nextDetailed = isEnabled && !isDetailed
  await update($, enabledAtom, () => nextEnabled)
  await update($, detailAtom, () => (nextDetailed ? 'detailed' : 'simple'))
  await $.store.set(STORE_KEY, nextEnabled)
  await $.store.set(DETAIL_KEY, nextDetailed ? 'detailed' : 'simple')
  $.ui.toast(
    !nextEnabled
      ? 'GlanceFlow is off: showing everything'
      : nextDetailed
        ? 'GlanceFlow details: models, time, tokens, cache and plan usage'
        : 'GlanceFlow simple: just the steps and progress',
  )
}

const setDetail = async ($: $, isDetailed: boolean) => {
  await update($, detailAtom, () => (isDetailed ? 'detailed' : 'simple'))
  await $.store.set(DETAIL_KEY, isDetailed ? 'detailed' : 'simple')
  $.ui.toast(
    isDetailed ? 'Details on: models, tokens, cache and plan usage' : 'Details off: just the steps and progress',
  )
}

// GlanceFlow was called Glance until 0.9: once, bring over Glance's settings and history from its own store file.
const ADOPTED_KEY = 'adoptedGlance'
const adoptGlanceStore = async ($: $) => {
  if (await $.store.get(ADOPTED_KEY)) {
    return
  }
  await $.store.set(ADOPTED_KEY, true)
  try {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
    const dir = `${config}/plugins/store`
    const settings = new Set([STORE_KEY, DETAIL_KEY, SOUND_KEY, CALM_KEY, GUARD_KEY, APPROVE_KEY, NOTICE_KEY])
    const mine = new Set(await $.store.keys())
    for (const file of await $.fs.list(dir)) {
      if (!/^glance_.*\.json$/.test(file.name)) {
        continue
      }
      const old = JSON.parse(await $.fs.read(`${dir}/${file.name}`)) as Record<string, unknown>
      for (const [key, value] of Object.entries(old)) {
        if (key.startsWith(HISTORY_PREFIX) && Array.isArray(value)) {
          let entries = await $.store.get(key)
          // Only Glance's own jobs: another mod may be called glance too.
          for (const entry of value as GlanceHistoryEntry[]) {
            if (typeof entry?.jobId === 'string' && Array.isArray(entry.doneSteps)) {
              entries = upsertEntry(entries, entry)
            }
          }
          await $.store.set(key, entries ?? [])
        } else if (settings.has(key) && !mine.has(key)) {
          await $.store.set(key, value)
        }
      }
    }
  } catch {
    // Nothing to bring over.
  }
}

/** Icon size in the band and the panels, in CSS px: a touch smaller than the desktop's 14.5px text. */
const ICON = 15
/** The desktop's line of text, in CSS px: marks are drawn this tall, centered, so they line up with a first line. */
const LINE = 21

/**
 * The marks every screen draws, from one icon set (look.ts): SVG where the surface draws vectors (the desktop app,
 * VS Code, the phone), one-cell glyphs on the terminal, so a status reads the same everywhere.
 */
function kitOf(table: ElementTable, surface: RenderSurface) {
  const { Text } = table
  // The terminal's table answers for Svg too, and draws it as an empty box: go by the surface.
  const Svg = surface !== 'terminal' && 'Svg' in table ? table.Svg : null
  // Every drawing says what it is: the desktop app draws nothing for an Svg whose alt is empty.
  const draw = (source: string, alt: string, width: number, height = width): RenderElement | null =>
    Svg ? <Svg source={source} alt={alt} width={width} height={height} /> : null
  const glyph = (name: IconName, tone: Tone) => (
    <Text color={TONE_TEXT[tone]} dimColor={tone === 'quiet'}>
      {GLYPH[name]}
    </Text>
  )

  return {
    isVector: Svg !== null,
    /** A line icon. */
    icon: (name: IconName, tone: Tone, alt: string, size = ICON) => draw(iconSvg(name, tone, size, LINE), alt, size, LINE) ?? glyph(name, tone),
    /** A filled disc with the icon in white: done, failed, waiting on you, stopped. */
    badge: (name: IconName, tone: Tone, alt: string, size = ICON) =>
      draw(badgeSvg(name, tone, size, LINE), alt, size, LINE) ?? glyph(name, tone),
    /** The current step: a ring filled to `percent`, or turning with `turn` while there is none. */
    ring: (percent: number | null, turn: number, alt: string, size = ICON, tone: Tone = 'active') =>
      draw(ringSvg(tone, size, percent, turn, LINE), alt, size, LINE) ?? glyph('play', tone),
    /** A step still to come. */
    open: (alt: string, size = ICON) => draw(openRingSvg(size, LINE), alt, size, LINE) ?? <Text dimColor>○</Text>,
    /** Room the size of an icon, so a line under a step starts where the step's name does. */
    blank: (alt: string, size = ICON) => draw(blankSvg(size, LINE), alt, size, LINE) ?? <Text> </Text>,
    /** A slim bar; vector surfaces only. */
    meter: (tone: Tone, percent: number | null, sweep: number, alt: string, width = 96) => draw(meterSvg(tone, width, percent, sweep), alt, width, 6),
    /** Where the welcome cards are; vector surfaces only. */
    dots: (count: number, current: number) => draw(dotsSvg(count, current), `Card ${current + 1} of ${count}`, count * 11 + 3, 6),
  }
}

export function registerGlance(on: On): void {
  on('session.start', async ($, e, next) => {
    void findPlatform($)
      .then(found => {
        platform = found
      })
      .catch(() => undefined)
    await adoptGlanceStore($)
    // The welcome shows once, to someone new: anyone with settings or history already knows their way.
    const keys = await $.store.keys()
    if (!keys.includes(TOUR_KEY)) {
      if (keys.every(key => key === ADOPTED_KEY)) await update($, tourAtom, () => 0)
      else await $.store.set(TOUR_KEY, true)
    }
    const stored = await $.store.get(STORE_KEY)
    await update($, enabledAtom, () => stored !== false)
    const detail = await $.store.get(DETAIL_KEY)
    await update($, detailAtom, () => (detail === 'detailed' ? 'detailed' : 'simple'))
    const sound = await $.store.get(SOUND_KEY)
    await update($, soundAtom, () => (sound === 'chime' || sound === 'voice' ? sound : 'off'))
    isCalmMode = (await $.store.get(CALM_KEY)) === true
    const isGuarded = (await $.store.get(GUARD_KEY)) !== false
    await update($, guardAtom, () => isGuarded)
    const approves = (await $.store.get(APPROVE_KEY)) === true
    await update($, approveAtom, () => approves)
    const isNoticing = (await $.store.get(NOTICE_KEY)) === true
    await update($, noticeAtom, () => isNoticing)
    const tidyAt = await $.store.get(TIDY_KEY)
    await update($, tidyAtAtom, () => (typeof tidyAt === 'number' ? tidyAt : TIDY_AT_DEFAULT))
    const saved = (await $.store.get(CHECKPOINT_KEY)) as { sessionId?: string; at?: number } | undefined
    const thisSession = await $.session.id().catch(() => null)
    await update($, checkpointAtom, () => (saved?.sessionId === thisSession && typeof saved?.at === 'number' ? saved.at : null))
    await update($, calmAtom, () => isCalmMode)
    // A resumed chat: its checklist comes back. A reload keeps the one it has.
    if ((await read($, checklistAtom)) === null) {
      await restoreChecklist($)
    }
    // The history keeps 30 days.
    for (const key of expiredHistoryKeys(await $.store.keys(), await now($))) {
      await $.store.delete(key)
    }
    await $.tool.register({
      name: 'plan_steps',
      description:
        'Lay out every step of the job up front, 2 to 8 short plain-English names in order. ' +
        'Call this before using any other tool; a quick answer that needs no tools needs no plan. ' +
        'The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
          sizes: {
            type: 'array',
            items: { type: 'string', enum: ['S', 'M', 'L'] },
            description: 'One size per step, in order: S small, M medium, L large.',
          },
        },
        required: ['steps'],
      },
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        'Report progress on the current step by its plain-English name. Send percent 100 the moment a step ' +
        'finishes; the next step then starts. A name not in the plan becomes a new step.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          percent: { type: 'number', minimum: 0, maximum: 100 },
          summary: {
            type: 'string',
            description:
              'With percent 100: one short plain-English sentence on what the step got done, for the person and their team. No file names or code.',
          },
        },
        required: ['task', 'percent'],
      },
    })
    await $.command.register({
      name: 'glanceflow',
      description:
        'GlanceFlow: /glanceflow on|off, details on|off, sound on|voice|off, notify on|off, calm on|off, guard on|off, approve on|off, week, tour, pause, continue, plan, checkpoint, settings, tidy [at N|off], history [yesterday|YYYY-MM-DD], handoff',
    })
    // A reload drops the module's timers; pick the animation back up.
    syncTicker($, await read($, checklistAtom))

    return next(e)
  })

  on('command.run', { command: ['glanceflow'] }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg.startsWith('sound')) {
      const choice = arg.slice('sound'.length).trim()
      const current = await read($, soundAtom)
      const mode = choice === 'voice' ? 'voice' : choice === 'off' ? 'off' : choice === 'on' || current === 'off' ? 'chime' : 'off'
      await setSound($, mode)
      return {
        text:
          mode === 'off'
            ? 'Sounds are off.'
            : mode === 'voice'
              ? 'Sounds and voice are on: you will hear when Claude needs you, gets stuck or finishes a long job.'
              : 'Sounds are on: a chime when Claude needs you, gets stuck or finishes a long job.',
      }
    }
    if (arg.startsWith('calm')) {
      const choice = arg.slice('calm'.length).trim()
      await setCalm($, choice === 'on' ? true : choice === 'off' ? false : !(await read($, calmAtom)))
      return { text: isCalmMode ? 'Calm mode is on: nothing moves, statuses are bold.' : 'Calm mode is off.' }
    }
    if (arg.startsWith('guard')) {
      const choice = arg.slice('guard'.length).trim()
      const isOn = choice === 'on' ? true : choice === 'off' ? false : !(await read($, guardAtom))
      await setGuard($, isOn)
      return {
        text: isOn
          ? 'The password guard is on: a message that looks like it has a password or key in it is held back.'
          : 'The password guard is off: every message is sent as you write it.',
      }
    }
    if (arg === 'tour') {
      await update($, enabledAtom, () => true)
      await update($, tourAtom, () => 0)
      return { text: 'The welcome shows above the prompt: press Next to go through it.' }
    }
    if (arg.startsWith('notify')) {
      const choice = arg.slice('notify'.length).trim()
      const isOn = choice === 'on' ? true : choice === 'off' ? false : !(await read($, noticeAtom))
      await setNotice($, isOn)
      return {
        text: isOn
          ? 'Desktop notices are on: your computer tells you when Claude needs you, gets stuck or finishes a long job.'
          : 'Desktop notices are off.',
      }
    }
    if (arg.startsWith('approve')) {
      const choice = arg.slice('approve'.length).trim()
      const isOn = choice === 'on' ? true : choice === 'off' ? false : !(await read($, approveAtom))
      await setApprove($, isOn)
      return {
        text: isOn
          ? 'Claude now shows its plan and waits: press Start, or tell Claude what to change.'
          : 'Claude starts right after laying out its plan.',
      }
    }
    if (arg === 'week') {
      const opened = await showHistory($, dayKey(await now($)), true)
      const view = await read($, historyAtom)
      if (view === null) return { text: 'No history yet.' }
      await showReportSpan($, 'mine')
      const summary = weekSummary(view.myWeekEntries, view.day).split('\n')

      return { text: opened?.isPlaced ? summary[2] ?? summary[0]! : summary.join('\n') }
    }
    if (arg.startsWith('history')) {
      const day = dayFromArgument(arg.slice('history'.length), await now($))
      if (day === null) {
        return { text: 'Try /glanceflow history, /glanceflow history yesterday or /glanceflow history 2026-10-06.' }
      }
      const opened = await showHistory($, day, true)
      const entries = (await read($, historyAtom))?.entries ?? []
      const count = `${entries.length} ${entries.length === 1 ? 'task' : 'tasks'}`

      return {
        text: opened?.isPlaced
          ? `History for ${day}: ${count}.`
          : `History for ${day}: ${count}. Widen the window to see the panel.`,
      }
    }
    if (arg === 'pause') {
      await pauseJob($)
      return { text: 'Paused.' }
    }
    if (arg.startsWith('tidy')) {
      const choice = arg.slice('tidy'.length).trim().replace(/^at\s+/, '').replace('%', '')
      if (choice === '') {
        void tidyUp($)
        return { text: 'Saving a checkpoint, then tidying up the chat.' }
      }
      const percent = choice === 'off' ? 0 : Number(choice)
      if (!Number.isInteger(percent) || percent < 0 || percent > 95) {
        return { text: 'Try /glanceflow tidy, /glanceflow tidy at 50 or /glanceflow tidy off.' }
      }
      await setTidyAt($, percent)
      return { text: percent === 0 ? 'GlanceFlow will not offer to tidy up.' : `GlanceFlow offers to tidy up at ${percent}% full.` }
    }
    if (arg === 'settings') {
      await showSettings($)
      return { text: 'Settings are in the side panel.' }
    }
    if (arg === 'checkpoint') {
      if ((await checkpointOf($).catch(() => null)) === null) return { text: 'No checkpoint in this chat yet. Tidy it up saves one.' }
      await showRecap($)
      return { text: 'Where we left off is in the side panel.' }
    }
    if (arg === 'plan') {
      await showPlan($)
      return { text: 'The plan is in the side panel.' }
    }
    if (arg === 'continue') {
      void continueJob($)
      return { text: 'Continuing…' }
    }
    if (arg === 'handoff note') {
      const saved = (await $.store.get(HANDOFF_KEY)) as { note?: string } | undefined
      if (!saved?.note) return { text: 'No handoff note saved yet.' }
      await $.prompt.fill({ text: saved.note })
      return { text: 'The last handoff note is in the prompt box.' }
    }
    if (arg === 'handoff') {
      void startFreshChat($)
      return { text: 'Starting a fresh chat from a handoff note…' }
    }
    if (arg.startsWith('details')) {
      const choice = arg.slice('details'.length).trim()
      const isDetailed =
        choice === 'on' ? true : choice === 'off' ? false : (await read($, detailAtom)) !== 'detailed'
      await setDetail($, isDetailed)

      return { text: isDetailed ? 'GlanceFlow details are on.' : 'GlanceFlow details are off.' }
    }
    const isEnabled = arg === 'on' ? true : arg === 'off' ? false : !(await read($, enabledAtom))
    await setEnabled($, isEnabled)

    return { text: isEnabled ? 'GlanceFlow is on.' : 'GlanceFlow is off.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, enabledAtom))) {
      return composed
    }

    const checkpoint = await checkpointOf($).catch(() => null)

    return {
      sections: [
        ...composed.sections,
        { id: `${PLUGIN}:checklist`, text: PROMPT_SECTION, scope: 'session' as const },
        // Saved before the chat was tidied up: what the work needs to carry on.
        ...(checkpoint === null
          ? []
          : [{ id: `${PLUGIN}:checkpoint`, text: `# Checkpoint saved before this chat was tidied up\n${checkpoint}`, scope: 'session' as const }]),
      ],
    }
  })

  // Passwords and keys pasted into a message stay on this computer unless sent twice.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || !(await read($, guardAtom))) {
      return next(e)
    }
    const kinds = findSecrets(e.text)
    if (kinds.length === 0) {
      return next(e)
    }
    const held = heldMessage
    if (held !== null && held.text === e.text && (await now($)) - held.at < RESEND_WINDOW_MS) {
      heldMessage = null
      return next(e)
    }
    await holdSecretMessage($, e.text, kinds)

    return { drop: 'The message looked like it held a password or key, so GlanceFlow held it back.' }
  })

  on('session.measure', async ($, e, next) => {
    const top = [...e.rateLimits].sort((a, b) => b.percentUsed - a.percentUsed)[0]
    await measureUsage($, {
      limits: e.rateLimits.map(one => ({ label: LIMIT_LABEL[one.kind] ?? one.kind, percent: one.percentUsed })),
      limitPercent: top ? top.percentUsed : null,
      limitLabel: top ? (LIMIT_LABEL[top.kind] ?? top.kind) : null,
      limitResetsAt: top?.resetsAt ?? null,
      contextPercent: e.context.percent ?? null,
      costUsd: e.cost?.usd ?? null,
    })

    return next(e)
  })

  // Personal details and secrets stay off the screen; what Claude reads is unchanged.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const masked = (await read($, enabledAtom)) ? maskPrivate(e.props.text) : e.props.text

    return masked === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text: masked } })
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const masked = (await read($, enabledAtom)) ? maskPrivate(e.props.text) : e.props.text

    return masked === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text: masked } })
  })

  // The footer keeps progress in view even when the checklist is shrunk. Its words are plain text, so only the
  // terminal, whose glyphs are the band's own, gets a mark in front.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const list = (await read($, enabledAtom)) ? await read($, checklistAtom) : null
    const mark = (glyph: string) => (e.surface === 'terminal' ? `${glyph} ` : '')
    if (list !== null && list.phase === 'background') {
      const running = list.helpers.filter(one => one.status === 'running').length
      return next({ ...e, props: { ...e.props, modes: [`${mark('◷')}${running} in background`, ...e.props.modes] } })
    }
    if (list === null || !list.hasPlan || list.phase === 'done' || list.phase === 'stopped') {
      return next(e)
    }
    const at = await now($)
    const active = list.tasks.find(one => one.status === 'active')
    const activePercent = active ? stepEstimate(list, active, at).percent : undefined
    const left = timeLeft(list, at, activePercent)
    const label = `${mark('◎')}${overallProgress(list.tasks, activePercent).percent}%${left === null ? '' : ` · ~${formatLeft(left)}`}`

    return next({ ...e, props: { ...e.props, modes: [label, ...e.props.modes] } })
  })

  // Subagents: what they work on and which model, under the step that started them.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId !== undefined && e.parentAgentId === undefined) {
      await addHelper($, {
        id: started.agentId,
        kind: 'helper',
        label: cleanName(e.description, MAX_DETAIL),
        type: e.subagentType,
        model: prettyModel(started.model),
        effort: null,
        status: 'running',
        tokens: 0,
      })
    }

    return started
  })

  // Each model request of a subagent says its model and effort.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      await noteHelperStep($, e.agentId, e.model, e.effort)
    }
    const stream = next(e)
    for await (const chunk of stream) {
      noteSign($)
      yield chunk
    }
    const result = await stream.result
    if (result.usage) {
      await addTokens($, e.agentId, result.usage)
    }

    return result
  })

  // At the end of each turn the engine lists what still runs in the background.
  on('classic.Stop', async ($, e, next) => {
    const tasks = (e.background_tasks ?? []).filter(one => one.type !== 'subagent')
    await change($, current => {
      const listed = { ...current, helpers: reconcileBackground(current, tasks) }
      // Background work Claude waits for: it is still working, nothing for the person to do.
      return listed.phase === 'needsYou' && listed.needsYouReason === WAITING && isBusy(listed)
        ? { ...listed, phase: 'working', needsYouReason: null }
        : listed
    })
    await settleFinished($, await now($), false)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    runningTurn = e.turnId
    noteSign($)
    const text = ownWords(e.text)
    // The person moved on: the tidy-up note has done its job.
    if (text && (await read($, recapAtom))) {
      await update($, recapAtom, () => false)
    }
    const current = await read($, checklistAtom)
    if (current !== null && current.approval === 'waiting' && (text === START_TEXT || isStartWords(text))) {
      // Start, or "go ahead" typed: the plan is approved and the same job goes on.
      await change($, list => ({ ...list, approval: 'approved', phase: 'working', needsYouReason: null, isCollapsed: false }))
    } else if (current !== null && (text === CONTINUE_TEXT || (isContinueWords(text) && !isFinished(current)))) {
      // The Continue button, or "continue" typed: the same job picks up again.
      await change($, list => ({
        ...list,
        phase: 'working',
        stopKind: null,
        stuckReason: null,
        needsYouReason: null,
        finishedAt: null,
        isCollapsed: false,
      }))
    } else if (text && !text.startsWith('/')) {
      const list = current
      if (list === null || isFinished(list) || list.phase === 'stopped' || list.phase === 'background') {
        await startJob($, text, e.turnId)
      } else {
        await setWorking($)
      }
    } else if (!text && current !== null) {
      // Claude woke up on its own (a helper or background task finished): it is working again.
      await setWorking($)
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // The MCP tool table makes `e` a union too wide to narrow here; read the envelope plainly.
    const call = e as unknown as {
      tool: string
      tool_use_id: string
      todos?: ReadonlyArray<{ content: string; status: string }>
      subject?: string
      taskId?: string
      status?: string
    }
    const tool = String(call.tool)
    const isMain = e.agentId === undefined
    noteSign($)
    const fileField = FILE_TOOLS[tool]
    const filePath = fileField ? String((e as unknown as Record<string, unknown>)[fileField] ?? '') : ''
    // Only Write can create a file; asked before it runs.
    const isNewFile = filePath !== '' && tool === 'Write' && !(await $.fs.exists(filePath).catch(() => true))

    if (tool === PLAN_TOOL) {
      const input = e as unknown as { steps?: unknown; sizes?: unknown }
      const steps = (Array.isArray(input.steps) ? input.steps : []).map(one => cleanName(one)).slice(0, 8)
      const sizes = Array.isArray(input.sizes) ? input.sizes : []
      if (steps.length === 0) {
        return { deny: 'plan_steps needs 2 to 8 step names.' }
      }
      const tasks = settle(steps.map((name, index) => task(name, 'upcoming', `plan#${index}`, sizeOf(sizes[index]))))
      const started = await now($)
      const known = await read($, checklistAtom)
      const paceMs = known === null ? await learnPace($) : known.paceMs
      await update($, checklistAtom, (list): GlanceChecklist => ({
        paceMs: list?.paceMs ?? paceMs,
        planAt: list?.hasPlan ? (list.planAt ?? started) : started,
        plannedCount: list?.hasPlan ? list.plannedCount : steps.length,
        extraTokens: list?.extraTokens ?? 0,
        extraCachedTokens: list?.extraCachedTokens ?? 0,
        stopKind: null,
        activity: null,
        approval: list?.approval ?? 'none',
        costAtStart: list?.costAtStart ?? null,
        title: list?.title ?? 'Working on it',
        startedAt: list?.startedAt ?? started,
        jobId: list?.jobId ?? call.tool_use_id,
        finishedAt: null,
        isCollapsed: false,
        needsYouReason: null,
        stuckReason: null,
        phase: 'working',
        hasPlan: true,
        tasks: stampTimes(carryTokens(list?.tasks ?? [], tasks), started),
        helpers: list?.helpers ?? [],
      }))
      syncTicker($, await read($, checklistAtom))
      saveSoon($)
      if (await holdForApproval($)) {
        return {
          result:
            `Planned ${steps.length} steps. The person approves plans before work starts: stop now and wait for their reply. ` +
            'Do not use other tools yet. If they ask for changes, lay out the new plan with plan_steps.',
        }
      }

      return { result: `Planned ${steps.length} steps. The first one has started.` }
    }

    if (tool === PROGRESS_TOOL) {
      const input = e as unknown as { task?: unknown; percent?: unknown; summary?: unknown }
      const percent = Math.min(100, Math.max(0, Math.round(Number(input.percent) || 0)))
      const name = cleanName(String(input.task ?? ''))
      const summary = percent === 100 && String(input.summary ?? '').trim() ? cleanName(input.summary, MAX_SUMMARY) : null
      await change($, list => ({
        ...list,
        tasks: applyProgress(list.tasks, name, percent).map(one =>
          summary !== null && one.name.toLowerCase() === name.toLowerCase() ? { ...one, summary } : one,
        ),
        activity: percent === 100 ? null : list.activity,
      }))

      return { result: `Progress noted: ${percent}%.` }
    }

    if (!isMain) {
      const ran = await next(e)
      if (filePath !== '' && ran.deny === undefined && !ran.isError) {
        await noteFile($, filePath, isNewFile)
      }

      return ran
    }

    const isEnabled = await read($, enabledAtom)
    const list = await read($, checklistAtom)
    if (isEnabled && !ALWAYS_ALLOWED.has(tool) && !list?.hasPlan) {
      return {
        deny: `Call ${PLAN_TOOL} first to lay out the plan in plain English (load it with ToolSearch if it is deferred), then try again.`,
      }
    }

    if (isEnabled && list?.approval === 'waiting' && !ALWAYS_ALLOWED.has(tool)) {
      return { deny: 'The person has not approved the plan yet. Stop and wait for their reply.' }
    }

    if (tool === 'AskUserQuestion') {
      await setNeedsYou($, QUESTION)
    } else if (list?.phase === 'needsYou') {
      await setWorking($)
    }
    // What Claude is doing right now, in plain words, under the current step.
    const doing = activityOf(tool, e as unknown as { command?: unknown })
    if (doing !== null && list !== null) {
      const input = e as unknown as { description?: unknown; command?: unknown; file_path?: unknown; notebook_path?: unknown; url?: unknown }
      // Claude's own one-line description of the call, when it gave one: a fuller sentence than the label.
      const detail = typeof input.description === 'string' && input.description.trim() ? cleanName(input.description, MAX_DETAIL) : null
      const target = activityTarget(input)
      await change($, current => ({
        ...current,
        activity: {
          label: doing,
          count: current.activity?.label === doing ? current.activity.count + 1 : 1,
          detail,
          target,
        },
      }))
    }

    const ran = await next(e)
    noteSign($)

    if (ran.deny !== undefined) {
      return ran
    }
    // The person said no at the permission dialog.
    if (ran.isError && /doesn't want to proceed|user (has )?(rejected|denied|declined)/i.test(String(ran.text ?? ''))) {
      failuresInARow = 0
      await setStuck($, DENIED)

      return ran
    }
    if (ran.isError) {
      failuresInARow += 1
      if (failuresInARow >= 3) {
        await setStuck($, FAILING)
      }

      return ran
    }

    failuresInARow = 0
    await setWorking($)
    if (filePath !== '') {
      await noteFile($, filePath, isNewFile)
    }

    if (tool === 'TodoWrite' && call.todos) {
      const todos = call.todos
      const planned = await now($)
      await change($, current => ({
        ...current,
        hasPlan: true,
        planAt: current.planAt ?? planned,
        plannedCount: current.hasPlan ? current.plannedCount : todos.length,
        tasks: todosToTasks(todos, current.tasks),
      }))
      await holdForApproval($)
    } else if (tool === 'TaskCreate') {
      const created = (ran.result as { task?: { id?: string } } | undefined)?.task
      const id = `task#${created?.id ?? call.tool_use_id}`
      const planned = await now($)
      await change($, current => {
        const newTask = task(cleanName(call.subject), 'upcoming', id)
        const tasks = current.hasPlan
          ? settle([...current.tasks, newTask])
          : carryTokens(current.tasks, settle([newTask]))
        // Tasks created before any is finished are the first plan, not growth.
        const isFirstPlan = !tasks.some(one => one.status === 'done')

        return {
          ...current,
          hasPlan: true,
          planAt: current.planAt ?? planned,
          plannedCount: isFirstPlan ? tasks.length : current.plannedCount,
          tasks,
        }
      })
      await holdForApproval($)
    } else if (tool === 'TaskUpdate') {
      const id = `task#${call.taskId}`
      const status = call.status
      await change($, current => ({
        ...current,
        tasks: settle(
          current.tasks.flatMap(one => {
            if (one.id !== id) {
              return [one]
            }
            if (status === 'deleted') {
              return []
            }
            const name = call.subject ? cleanName(call.subject) : one.name
            if (status === 'completed') {
              return [{ ...one, name, status: 'done' as const, percent: 100, hasReported: true }]
            }
            if (status === 'in_progress') {
              return [{ ...one, name, status: 'active' as const }]
            }
            return [{ ...one, name, status: status === 'pending' ? ('upcoming' as const) : one.status }]
          }),
        ),
      }))
    }

    return ran
  })

  on('classic.Notification', async ($, e, next) => {
    const kind = String(e.notification_type ?? '')
    if (/permission/i.test(kind)) {
      await setNeedsYou($, PERMISSION)
    } else if (/elicitation|question/i.test(kind)) {
      await setNeedsYou($, QUESTION)
    }

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    await setStuck($, apiErrorSentence(String(e.error), e.error_details ?? ''))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await finishHelper($, e.agentId, e.reason === 'answer' ? 'done' : 'failed')
      return next(e)
    }
    const finished = await now($)
    if (isStalled) {
      isStalled = false
      await setWorking($)
    }
    const list = await read($, checklistAtom)
    runningTurn = undefined
    const wasPaused = isPausing
    isPausing = false

    if (list !== null) {
      await change($, current => (current.activity === null ? current : { ...current, activity: null }))
      if (wasPaused) {
        await change($, current => ({
          ...current,
          phase: 'stopped',
          stopKind: 'pause',
          needsYouReason: null,
          finishedAt: finished,
        }))
      } else if (e.reason === 'error') {
        // StopFailure may already have named the cause; keep its sentence.
        if (list.phase !== 'stuck') {
          await setStuck($, apiErrorSentence('unknown'))
        }
      } else if (e.reason === 'refusal') {
        await setStuck($, "Claude couldn't help with that request")
      } else if (list.phase === 'stuck' && list.stuckReason === DENIED) {
        // Keep the explanation of why Claude paused.
      } else if (e.reason === 'aborted') {
        await change($, current => ({ ...current, phase: 'stopped', stopKind: 'esc', needsYouReason: null, finishedAt: finished }))
      } else if (list.hasPlan && hasUnfinishedWork(list.tasks)) {
        // A helper still running means Claude waits for it, not for the person.
        const asked = questionOf(e.answer ?? '')
        await change($, current =>
          isBusy(current)
            ? current
            : { ...current, phase: 'needsYou', needsYouReason: current.approval === 'waiting' ? APPROVE : WAITING, question: asked },
        )
      } else {
        await change($, current => ({
          ...current,
          // A quick answer needed no plan: one plain step instead of the placeholders.
          tasks: current.hasPlan ? current.tasks : carryTokens(current.tasks, [task('Answer your question', 'done')]),
        }))
        // A finished job whose last message asks something still waits for the person.
        const asked = questionOf(e.answer ?? '')
        const isAsking = asksQuestion(e.answer ?? '')
        await change($, current => ({
          ...current,
          phase: isAsking ? 'needsYou' : 'done',
          needsYouReason: isAsking ? QUESTION : null,
          question: asked,
          stuckReason: null,
          finishedAt: finished,
          tasks: current.tasks.map(one => ({ ...one, status: 'done' as const, percent: 100, hasReported: true })),
        }))
        // Helpers or background tasks still running keep the job open.
        await settleFinished($, finished, true)
      }
      await recordJob($)
    }

    return next(e)
  })

  // Simple hides the tool rows; Details keeps them, for people who want the code next to the checklist.
  on('ui.render', { component: ['ToolUse', 'ToolResult', 'ToolGroup'] }, async ($, e, next) => {
    if (!(await read($, enabledAtom)) || (await read($, detailAtom)) === 'detailed') {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) =>
    (await read($, enabledAtom)) && (await read($, detailAtom)) !== 'detailed'
      ? next({ ...e, props: { ...e.props, hint: '' } })
      : next(e),
  )

  // The day's history of this project, for a retro.
  // Every choice in one place. Each group shows what is picked on its right, and a line on what that choice does.
  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const kit = kitOf(table, e.surface)
    const vector = kit.isVector
    const isEnabled = await read($, enabledAtom)
    const view = !isEnabled ? 'off' : await read($, detailAtom)
    const sound = await read($, soundAtom)
    const isCalm = await read($, calmAtom)
    const isNoticing = await read($, noticeAtom)
    const isGuarded = await read($, guardAtom)
    const approves = await read($, approveAtom)
    const tidyAt = await read($, tidyAtAtom)
    const checkpointAt = await read($, checkpointAtom)
    const usage = await read($, usageAtom)
    const columns = Math.max(30, e.props.bodyColumns)
    const rule = '─'.repeat(Math.min(columns, 64))

    // A choice: elsewhere than the terminal the app's own menu, which says what is picked and lists the rest, so no
    // filled button can read as "press me". The terminal draws buttons and marks the picked one ●.
    const Select = vector && 'Select' in table ? table.Select : undefined
    const choice = <T extends string | number>(key: string, options: [T, string][], picked: T, onPick: (value: T) => Promise<void>) =>
      Select ? (
        <Box key={`${key}-choices`} flexDirection="row">
          <Select
            key={`${key}-menu`}
            value={String(picked)}
            options={options.map(([value, label]) => ({ value: String(value), label }))}
            onSelect={value => {
              const found = options.find(([option]) => String(option) === value)
              if (found) void onPick(found[0])
            }}
          />
        </Box>
      ) : (
      <Box key={`${key}-choices`} flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
        {options.map(([value, label]) => (
          <Button
            key={`${key}-${value}`}
            label={vector ? label : value === picked ? `● ${label}` : `○ ${label}`}
            variant={value === picked ? 'primary' : 'secondary'}
            onPress={() => onPick(value)}
          />
        ))}
      </Box>
    )
    // A group: its icon and title, the choice, a line on what the choice does. On the terminal the title row also
    // says what is picked, on its right.
    const group = (key: string, icon: IconName, title: string, picked: string, control: RenderChildren, help: string, extra?: RenderChildren) =>
      vector ? (
        // A settings row as the Mac draws one: the name on the left, its menu on the right, what it does below.
        <Box key={key} flexDirection="row" gap={1} marginTop={2} width={columns}>
          {kit.icon(icon, 'quiet', title)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={Select ? 0 : 1}>
            <Box flexDirection={Select ? 'row' : 'column'} alignItems={Select ? 'center' : undefined} justifyContent="space-between" columnGap={2} rowGap={1}>
              <Text bold>{title}</Text>
              {control}
            </Box>
            <Box marginTop={Select ? 1 : 0}>
              <Text dimColor wrap="wrap">
                {help}
              </Text>
            </Box>
            {extra}
          </Box>
        </Box>
      ) : (
        <Box key={key} flexDirection="column" marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between" width={Math.min(columns, 64)}>
            <Text bold>{title}</Text>
            <Text color="cyan">{picked}</Text>
          </Box>
          {control}
          <Text dimColor wrap="wrap">
            {help}
          </Text>
          {extra}
        </Box>
      )

    const viewHelp = {
      simple: 'The steps and progress in plain words, with tool details out of the way. For everyone.',
      detailed: 'Also time, models and tokens per step, with the code in view. For engineers.',
      off: 'Claude Code as usual: no checklist, every tool row shown. The password guard keeps its own setting.',
    }[view]
    const soundHelp = {
      off: 'No sounds. Turn them on to look away while Claude works.',
      chime: 'A short chime when Claude needs you, gets stuck, or finishes a job that took over a minute.',
      voice: 'The chime, and a few words like "Claude needs you".',
    }[sound]
    const chatFull = usage.contextPercent === null ? null : Math.round(usage.contextPercent)
    const tidyHelp =
      tidyAt === 0
        ? 'GlanceFlow never offers to tidy up. Claude Code still compacts on its own when the chat is full.'
        : `At ${tidyAt}% full, the checklist offers to tidy up. Claude first saves a checkpoint of the work (goal, what is done and left, decisions, the next step), so nothing important is lost when the chat is compacted.`

    return (
      <Box flexDirection="column" width={columns}>
        {vector ? (
          // The app titles the panel; the body starts with how changes behave.
          <Text dimColor wrap="wrap">
            Changes apply right away and stay for your next chats.
          </Text>
        ) : (
          <Box flexDirection="column">
            <Text bold>⚙ GlanceFlow settings</Text>
            <Text dimColor wrap="wrap">
              Changes apply right away and stay for your next chats.
            </Text>
            <Text dimColor>{rule}</Text>
          </Box>
        )}
        {group(
          'view',
          'eye',
          'View',
          view === 'simple' ? 'Simple' : view === 'detailed' ? 'Details' : 'Off',
          choice('view', [['simple', 'Simple'], ['detailed', 'Details'], ['off', 'Off']], view, value => setView($, value)),
          viewHelp,
        )}
        {group(
          'sound',
          'sound',
          'Sounds',
          sound === 'off' ? 'Off' : sound === 'chime' ? 'Chime' : 'Chime and voice',
          choice('sound', [['off', 'Off'], ['chime', 'Chime'], ['voice', 'Chime and voice']], sound, value => setSound($, value)),
          soundHelp,
          sound === 'off' ? undefined : (
            <Box key="sound-test" marginTop={vector ? 1 : 0}>
              <Button key="sound-test" label={vector ? 'Play it' : '▶ Play it'} onPress={() => alertSample($, sound)} />
            </Box>
          ),
        )}
        {group(
          'notice',
          'bell',
          'Desktop notices',
          isNoticing ? 'On' : 'Off',
          choice('notice', [['off', 'Off'], ['on', 'On']], isNoticing ? 'on' : 'off', value => setNotice($, value === 'on')),
          isNoticing
            ? 'A notice on your computer when Claude needs you, gets stuck, or finishes a job that took over a minute.'
            : 'Turn on to get a notice on your computer, even while you work in another app.',
        )}
        {group(
          'calm',
          'moon',
          'Calm mode',
          isCalm ? 'On' : 'Off',
          choice('calm', [['off', 'Off'], ['on', 'On']], isCalm ? 'on' : 'off', value => setCalm($, value === 'on')),
          isCalm ? 'Nothing on screen moves, and statuses read in bold.' : 'Bars and spinners move while Claude works. Turn on for a still screen.',
        )}
        {group(
          'approve',
          'approve',
          'Approve the plan first',
          approves ? 'On' : 'Off',
          choice('approve', [['off', 'Off'], ['on', 'On']], approves ? 'on' : 'off', value => setApprove($, value === 'on')),
          approves
            ? `Claude shows its plan and waits. Press ${vector ? 'Start' : '▶ Start'}, or tell Claude what to change.`
            : 'Claude starts right after laying out its plan.',
        )}
        {group(
          'guard',
          'lock',
          'Password guard',
          isGuarded ? 'On' : 'Off',
          choice('guard', [['off', 'Off'], ['on', 'On']], isGuarded ? 'on' : 'off', value => setGuard($, value === 'on')),
          isGuarded
            ? 'A message that looks like it has a password or key in it is held back. Press Enter again to send it anyway.'
            : 'Every message is sent as you write it. Keys and emails are still masked on screen.',
        )}
        {group(
          'tidy',
          'tidy',
          'Tidy up the chat',
          tidyAt === 0 ? 'Never' : `At ${tidyAt}% full`,
          choice(
            'tidy',
            TIDY_CHOICES.map(value => [value, value === 0 ? 'Never' : `${value}%`] as [number, string]),
            tidyAt,
            value => setTidyAt($, value),
          ),
          tidyHelp,
          <Box key="tidy-now" flexDirection="column" gap={vector ? 1 : 0} marginTop={vector ? 1 : 0}>
            {(chatFull !== null || checkpointAt !== null) && (
              <Text dimColor wrap="wrap">
                {[
                  chatFull === null ? '' : `This chat is ${chatFull}% full.`,
                  checkpointAt === null ? '' : `Last checkpoint saved at ${clockTime(checkpointAt)}.`,
                ]
                  .filter(Boolean)
                  .join(' ')}
              </Text>
            )}
            <Box flexDirection="row" gap={1}>
              <Button key="tidy-now" label="Tidy up now" onPress={() => tidyUp($)} />
              {checkpointAt !== null && <Button key="recap" label="Where we left off" onPress={() => showRecap($)} />}
            </Box>
          </Box>,
        )}
        {!vector && <Text dimColor>{rule}</Text>}
        <Box key="actions" flexDirection="row" gap={1} marginTop={vector ? 2 : 0} justifyContent={vector ? 'flex-end' : undefined} width={vector ? columns : undefined}>
          {/* Changes apply as they are made, and the app draws the panel's close control: no Done needed there. */}
          {!vector && <Button key="close" label="Done" variant="primary" role="dismiss" onPress={() => $.ui.close({ id: SETTINGS_PANE })} />}
          <Button key="reset" label="Reset to defaults" onPress={() => resetSettings($)} />
        </Box>
      </Box>
    )
  })

  // The checkpoint Claude saved before the chat was tidied up, in its own words.
  on('ui.render', { component: 'Pane', requestId: RECAP_PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = table
    const kit = kitOf(table, e.surface)
    const vector = kit.isVector
    const note = await checkpointOf($).catch(() => null)
    const at = await read($, checkpointAtom)
    const columns = Math.max(30, e.props.bodyColumns)
    // The app draws a panel's own close control; the terminal's panel needs the button.
    const close = vector ? null : <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: RECAP_PANE })} />
    // A line with the checkpoint's mark on vector surfaces; plain dim text on the terminal.
    const lead = (words: string) =>
      vector ? (
        <Box key="lead" flexDirection="row" gap={1} width={columns}>
          {kit.icon('bookmark', 'quiet', 'Checkpoint')}
          <Box flexShrink={1}>
            <Text dimColor wrap="wrap">
              {words}
            </Text>
          </Box>
        </Box>
      ) : (
        <Text key="lead" dimColor wrap="wrap">
          {words}
        </Text>
      )
    if (note === null) {
      return (
        <Box flexDirection="column" width={columns}>
          {lead('No checkpoint in this chat yet. When Claude tidies the chat up, it saves one first, and it shows here.')}
          {close && (
            <Box key="actions" flexDirection="row">
              {close}
            </Box>
          )}
        </Box>
      )
    }
    // Claude's own words, as it keeps them; personal details masked and times in the person's own time.
    const text = localTimes(maskPrivate(note.replace(/^Checkpoint:\s*/, '')))

    return (
      <Box flexDirection="column" width={columns}>
        {lead(`Saved${at === null ? '' : ` at ${clockTime(at)}`}, before the chat was tidied up. Claude keeps reading it for the rest of this chat.`)}
        <Box key="note" flexDirection="column" marginTop={1}>
          {vector ? (
            // Claude writes the checkpoint in markdown: headings and lists read as they would in a reply.
            <Markdown key="note-text" text={text.slice(0, 10_000)} />
          ) : (
            text.split('\n').map((line, index) => (
              <Text key={`line-${index}`} wrap="wrap">
                {line || ' '}
              </Text>
            ))
          )}
        </Box>
        {close && (
          <Box key="actions" flexDirection="row" marginTop={1}>
            {close}
          </Box>
        )}
      </Box>
    )
  })

  // The whole plan beside the chat, with what the band above the prompt has no room for: when the job started and
  // should end, every step's summary and time (or expected time), all helpers, and in Details the tokens and cost.
  on('ui.render', { component: 'Pane', requestId: PLAN_PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const kit = kitOf(table, e.surface)
    const vector = kit.isVector
    const list = await read($, checklistAtom)
    const tick = await read($, tickAtom)
    const isDetailed = (await read($, detailAtom)) === 'detailed'
    const isCalm = await read($, calmAtom)
    const columns = Math.max(40, e.props.bodyColumns)
    const actions = (
      <Box key="actions" flexDirection="row" gap={1} marginTop={vector ? 2 : 1}>
        {/* The app draws a panel's own close control; the terminal's panel needs the button. */}
        {!vector && <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PLAN_PANE })} />}
        <Button key="history" label="History" onPress={async () => showHistory($, dayKey(await now($)), true)} />
      </Box>
    )
    if (list === null || !list.hasPlan) {
      const words = 'No plan yet. Ask Claude for something and its plan shows here.'
      return (
        <Box flexDirection="column">
          {vector ? (
            <Box flexDirection="row" gap={1}>
              {kit.icon('plan', 'quiet', 'No plan yet')}
              <Text dimColor wrap="wrap">
                {words}
              </Text>
            </Box>
          ) : (
            <Text dimColor>{words}</Text>
          )}
          {actions}
        </Box>
      )
    }

    const at = list.finishedAt ?? (await now($))
    const active = list.tasks.find(one => one.status === 'active')
    // The same percentage as the band in this view: Details fills the current step from its time estimate.
    const activePercent = active ? stepEstimate(list, active, at).percent : undefined
    const { percent, doneCount } = overallProgress(list.tasks, activePercent)
    const left = list.phase === 'done' ? null : timeLeft(list, at, activePercent)
    const when =
      list.phase === 'done'
        ? `Started ${clockTime(list.startedAt)} · finished ${clockTime(at)} · took ${(vector ? durationWords : formatDuration)(at - list.startedAt)}`
        : [
            `Started ${clockTime(list.startedAt)}`,
            // Where the band above already counts the time and what is left, the panel says when it should end.
            vector ? '' : `${formatDuration(at - list.startedAt)} so far`,
            left === null ? '' : vector ? `done around ${clockTime(at + left)}` : `about ${formatLeft(left)} left, done around ${clockTime(at + left)}`,
          ]
            .filter(Boolean)
            .join(' · ')
    const grew = list.plannedCount > 0 && list.tasks.length > list.plannedCount ? ` · plan grew ${list.plannedCount} → ${list.tasks.length}` : ''
    const status =
      list.phase === 'needsYou'
        ? { color: 'yellow', tone: 'warn' as const, icon: 'bell' as const, lead: 'Needs you', text: needsText(list) ?? WAITING }
        : list.phase === 'stuck'
          ? { color: 'yellow', tone: 'alert' as const, icon: 'bang' as const, lead: 'Stuck', text: list.stuckReason ?? "Claude can't go on right now" }
          : list.phase === 'stopped'
            ? list.stopKind === 'pause'
              ? { color: undefined, tone: 'quiet' as const, icon: 'pause' as const, lead: 'Paused', text: 'press Continue to pick up' }
              : { color: undefined, tone: 'quiet' as const, icon: 'stop' as const, lead: 'Stopped', text: 'you pressed Esc' }
            : list.phase === 'background'
              ? { color: 'cyan', tone: 'active' as const, icon: 'clock' as const, lead: 'Claude answered', text: 'helpers still run in the background' }
              : null

    // One row per step: mark, name, then its time. On the terminal the time column lines up by cells; elsewhere the
    // name takes the room and the time keeps to the right edge.
    const nameWidth = Math.max(12, Math.min(MAX_NAME, columns - 24))
    type Mark = { glyph: RenderChildren; icon: RenderChildren }
    // A name or time too long for its column goes on lines of its own, in full, instead of being cut.
    const row = (key: string, mark: Mark, name: string, look: { bold?: boolean; dim?: boolean }, time: string, timeIsDim = true) =>
      vector ? (
        <Box key={key} flexDirection="row" gap={1} width={columns}>
          {mark.icon}
          <Box flexGrow={1} flexShrink={1}>
            <Text bold={look.bold} dimColor={look.dim} wrap="wrap">
              {name}
            </Text>
          </Box>
          {time !== '' && (
            <Box flexShrink={0}>
              <Text dimColor={timeIsDim}>{time}</Text>
            </Box>
          )}
        </Box>
      ) : widthOf(name) <= nameWidth && widthOf(time) < columns - 3 - nameWidth ? (
        <Box key={key} flexDirection="row">
          {mark.glyph}
          <Text bold={look.bold} dimColor={look.dim}>
            {fit(name, nameWidth)}
          </Text>
          <Text dimColor={timeIsDim}>{` ${time}`}</Text>
        </Box>
      ) : (
        <Box key={key} flexDirection="column">
          <Box flexDirection="row">
            {mark.glyph}
            <Box flexShrink={1}>
              <Text bold={look.bold} dimColor={look.dim} wrap="wrap">
                {name}
              </Text>
            </Box>
          </Box>
          {time !== '' && (
            <Text dimColor={timeIsDim} wrap="wrap">
              {`  ${time}`}
            </Text>
          )}
        </Box>
      )
    // A line under a step, in line with its name. A command keeps to one line, cut at the edge.
    const note = (key: string, text: string, icon?: RenderChildren, isOneLine = false) =>
      vector ? (
        <Box key={key} flexDirection="row" gap={1} width={columns}>
          {kit.blank('Detail')}
          {icon}
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor wrap={isOneLine ? 'truncate-end' : 'wrap'}>
              {text}
            </Text>
          </Box>
        </Box>
      ) : (
        <Text key={key} dimColor wrap="wrap">
          {`    ${text}`}
        </Text>
      )
    const helperRows = (one: GlanceTask) =>
      list.helpers
        .filter(helper => helper.stepId === one.id)
        .map(helper => {
          const mark = helper.status === 'running' ? '◐' : helper.status === 'failed' ? '✗' : '✓'
          const kind = helper.kind === 'background' ? 'in the background' : helper.type === 'general-purpose' ? 'helper' : helper.type
          const details = [kind, helper.model, isDetailed && helper.effort ? `${helper.effort} effort` : null, isDetailed && helper.tokens > 0 ? `${formatTokens(helper.tokens)} tokens` : null]
            .filter(Boolean)
            .join(' · ')
          const words = `${helper.label}${details ? ` · ${details}` : ''}`
          return vector
            ? note(
                `helper-${helper.id}`,
                words,
                helper.status === 'running'
                  ? kit.ring(null, isCalm ? 0 : tick, 'Running', 13)
                  : helper.status === 'failed'
                    ? kit.badge('close', 'alert', 'Failed', 13)
                    : kit.badge('check', 'ok', 'Done', 13),
              )
            : note(`helper-${helper.id}`, `↳ ${mark} ${words}`)
        })
    const tokensOf = (one: GlanceTask) => (isDetailed ? tokenNote(one.tokens, one.cachedTokens) : '')
    const filesOf = (key: string, one: GlanceTask, suffix = '') =>
      one.files?.length ? [note(`${key}-files`, `${filesNote(one.files)}${suffix}`, vector ? kit.icon('file', 'quiet', 'Files', 13) : undefined)] : []

    const done: RenderChildren[] = []
    const now_: RenderChildren[] = []
    const next_: RenderChildren[] = []
    list.tasks.forEach((one, index) => {
      const key = `step-${index}`
      if (one.status === 'done') {
        const ms = one.startedAt !== null && one.finishedAt !== null ? one.finishedAt - one.startedAt : null
        // Under the Done heading a time says how long it took; the terminal, with no heading in the column, says so.
        const took = ms === null ? (vector ? '' : 'done') : vector ? (ms < 1000 ? '' : durationWords(ms)) : `took ${formatDuration(ms)}`
        done.push(
          row(key, { glyph: <Text color="green">✓ </Text>, icon: kit.icon('done', 'ok', 'Done') }, one.name, {}, [took, tokensOf(one)].filter(Boolean).join(' · ')),
          ...(one.summary ? [note(`${key}-summary`, one.summary)] : []),
          ...filesOf(key, one),
          ...helperRows(one),
        )
      } else if (one.status === 'active') {
        const estimate = stepEstimate(list, one, at)
        const time = [isDetailed && !vector ? `${estimate.percent}%` : '', (vector ? durationWords : formatDuration)(estimate.elapsedMs), leftLabel(estimate.leftMs, vector)]
          .filter(Boolean)
          .join(' · ')
        const waits = status !== null && status.tone !== 'active'
        now_.push(
          row(
            key,
            {
              glyph: <Text color="cyan">▶ </Text>,
              icon: waits ? kit.badge(status.icon, status.tone, status.lead) : kit.badge('play', 'active', 'Now'),
            },
            one.name,
            { bold: true },
            time,
            false,
          ),
          // The Plan says more than the band: Claude's own words for what it is doing, and in Details what it runs.
          ...(list.phase === 'working' && list.activity !== null
            ? [
                note(
                  `${key}-activity`,
                  `${vector ? '' : 'Now: '}${list.activity.detail ?? list.activity.label}${list.activity.count > 1 ? ` (${list.activity.label.toLowerCase()}, ${list.activity.count} in a row)` : ''}`,
                ),
                ...(isDetailed && list.activity.target && !(vector && one.files?.some(file => file.path.split('/').pop() === list.activity!.target))
                  ? [note(`${key}-target`, vector ? list.activity.target : `↳ ${list.activity.target}`, vector ? kit.icon('sub', 'quiet', 'Runs', 13) : undefined, true)]
                  : []),
              ]
            : []),
          ...(tokensOf(one) ? [note(`${key}-tokens`, `${tokensOf(one)} so far`)] : []),
          ...filesOf(key, one, ' so far'),
          ...helperRows(one),
        )
      } else {
        const { expectedMs: expected } = stepEstimate(list, one, at)
        next_.push(
          row(key, { glyph: <Text dimColor>○ </Text>, icon: kit.open('To do') }, one.name, { dim: true }, expected < 60_000 ? 'under a minute' : `about ${formatLeft(expected)}`),
          ...helperRows(one),
        )
      }
    })
    const section = (key: string, label: string, rows: RenderChildren[]) =>
      rows.length === 0 ? null : (
        <Box key={key} flexDirection="column" marginTop={1}>
          {/* Elsewhere than the terminal the section heads the rows under it at full strength, as a heading should. */}
          <Text bold dimColor={!vector}>
            {label}
          </Text>
          {rows}
        </Box>
      )

    const footer: string[] = []
    const running = list.helpers.filter(one => one.status === 'running').length
    // Elsewhere than the terminal each helper's own row says it; the count would repeat them.
    if (list.helpers.length > 0 && !vector) {
      const finished = list.helpers.length - running
      footer.push(`Helpers: ${[running > 0 ? `${running} working` : '', finished > 0 ? `${finished} finished` : ''].filter(Boolean).join(', ')}`)
    }
    if (left !== null && list.paceMs !== null && doneCount < 2) {
      footer.push('Time left is based on how long steps took in this project before.')
    }
    if (isDetailed) {
      const usage = await read($, usageAtom)
      const tokens = list.tasks.reduce((sum, one) => sum + one.tokens, list.extraTokens)
      const cached = list.tasks.reduce((sum, one) => sum + one.cachedTokens, list.extraCachedTokens)
      const spent = jobCost(list, usage)
      const job = [tokenNote(tokens, cached), spent === null ? '' : formatCost(spent)].filter(Boolean).join(' · ')
      if (job) footer.push(`This job: ${job}`)
      const plan = [
        ...usage.limits.map(one => `${one.label} ${Math.round(one.percent)}%`),
        usage.contextPercent === null ? '' : `chat ${Math.round(usage.contextPercent)}% full`,
      ].filter(Boolean)
      if (plan.length > 0) footer.push(`Plan usage: ${plan.join(' · ')}`)
    }

    const isDone = list.phase === 'done'
    // Elsewhere than the terminal the bar shows the percentage, which weighs steps by size: the words just count them.
    const summary = `${vector ? '' : `${percent}% · `}${doneCount} of ${list.tasks.length} steps done${grew}`
    const cells = Math.round(percent / 5)
    return (
      <Box flexDirection="column" width={columns}>
        <Text bold wrap="wrap">
          {list.title}
        </Text>
        <Text dimColor wrap="wrap">
          {when}
        </Text>
        {vector ? (
          <Box key="progress" flexDirection="row" alignItems="center" gap={1} marginTop={1}>
            <Box flexShrink={0}>{kit.meter(isDone ? 'ok' : 'active', percent, 0, `${percent}% done`, 160)}</Box>
            <Text>{summary}</Text>
          </Box>
        ) : (
          <Box key="progress" flexDirection="row">
            <Text color={isDone ? 'green' : 'cyan'}>{'█'.repeat(cells) + '░'.repeat(20 - cells)}</Text>
            <Text>{` ${summary}`}</Text>
          </Box>
        )}
        {status &&
          (vector ? (
            <Box key="status" flexDirection="row" gap={1} marginTop={1}>
              {status.tone === 'active' ? kit.icon(status.icon, status.tone, status.lead) : kit.badge(status.icon, status.tone, status.lead)}
              <Box flexShrink={1}>
                <Text wrap="wrap">
                  <Text bold color={status.color}>
                    {status.lead}
                  </Text>
                  <Text>{` · ${status.text}`}</Text>
                </Text>
              </Box>
            </Box>
          ) : (
            <Text key="status" color={status.color} bold wrap="wrap">
              {status.lead === 'Claude answered' ? `${status.lead}; ${status.text}` : `${status.lead}: ${status.text}`}
            </Text>
          ))}
        {section('done', 'Done', done)}
        {section('now', 'Now', now_)}
        {section('next', 'Next', next_)}
        {footer.length > 0 && (
          <Box key="footer" flexDirection="column" marginTop={1}>
            {footer.map((line, index) => (
              <Text key={`footer-${index}`} dimColor wrap="wrap">
                {line}
              </Text>
            ))}
          </Box>
        )}
        {actions}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: HISTORY_PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const kit = kitOf(table, e.surface)
    const vector = kit.isVector
    const view = await read($, historyAtom)
    const columns = Math.max(30, e.props.bodyColumns)
    const today = dayKey(await now($))
    // The app draws a panel's own close control; the terminal's panel needs the button.
    const close = vector ? null : <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: HISTORY_PANE })} />
    if (view === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Type /glanceflow history to see today's tasks.</Text>
          {close}
        </Box>
      )
    }

    // Day picker: earlier, a drop-down of saved days, later, and today.
    const dayLabel = (day: string) => (vector ? (day === today ? `Today · ${longDay(day)}` : longDay(day)) : day === today ? `Today, ${day}` : day)
    const picker = (
      <Box key="picker" flexDirection="column" marginBottom={1}>
        {/* The app titles the panel "History · <folder>"; the terminal's panel shows the day here too. */}
        {!vector && (
          <Text key="heading" bold wrap="truncate-end">
            {`${projectName(view.project)} · ${longDay(view.day)}`}
          </Text>
        )}
        <Box key="controls" flexDirection="row" gap={1} alignItems={vector ? 'center' : undefined}>
          <Button key="earlier" label={vector ? 'Previous day' : '◀ Earlier'} onPress={() => showHistory($, shiftDay(view.day, -1), false)} />
          {'Select' in table && table.Select ? (
            <table.Select
              key="day"
              // The terminal's Select draws "label: value" itself, so the label carries no colon. The desktop's value
              // already starts with the day ("Today · …"): a label there would stutter.
              label={vector ? undefined : 'Day'}
              value={view.day}
              options={view.days.map(day => ({ value: day, label: dayLabel(day) }))}
              onSelect={day => void showHistory($, day, false)}
            />
          ) : (
            <Text bold>{dayLabel(view.day)}</Text>
          )}
          {view.day < today && (
            <Button key="later" label={vector ? 'Next day' : 'Later ▶'} onPress={() => showHistory($, shiftDay(view.day, 1), false)} />
          )}
          {view.day !== today && <Button key="today" label="Today" onPress={() => showHistory($, today, false)} />}
        </Box>
      </Box>
    )

    const report = reportOf(view)
    if (view.isReportShown) {
      return (
        <Box flexDirection="column" width={columns}>
          {picker}
          {vector && (
            <Text key="caption" dimColor>
              What you'll paste
            </Text>
          )}
          <Box
            key="report"
            flexDirection="column"
            borderStyle={vector ? 'round' : undefined}
            borderDimColor={vector || undefined}
            paddingX={vector ? 1 : undefined}
            paddingY={vector ? 1 : undefined}
            marginTop={vector ? 1 : undefined}
          >
            {report.split('\n').map((line, index, lines) => (
              // On vector surfaces a section's label (a line a list starts under) reads bold too.
              <Text key={`report-${index}`} bold={index === 0 || (vector && line !== '' && !/^[\s•]/.test(line) && /^•/.test(lines[index + 1] ?? ''))} wrap="wrap">
                {line || ' '}
              </Text>
            ))}
          </Box>
          <Box key="report-actions" flexDirection="row" gap={1} marginTop={1}>
            {vector && <Button key="back" label="Back to the list" onPress={() => showReport($, false, report, e.surface)} />}
            <Button key="copy" variant="primary" label="Copy report" onPress={() => showReport($, true, report, e.surface)} />
            {view.reportSpan === 'mine' ? null : view.reportSpan === 'week' ? (
              <Button key="span" label={vector ? 'Day report' : 'This day'} onPress={() => showReportSpan($, 'day', e.surface)} />
            ) : (
              <Button key="span" label={vector ? 'Week report' : 'This week'} onPress={() => showReportSpan($, 'week', e.surface)} />
            )}
            {!vector && <Button key="back" label="Back to the list" onPress={() => showReport($, false, report, e.surface)} />}
            {close}
          </Box>
        </Box>
      )
    }

    if (view.entries.length === 0) {
      const words = 'No tasks saved for this project on that day yet.'
      return (
        <Box flexDirection="column" width={columns}>
          {picker}
          {vector ? (
            <Box flexDirection="row" gap={1}>
              {kit.icon('plan', 'quiet', 'Nothing saved')}
              <Text dimColor wrap="wrap">
                {words}
              </Text>
            </Box>
          ) : (
            <Text dimColor>{words}</Text>
          )}
          <Box key="actions" flexDirection="row" gap={1} marginTop={1}>
            <Button key="mine" label={vector ? 'All projects this week' : 'Your week'} onPress={() => showReportSpan($, 'mine', e.surface)} />
            {close}
          </Box>
        </Box>
      )
    }

    const marks: Record<GlanceHistoryEntry['outcome'], [string, string | undefined]> = {
      done: ['✓', 'green'],
      stopped: ['■', undefined],
      stuck: ['⚠', 'yellow'],
      waiting: ['‖', 'yellow'],
      background: ['◷', 'cyan'],
      working: ['▶', 'cyan'],
    }
    const outcomeMark = (outcome: GlanceHistoryEntry['outcome']) =>
      outcome === 'done'
        ? kit.icon('done', 'ok', 'Done')
        : outcome === 'stopped'
          ? kit.badge('stop', 'quiet', 'Stopped')
          : outcome === 'stuck'
            ? kit.badge('bang', 'alert', 'Stuck')
            : outcome === 'waiting'
              ? kit.badge('bell', 'warn', 'Waiting')
              : outcome === 'background'
                ? kit.icon('clock', 'active', 'In the background')
                : kit.ring(null, 0, 'Working')
    const titleWidth = Math.max(12, Math.min(MAX_NAME, columns - 9 - 36))
    const rows = view.entries.map(one => {
      const [mark, color] = marks[one.outcome]
      const took = one.finishedAt === null ? 'not finished' : (vector ? durationWords : formatDuration)(one.finishedAt - one.startedAt)
      const details = [
        `${one.stepsDone}/${one.stepsTotal}`,
        took,
        tokenNote(one.newTokens + one.cachedTokens, one.cachedTokens),
        typeof one.costUsd === 'number' ? formatCost(one.costUsd) : '',
      ]
        .filter(Boolean)
        .join(' · ')
      const files = filesNote(entryFiles(one))
      if (vector) {
        return (
          <Box key={`job-${one.jobId}`} flexDirection="column" marginBottom={1}>
            <Box key="row" flexDirection="row" gap={1} width={columns}>
              {outcomeMark(one.outcome)}
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text bold={one.outcome !== 'stopped'} dimColor={one.outcome === 'stopped'} wrap="truncate-end">
                  {one.title}
                </Text>
              </Box>
              <Box flexShrink={0}>
                <Text dimColor>{clockTime(one.startedAt)}</Text>
              </Box>
            </Box>
            <Box key="details" flexDirection="row" gap={1} width={columns}>
              {kit.blank('Detail')}
              <Box flexShrink={1}>
                <Text dimColor wrap="wrap">
                  {`${one.stepsDone} of ${one.stepsTotal} steps · ${[took, tokenNote(one.newTokens + one.cachedTokens, one.cachedTokens), typeof one.costUsd === 'number' ? formatCost(one.costUsd) : ''].filter(Boolean).join(' · ')}`}
                </Text>
              </Box>
            </Box>
            {files !== '' && (
              <Box key="files" flexDirection="row" gap={1} width={columns}>
                {kit.blank('Detail')}
                {kit.icon('file', 'quiet', 'Files', 13)}
                <Box flexShrink={1}>
                  <Text dimColor wrap="wrap">
                    {files}
                  </Text>
                </Box>
              </Box>
            )}
          </Box>
        )
      }
      return (
        <Box key={`job-${one.jobId}`} flexDirection="column">
          <Box key="row" flexDirection="row">
            <Text dimColor>{`${clockTime(one.startedAt)}  `}</Text>
            <Text color={color} dimColor={one.outcome === 'stopped'}>{`${mark} `}</Text>
            <Text bold={one.outcome !== 'stopped'}>{fit(one.title, titleWidth)}</Text>
            <Text dimColor wrap="truncate-end">
              {` ${fit(details, Math.max(0, columns - 9 - titleWidth - 1)).trimEnd()}`}
            </Text>
          </Box>
          {files !== '' && (
            <Text key="files" dimColor wrap="wrap">
              {`         ${files}`}
            </Text>
          )}
        </Box>
      )
    })

    const finished = view.entries.filter(one => one.finishedAt !== null)
    const time = finished.reduce((sum, one) => sum + (one.finishedAt! - one.startedAt), 0)
    const newTokens = view.entries.reduce((sum, one) => sum + one.newTokens, 0)
    const cached = view.entries.reduce((sum, one) => sum + one.cachedTokens, 0)
    const priced = view.entries.filter(one => typeof one.costUsd === 'number')
    const spent = priced.reduce((sum, one) => sum + (one.costUsd ?? 0), 0)
    const counts = (Object.keys(marks) as GlanceHistoryEntry['outcome'][])
      .map(outcome => [outcome, view.entries.filter(one => one.outcome === outcome).length] as const)
      .filter(([, count]) => count > 0)
      .map(([outcome, count]) => `${count} ${outcome}`)
    const total = [
      `${view.entries.length} ${view.entries.length === 1 ? 'task' : 'tasks'}`,
      counts.join(', '),
      (vector ? durationWords : formatDuration)(time),
      tokenNote(newTokens + cached, cached),
      priced.length > 0 ? formatCost(spent) : '',
    ]
      .filter(Boolean)
      .join(' · ')

    return (
      <Box flexDirection="column" width={columns}>
        {picker}
        {rows}
        <Box key="total" marginTop={vector ? 0 : 1}>
          {vector ? (
            <Text dimColor wrap="wrap">{`Total: ${total}`}</Text>
          ) : (
            <Text bold wrap="truncate-end">{`Total: ${total}`}</Text>
          )}
        </Box>
        <Box key="actions" flexDirection="row" gap={1} marginTop={1}>
          <Button
            key="report"
            variant={vector ? 'secondary' : 'primary'}
            label={vector ? (view.reportSpan === 'week' ? 'Week report' : 'Day report') : 'Team report'}
            onPress={() => showReportSpan($, view.reportSpan === 'week' ? 'week' : 'day', e.surface)}
          />
          {/* Your week covers every project, so on the desktop its name says so beside this project's reports. */}
          <Button key="mine" label={vector ? 'All projects this week' : 'Your week'} onPress={() => showReportSpan($, 'mine', e.surface)} />
          {close}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    // Other mods draw in this band too (an approval card, prompt buttons): keep theirs, under ours.
    const beneath = await next(e).catch(() => null)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // The desktop app, VS Code and the phone set text in a proportional font and draw vectors: there the band is
    // flex rows with SVG marks and one slim bar. The terminal lines its columns up by cells, with glyphs.
    const kit = kitOf(table, e.surface)
    const vector = kit.isVector
    // What is beneath may be the engine's own node, which can't sit under a Box with a width: wrap, don't nest.
    const withBeneath = (tree: RenderElement): RenderElement =>
      beneath ? (
        <Box flexDirection="column">
          {tree}
          {beneath}
        </Box>
      ) : (
        tree
      )
    const isEnabled = await read($, enabledAtom)
    const list = isEnabled ? await read($, checklistAtom) : null
    const tick = list ? await read($, tickAtom) : 0
    const usage = isEnabled ? await read($, usageAtom) : NO_USAGE
    const isDetailed = isEnabled && (await read($, detailAtom)) === 'detailed'
    const isCalm = isEnabled && (await read($, calmAtom))
    const handoff = isEnabled ? await read($, handoffAtom) : 'idle'
    const columns = Math.max(20, e.props.bodyColumns)
    const current = await now($)

    // A line of the band on vector surfaces: a mark, then what it says, then anything kept to the right.
    // A box that holds a cut line needs minWidth 0: in the desktop app's flex rows, it would otherwise push past the edge.
    const line = (key: string, mark: RenderChildren, body: RenderChildren, right?: RenderChildren) => (
      <Box key={key} flexDirection="row" alignItems="center" gap={1} width={columns}>
        {mark}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {body}
        </Box>
        {right !== undefined && <Box flexShrink={0}>{right}</Box>}
      </Box>
    )

    // Plan usage, always in view; it turns yellow, then red, as a window fills.
    const warnings: RenderChildren[] = []
    // Last row: open the history, or hand this chat off to a fresh one (a second press confirms).
    const list0 = isEnabled ? await read($, checklistAtom) : null
    const canPause =
      runningTurn !== undefined &&
      list0 !== null &&
      (list0.phase === 'working' || list0.phase === 'needsYou') &&
      list0.needsYouReason !== WAITING &&
      list0.approval !== 'waiting'
    const canContinue =
      list0 !== null &&
      (list0.phase === 'stopped' || list0.phase === 'stuck' || (list0.phase === 'needsYou' && list0.needsYouReason === WAITING))
    // An action: on the terminal its glyph leads the label. Elsewhere it is the app's own button, so it reads as one
    // at a glance; the one that matters now (Continue, Start) is the primary one.
    const action = (key: string, icon: IconName, label: string, onPress: () => unknown, short?: string, isMain = false) =>
      vector ? (
        <Button key={key} variant={isMain ? 'primary' : 'secondary'} label={label} onPress={onPress} />
      ) : (
        <Button key={key} plain label={short ?? `${GLYPH[icon]} ${label}`} onPress={onPress} />
      )
    const handoffLabel =
      handoff === 'armed' ? 'Press again to start a fresh chat' : handoff === 'working' ? 'Writing a handoff note…' : 'Fresh chat'
    // What steers the job (Pause, Start, Continue); elsewhere than the terminal it sits beside the job's status.
    // Elsewhere than the terminal a stuck job is tried again, and a usage limit won't lift for a press, so that
    // button stays quiet.
    const isStuck = list0?.phase === 'stuck'
    const pauseLabel = 'Pause'
    const continueLabel = vector && isStuck ? 'Try again' : 'Continue'
    const isLimitStuck = isStuck && /limit/i.test(list0?.stuckReason ?? '')
    const controls = isEnabled
      ? [
          canPause && action('pause', 'pause', pauseLabel, () => pauseJob($)),
          list0?.approval === 'waiting' && action('start', 'play', 'Start', () => startPlan($), undefined, true),
          canContinue && action('continue', 'play', continueLabel, () => continueJob($), undefined, !(vector && isLimitStuck)),
        ].filter(Boolean)
      : []
    const controlLabels = [canPause && pauseLabel, list0?.approval === 'waiting' && 'Start', canContinue && continueLabel].filter(
      (label): label is string => typeof label === 'string',
    )
    const tidyAt = isEnabled ? await read($, tidyAtAtom) : 0
    const isChatFull = usage.contextPercent !== null && tidyAt > 0 && usage.contextPercent >= tidyAt
    // A fresh chat ends this one. Elsewhere than the terminal it stands apart from the places to go, and only once the
    // job has stopped or finished (mid-job, Tidy up now is the way to make room), or while a first press waits.
    const handoffItem =
      list0 !== null &&
      (!vector || list0.phase === 'done' || list0.phase === 'stopped' || handoff !== 'idle') &&
      action('handoff', 'fresh', handoffLabel, () => pressHandoff($), handoff === 'idle' && columns < 40 ? '↻ Fresh' : undefined)
    // Where to go from here: the plan, the history, the settings.
    const places = isEnabled
      ? [
          list0?.hasPlan && action('plan', 'plan', 'Plan', () => showPlan($)),
          // ≣, not ☰: Unicode 16 made ☰ two cells wide, and the row shifted in newer terminals.
          action('history', 'history', 'History', () => showHistory($, dayKey(current), true)),
          action('settings', 'sliders', 'Settings', () => showSettings($), columns < 60 ? '⚙' : undefined),
          !vector && handoffItem,
        ].filter(Boolean)
      : []
    const actionItems = isEnabled ? [...controls, ...places] : null
    const chatPart = usage.contextPercent === null ? '' : `chat ${Math.round(usage.contextPercent)}% full`
    const usageParts = [
      ...usage.limits.map(one => `${one.label} ${Math.round(one.percent)}%`),
      // On the terminal the line below says how full the chat is, with the button to tidy it up: not twice.
      isChatFull && !vector ? '' : chatPart,
    ].filter(Boolean)
    const top = usage.limitPercent ?? 0
    const isHigh = top >= LIMIT_WARN
    const reset = isHigh ? resetTime(usage.limitResetsAt, await now($)) : null
    const tidy = <Button key="compact" label={vector ? 'Tidy up now' : 'Tidy it up'} onPress={() => tidyUp($)} />
    if (vector) {
      // One quiet row: the details view always shows usage; the simple view only near a limit or with the chat past the
      // tidy-up mark, when the row ends with the button. The icon carries the colour, as the app's own notices do.
      if (usageParts.length > 0 && (isDetailed || isHigh || isChatFull)) {
        const words = isHigh
          ? [`You've used ${Math.round(top)}% of your ${usage.limitLabel ?? 'plan'} limit${reset === null ? '' : ` · resets ${reset}`}`, isChatFull ? chatPart : '']
          : isDetailed
            ? [`Usage: ${usageParts.join(' · ')}`]
            : [`This ${chatPart.replace(/^chat/, 'chat is')}`, 'tidying up keeps a checkpoint first']
        warnings.push(
          line(
            'limit',
            isHigh
              ? kit.icon('alert', top >= LIMIT_ALERT ? 'alert' : 'warn', 'Near a limit')
              : isChatFull
                ? kit.icon('tidy', 'warn', 'Chat getting full')
                : kit.icon('clock', 'quiet', 'Usage'),
            <Text wrap="truncate-end" dimColor={!isHigh}>
              {words.filter(Boolean).join(' · ')}
            </Text>,
            isChatFull ? tidy : undefined,
          ),
        )
      }
    } else if (usageParts.length > 0 && (isDetailed || isHigh)) {
      // The simple view speaks up only near a limit; the detailed view always shows usage.
      const color = top >= LIMIT_ALERT ? 'red' : isHigh ? 'yellow' : undefined
      const words = isHigh
        ? `You've used ${Math.round(top)}% of your ${usage.limitLabel ?? 'plan'} limit${reset === null ? '' : ` · resets ${reset}`} · ${usageParts.join(' · ')}`
        : `Plan usage: ${usageParts.join(' · ')}`
      warnings.push(
        <Box key="limit" width={columns}>
          <Text wrap="truncate-end" color={color} dimColor={!isHigh}>
            {isHigh ? `⚠ ${words}` : words}
          </Text>
        </Box>,
      )
    }
    if (isChatFull && !vector && usage.contextPercent !== null) {
      const words = `This chat is ${Math.round(usage.contextPercent)}% full. Claude saves a checkpoint before tidying up.`
      warnings.push(
        <Box key="long-chat" flexDirection="row" justifyContent="space-between" width={columns}>
          <Box flexShrink={1}>
            <Text wrap="truncate-end" color="yellow">
              {words}
            </Text>
          </Box>
          {tidy}
        </Box>,
      )
    }

    if (isEnabled && (await read($, recapAtom))) {
      const buttons = (
        <Box flexDirection="row" gap={1}>
          <Button key="recap" label="Where we left off" onPress={() => showRecap($)} />
          <Button key="recap-ok" plain={vector ? undefined : true} label="OK" onPress={() => update($, recapAtom, () => false)} />
        </Box>
      )
      warnings.push(
        vector ? (
          line(
            'recap',
            kit.badge('check', 'ok', 'Tidied up'),
            <Text wrap="truncate-end">Chat tidied up. Claude kept a checkpoint of the work.</Text>,
            buttons,
          )
        ) : (
          <Box key="recap" flexDirection="row" justifyContent="space-between" width={columns}>
            <Box flexShrink={1}>
              <Text wrap="truncate-end" color="green">
                ✓ Chat tidied up. Claude kept a checkpoint of the work.
              </Text>
            </Box>
            {buttons}
          </Box>
        ),
      )
    }

    // The view: on the terminal one button steps through Simple → Details → Off. Elsewhere a menu shows the view and
    // the others, so no press turns GlanceFlow off by surprise; a surface without one (the phone) keeps the button.
    const view = !isEnabled ? 'off' : isDetailed ? 'detailed' : 'simple'
    const button =
      vector && 'Select' in table && table.Select ? (
        <table.Select
          key="view"
          label="View"
          value={view}
          options={[
            { value: 'simple', label: 'Simple' },
            { value: 'detailed', label: 'Details' },
            { value: 'off', label: 'Off' },
          ]}
          onSelect={value => void setView($, value as typeof view)}
        />
      ) : (
      <Button
        key="toggle"
        label={
          vector
            ? `View: ${view === 'off' ? 'Off' : view === 'detailed' ? 'Details' : 'Simple'}`
            : columns < NARROW
              ? !isEnabled
                ? '○ Off'
                : isDetailed
                  ? '● Details'
                  : '● Simple'
              : !isEnabled
                ? '○ GlanceFlow: Off'
                : isDetailed
                  ? '● GlanceFlow: Details'
                  : '● GlanceFlow: Simple'
        }
        variant={isEnabled && !vector ? 'primary' : 'secondary'}
        onPress={() => cycleMode($, isEnabled, isDetailed)}
      />
      )
    // The row under the checklist. Elsewhere than the terminal: where to go on the left, the view on the right,
    // wrapping onto a second line when the band is narrow.
    const actions =
      actionItems === null ? null : vector ? (
        <Box key="actions" flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={2} rowGap={1} flexWrap="wrap" width={columns} marginTop={1}>
          <Box flexDirection="row" alignItems="center" columnGap={1} rowGap={1} flexWrap="wrap" flexShrink={1} minWidth={0}>
            {places}
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {handoffItem}
            {button}
          </Box>
        </Box>
      ) : (
        <Box key="actions" flexDirection="row" gap={columns < 44 ? 1 : 2}>
          {actionItems}
        </Box>
      )
    // The header's right end: on the terminal the view button; elsewhere what steers the job, or, with GlanceFlow
    // off, the view.
    const headerRight = vector ? (!isEnabled ? button : controls.length > 0 ? controls : null) : button
    const rightCells = vector
      ? !isEnabled
        ? 20
        : controlLabels.reduce((sum, label) => sum + widthOf(label) + 2, controlLabels.length > 0 ? 2 : 0)
      : columns < NARROW ? 15 : 27
    const headerWidth = Math.max(0, columns - rightCells - (vector ? 4 : 0))
    const row = (header: RenderChildren) => (
      <Box key="header" flexDirection="row" justifyContent="space-between" alignItems={vector ? 'center' : undefined} columnGap={vector ? 2 : undefined} width={columns}>
        <Box flexShrink={1} flexGrow={1} minWidth={0}>
          {header}
        </Box>
        {headerRight !== null && (
          <Box key="header-right" flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {headerRight}
          </Box>
        )}
      </Box>
    )
    // The header on vector surfaces: a mark, what is happening in bold, then the rest dim.
    const headline = (mark: RenderChildren, lead: string, rest: string, look: { color?: string; isRestPlain?: boolean } = {}) => (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {mark}
        <Text wrap="truncate-end">
          <Text bold color={look.color}>
            {fit(lead, headerWidth - 3).trimEnd()}
          </Text>
          <Text dimColor={!look.isRestPlain}>{fit(rest, Math.max(0, headerWidth - 3 - widthOf(lead))).trimEnd()}</Text>
        </Text>
      </Box>
    )

    const tourStep = isEnabled && list === null ? await read($, tourAtom) : null
    if (tourStep !== null) {
      const isLast = tourStep === TOUR.length - 1
      if (vector) {
        return withBeneath(
          <Box flexDirection="column" width={columns}>
            <Box flexDirection="row" gap={1} width={columns}>
              {kit.icon('spark', 'active', 'Welcome')}
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Text bold>Welcome to GlanceFlow</Text>
                <Text wrap="wrap">{TOUR[tourStep]}</Text>
                <Box key="tour" flexDirection="row" alignItems="center" justifyContent="space-between" gap={2} marginTop={1}>
                  <Box flexDirection="row" alignItems="center" gap={1}>
                    <Button key="tour-next" variant="primary" label={isLast ? 'Got it' : 'Next'} onPress={() => stepTour($, tourStep + 1)} />
                    {!isLast && <Button key="tour-skip" label="Skip" onPress={() => stepTour($, null)} />}
                    <Box alignItems="center" marginLeft={1}>
                      {kit.dots(TOUR.length, tourStep)}
                    </Box>
                  </Box>
                  <Box flexDirection="row" alignItems="center" columnGap={1}>
                    {action('history', 'history', 'History', () => showHistory($, dayKey(current), true))}
                    {action('settings', 'sliders', 'Settings', () => showSettings($))}
                  </Box>
                </Box>
              </Box>
            </Box>
            {warnings}
          </Box>,
        )
      }
      return withBeneath(
        <Box flexDirection="column" width={columns}>
          <Text bold wrap="truncate-end">{`Welcome to GlanceFlow · ${tourStep + 1} of ${TOUR.length}`}</Text>
          <Text wrap="wrap">{TOUR[tourStep]}</Text>
          <Box key="tour" flexDirection="row" gap={2} marginBottom={1}>
            <Button key="tour-next" plain label={isLast ? '✓ Got it' : 'Next ▶'} onPress={() => stepTour($, tourStep + 1)} />
            {!isLast && <Button key="tour-skip" plain label="Skip" onPress={() => stepTour($, null)} />}
          </Box>
          {warnings}
          {actions}
        </Box>,
      )
    }

    if (list === null) {
      const hint = vector ? 'Ask Claude for something, and its plan shows here' : 'Ask Claude for something: its plan shows here'
      if (vector && isEnabled) {
        // Nothing to show yet: one quiet row, the hint on the left and the ways in on the right.
        return withBeneath(
          <Box flexDirection="column" width={columns}>
            <Box key="header" flexDirection="row" alignItems="center" justifyContent="space-between" gap={2} width={columns}>
              <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0}>
                {kit.icon('plan', 'quiet', 'No plan yet')}
                <Text dimColor wrap="truncate-end">
                  {hint}
                </Text>
              </Box>
              <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
                {action('history', 'history', 'History', () => showHistory($, dayKey(current), true))}
                {action('settings', 'sliders', 'Settings', () => showSettings($))}
                <Box marginLeft={1}>{button}</Box>
              </Box>
            </Box>
            {warnings}
          </Box>,
        )
      }
      return withBeneath(
        <Box flexDirection="column" width={columns}>
          {row(
            !isEnabled ? (
              vector ? (
                <Text dimColor wrap="truncate-end">
                  GlanceFlow is off: Claude Code shows everything as usual
                </Text>
              ) : (
                <Text> </Text>
              )
            ) : vector ? (
              <Box flexDirection="row" alignItems="center" gap={1}>
                {kit.icon('plan', 'quiet', 'No plan yet')}
                <Text dimColor wrap="truncate-end">
                  {fit(hint, headerWidth - 3).trimEnd()}
                </Text>
              </Box>
            ) : (
              <Text dimColor wrap="truncate-end">
                {fit(hint, headerWidth).trimEnd()}
              </Text>
            ),
          )}
          {warnings}
          {actions}
        </Box>,
      )
    }

    const elapsed = (vector ? durationWords : formatDuration)((list.finishedAt ?? current) - list.startedAt)
    // A paused or stopped job's clock stands still at the moment it stopped.
    const stepClock = list.finishedAt ?? current
    const jobTokens = list.tasks.reduce((sum, one) => sum + one.tokens, list.extraTokens)
    const jobCached = list.tasks.reduce((sum, one) => sum + one.cachedTokens, list.extraCachedTokens)
    const spent = jobCost(list, usage)
    const jobTokenNote = isDetailed
      ? [tokenNote(jobTokens, jobCached), spent === null ? '' : formatCost(spent)].filter(Boolean).join(' · ')
      : ''
    const activeStep = list.tasks.find(one => one.status === 'active')
    // Why Claude stopped, when it isn't working: on vector surfaces it sits beside the current step, so the header keeps
    // to the state and the job's name; with no current step it stays in the header.
    const limitResets = list.phase === 'stuck' && /limit/i.test(list.stuckReason ?? '') ? resetTime(usage.limitResetsAt, current) : null
    const reason =
      list.phase === 'stuck'
        ? // Elsewhere than the terminal a usage limit reads as a short fact, with when it lifts where the app has told us.
          vector && /limit/i.test(list.stuckReason ?? '')
          ? `Usage limit reached · ${limitResets === null ? 'try again later' : `resets ${limitResets}`}`
          : (list.stuckReason ?? FAILING)
        : list.phase === 'stopped'
          ? list.stopKind === 'pause'
            ? 'press Continue to pick up'
            : 'you pressed Esc'
          : ''
    const isReasonOnStep = vector && activeStep !== undefined
    // Both views fill the current step from its time estimate, so the percentage moves before a step is checked off.
    const activeEstimate = activeStep ? stepEstimate(list, activeStep, stepClock).percent : undefined
    const overall = overallProgress(list.tasks, activeEstimate).percent
    let header: RenderChildren
    if (list.phase === 'needsYou') {
      const reason = needsText(list) ?? PERMISSION
      header = vector ? (
        // Bold amber words, not a filled chip: beside the app's buttons a chip reads as one more button.
        headline(kit.badge('bell', 'warn', 'Needs you'), 'Needs you', ` · ${reason}`, { color: TONE.warn, isRestPlain: true })
      ) : (
        <Text wrap="truncate-end">
          <Text bold inverse color="yellow">
            {' Needs you '}
          </Text>
          <Text> {fit(reason, headerWidth - 12).trimEnd()}</Text>
        </Text>
      )
    } else if (list.phase === 'stuck') {
      header = vector ? (
        headline(kit.badge('bang', 'alert', 'Stuck'), 'Stuck', isReasonOnStep ? ` · ${list.title}` : ` · ${reason} · ${list.title}`, { color: TONE.alert })
      ) : (
        <Text wrap="truncate-end" color="yellow" bold={isCalm}>
          {fit(`⚠ Stuck: ${list.stuckReason ?? FAILING}`, headerWidth).trimEnd()}
        </Text>
      )
    } else if (list.phase === 'stopped') {
      const isPause = list.stopKind === 'pause'
      header = vector ? (
        headline(
          kit.badge(isPause ? 'pause' : 'stop', 'quiet', isPause ? 'Paused' : 'Stopped'),
          isPause ? 'Paused' : 'Stopped',
          isReasonOnStep ? ` · ${list.title}` : ` · ${reason} · ${list.title}`,
        )
      ) : (
        <Text wrap="truncate-end" dimColor={!isCalm} bold={isCalm}>
          {fit(
            isPause ? `‖ Paused · press Continue to pick up · ${list.title}` : `■ Stopped · you pressed Esc · ${list.title}`,
            headerWidth,
          ).trimEnd()}
        </Text>
      )
    } else if (list.phase === 'background') {
      const running = list.helpers.filter(one => one.status === 'running').length
      header = vector ? (
        headline(kit.icon('clock', 'active', 'In the background'), 'Still working in the background', ` · ${running} left · ${list.title} · ${elapsed}`)
      ) : (
        <Text wrap="truncate-end" color="cyan" bold={isCalm}>
          {fit(`◷ Still working in the background · ${running} left · ${list.title} · ${elapsed}`, headerWidth).trimEnd()}
        </Text>
      )
    } else if (list.phase === 'done') {
      header = vector ? (
        headline(kit.badge('check', 'ok', 'All done'), 'All done', ` · ${list.title} · took ${elapsed}${jobTokenNote ? ` · ${jobTokenNote}` : ''}`)
      ) : (
        <Text wrap="truncate-end" color="green" bold={isCalm}>
          {fit(`✓ All done · ${list.title} · took ${elapsed}${jobTokenNote ? ` · ${jobTokenNote}` : ''}`, headerWidth).trimEnd()}
        </Text>
      )
    } else {
      // Time left follows the percentage shown, so the two never disagree.
      const left = list.hasPlan ? timeLeft(list, current, activeEstimate) : null
      const hasGrown = list.hasPlan && list.plannedCount > 0 && list.tasks.length > list.plannedCount
      // Time left replaces time spent once there is an estimate. Elsewhere than the terminal the ring shows the
      // percentage, so the words count steps, as the Plan does.
      const stepsDone = list.tasks.filter(one => one.status === 'done').length
      const lead = list.approval === 'waiting' ? 'Plan ready' : 'Working'
      const pieces = [
        list.hasPlan ? (vector ? `${stepsDone} of ${list.tasks.length} done` : `${overall}%`) : '',
        // Elsewhere than the terminal a bare "8s" could read as time left: it says so.
        left === null ? (vector ? `${elapsed} so far` : elapsed) : `about ${formatLeft(left)} left`,
        hasGrown ? `plan grew ${list.plannedCount} → ${list.tasks.length}` : '',
        jobTokenNote,
      ]
      // Elsewhere than the terminal, where the job's name leaves no room for how far it is, the name gives way: the
      // steps are right below it, and the Plan has it.
      const firstPiece = pieces.find(Boolean) ?? ''
      const roomWithTitle = headerWidth - 6 - widthOf(lead) - widthOf(list.title)
      const keepsTitle = !vector || firstPiece === '' || widthOf(` · ${firstPiece}`) <= roomWithTitle
      const detailRoom = !vector ? headerWidth - Math.min(list.title.length, 20) : keepsTitle ? roomWithTitle : headerWidth - 3 - widthOf(lead)
      // Whole pieces drop off the end when there is no room, never half a word.
      const shownDetails = headerDetails(pieces, detailRoom)
      // Elsewhere than the terminal not even the first piece is cut.
      const details = vector && widthOf(shownDetails) > detailRoom ? '' : shownDetails
      header = vector ? (
        // Every state's header reads the same way: its mark, the state in bold, then the job and how far it is.
        headline(
          list.hasPlan ? kit.ring(overall, 0, `${overall}% done`) : kit.ring(null, isCalm ? 0 : tick, 'Working'),
          lead,
          keepsTitle ? ` · ${list.title}${details}` : details,
        )
      ) : (
        <Text wrap="truncate-end">
          <Text bold>{fit(list.title, Math.max(8, headerWidth - details.length)).trimEnd()}</Text>
          <Text dimColor>{details}</Text>
        </Text>
      )
    }

    if (list.phase === 'done' && list.isCollapsed) {
      return withBeneath(
        <Box flexDirection="column" width={columns}>
          {row(header)}
          {warnings}
          {actions}
        </Box>,
      )
    }

    // Name column: whatever the row leaves after mark, meter and label, so rows never wrap.
    const hasMeter = columns >= METER_MIN_COLUMNS
    const bar = (cells: string) => (hasMeter ? ` ${cells} ` : ' ')
    const nameWidth = Math.max(4, Math.min(MAX_NAME, columns - 2 - 2 - (hasMeter ? METER + 2 : 1) - LABEL_WIDTH - 1))
    const room = Math.max(1, e.props.maxRows - 1 - warnings.length - (actions ? 1 : 0))
    const firstUpcoming = list.tasks.findIndex(one => one.status === 'upcoming')
    // What is left of the row after mark, name, meter and label: the step's tokens, when they fit.
    const usageRoom = columns - 2 - nameWidth - (hasMeter ? METER + 2 : 1) - LABEL_WIDTH - 1
    const noteOf = (one: GlanceTask) => {
      let timeNote = ''
      if (one.status === 'done' && one.startedAt !== null && one.finishedAt !== null) {
        timeNote = `took ${(vector ? durationWords : formatDuration)(one.finishedAt - one.startedAt)}`
      } else if (one.status === 'active') {
        const estimate = stepEstimate(list, one, stepClock)
        // Elsewhere than the terminal the band gives the step's time left alone; the Plan keeps the time spent too.
        timeNote = vector ? leftLabel(estimate.leftMs, true) : `${formatDuration(estimate.elapsedMs)} · ${leftLabel(estimate.leftMs)}`
      }
      return isDetailed ? [timeNote, tokenNote(one.tokens, one.cachedTokens)].filter(Boolean).join(' · ') : ''
    }
    const usageCell = (one: GlanceTask) => {
      const note = noteOf(one)
      return note && usageRoom >= 12 ? <Text dimColor>{` ${fit(note, usageRoom - 1).trimEnd()}`}</Text> : null
    }
    // A step on vector surfaces: its mark and name, then, dim, what it is doing or got done; in Details its time and
    // tokens keep to a column on the right. A step whose mark says it all gets no word of its own.
    // Its time follows it inline, as a finished step's does. When the row runs short the tail gives way first (it
    // shrinks a hundred times faster than the name), and the time is never cut.
    // What follows the name reads as the header does: parts joined by " · " with no wider gap before the dot (the
    // spaces are no-break ones, which the app keeps at the start of a part), the bar standing in for the first.
    const join = (words: string) => `\u00a0·\u00a0${words}`
    const step = (key: string, mark: RenderChildren, name: RenderChildren, tail: string, extra?: RenderChildren, note = '') => (
      <Box key={key} flexDirection="row" alignItems="center" width={columns}>
        {mark}
        <Box flexShrink={1} minWidth={0} marginLeft={1}>
          {name}
        </Box>
        {extra && <Box marginLeft={1}>{extra}</Box>}
        {tail !== '' && (
          <Box key="tail" flexShrink={100} minWidth={0} marginLeft={extra ? 1 : 0}>
            <Text dimColor wrap="truncate-end">
              {extra ? tail : join(tail)}
            </Text>
          </Box>
        )}
        {note !== '' && (
          <Box key="note" flexShrink={0} marginLeft={tail === '' && extra ? 1 : 0}>
            <Text dimColor>{tail === '' && extra ? note : join(note)}</Text>
          </Box>
        )}
      </Box>
    )
    // A line under a step, in line with the step names: what it got done, what Claude is doing, what is out of view.
    const under = (key: string, text: string) =>
      vector ? (
        line(
          key,
          kit.blank('Detail'),
          <Text dimColor wrap="truncate-end">
            {text}
          </Text>,
        )
      ) : (
        <Box key={key} flexDirection="row">
          <Text dimColor wrap="truncate-end">
            {fit(`    ${text}`, Math.max(0, columns - 1)).trimEnd()}
          </Text>
        </Box>
      )
    const lastStepId = list.tasks[list.tasks.length - 1]?.id
    const stepIds = new Set(list.tasks.map(one => one.id))
    const helpersOf = (stepId: string) =>
      list.helpers
        .filter(one => one.stepId === stepId || (stepId === lastStepId && !stepIds.has(one.stepId)))
        // Running first, then the latest finished.
        .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'))
        .slice(0, HELPERS_PER_STEP)

    // What the step that just finished got done, until Claude's next activity takes the line.
    // Steps checked off together finish at the same moment: the latest in the plan wins.
    const justDone = list.tasks
      .filter(one => one.status === 'done' && one.finishedAt !== null)
      .reverse()
      .sort((a, b) => b.finishedAt! - a.finishedAt!)[0]
    const showsSummary = (list.phase === 'working' || list.phase === 'done') && list.activity === null && Boolean(justDone?.summary)

    // A long plan folds its finished steps, and the steps after the next one, into a line each.
    const isCompact = list.tasks.length > COMPACT_AFTER
    const doneSteps = list.tasks.filter(one => one.status === 'done')
    const foldsDone = isCompact && doneSteps.length >= 2
    const laterSteps = list.tasks.filter((one, index) => one.status === 'upcoming' && index !== firstUpcoming)
    const foldsLater = isCompact && laterSteps.length >= 2
    // Where the current step stands: the word says when Claude isn't working on it.
    const standing =
      list.phase === 'needsYou'
        ? { mark: '‖ ', label: 'Waiting', icon: 'bell' as const, tone: 'warn' as const }
        : list.phase === 'stuck'
          ? { mark: '⚠ ', label: 'Stuck', icon: 'bang' as const, tone: 'alert' as const }
          : list.phase === 'stopped'
            ? list.stopKind === 'pause'
              ? { mark: '‖ ', label: 'Paused', icon: 'pause' as const, tone: 'quiet' as const }
              : { mark: '■ ', label: 'Stopped', icon: 'stop' as const, tone: 'quiet' as const }
            : null

    // Every line: each step, then the helpers working under it.
    // `steps`: how many plan steps a line stands for (a folded line stands for several).
    const lines: { key: string; isActive: boolean; element: RenderChildren; steps?: number }[] = []
    list.tasks.forEach((one, index) => {
      const key = `task-${index}`
      if (one.status === 'done' && foldsDone) {
        if (one !== doneSteps[0]) return
        const words = `${doneSteps.length} steps done`
        lines.push({
          key,
          steps: doneSteps.length,
          isActive: false,
          element: vector ? (
            // A summary of steps, not a step: its own quiet mark, so the tick and the ring stay for real steps.
            step(
              key,
              kit.icon('more', 'quiet', 'Folded'),
              <Text dimColor wrap="truncate-end">
                {words}
              </Text>,
              '',
            )
          ) : (
            <Box key={key} flexDirection="row">
              <Text color="green">✓ </Text>
              <Text dimColor>{fit(words, nameWidth)}</Text>
              <Text color="green">{bar('█'.repeat(METER))}</Text>
              <Text dimColor>{fit('Done', LABEL_WIDTH)}</Text>
            </Box>
          ),
        })
        // A summary under a folded group would hang under the wrong line: the terminal keeps it, elsewhere it goes.
        if (showsSummary && justDone && !vector) {
          lines.push({ key: 'summary', isActive: false, element: under('summary', justDone.summary!) })
        }
        return
      }
      if (one.status === 'upcoming' && foldsLater && index !== firstUpcoming) {
        if (one !== laterSteps[0]) return
        // Elsewhere than the terminal the row says where the rest are.
        const words = vector ? `${laterSteps.length} more steps in Plan` : `${laterSteps.length} more steps`
        lines.push({
          key,
          steps: laterSteps.length,
          isActive: false,
          element: vector ? (
            step(
              key,
              kit.icon('more', 'quiet', 'Folded'),
              <Text dimColor wrap="truncate-end">
                {words}
              </Text>,
              '',
            )
          ) : (
            <Box key={key} flexDirection="row">
              <Text dimColor>○ </Text>
              <Text dimColor>{fit(words, nameWidth)}</Text>
              <Text dimColor>{bar('░'.repeat(METER))}</Text>
              <Text dimColor>Later</Text>
            </Box>
          ),
        })
        return
      }
      if (one.status === 'done') {
        lines.push({
          key,
          isActive: false,
          element: vector ? (
            step(
              key,
              kit.icon('done', 'ok', 'Done'),
              <Text dimColor wrap="truncate-end">
                {one.name}
              </Text>,
              // Its time follows it, dim: kept to the far right it read as the time left.
              [showsSummary && one === justDone ? one.summary! : '', noteOf(one)].filter(Boolean).join(' · '),
            )
          ) : (
            <Box key={key} flexDirection="row">
              <Text color="green">✓ </Text>
              <Text dimColor>{fit(one.name, nameWidth)}</Text>
              <Text color="green">{bar('█'.repeat(METER))}</Text>
              <Text dimColor>{fit('Done', LABEL_WIDTH)}</Text>
              {usageCell(one)}
            </Box>
          ),
        })
        if (showsSummary && one === justDone && !vector) {
          lines.push({ key: 'summary', isActive: false, element: under('summary', one.summary!) })
        }
      } else if (one.status === 'active') {
        // The details view fills the bar gradually from the time estimate; the simple view sweeps until Claude reports.
        const shownPercent = isDetailed ? stepEstimate(list, one, stepClock).percent : one.percent
        // Elsewhere than the terminal a bar shows only while Claude works on the step: a frozen one says nothing.
        const hasPercent = (isDetailed || one.hasReported) && !(vector && standing !== null)
        const label = standing?.label ?? (hasPercent ? `${shownPercent}%` : 'Working')
        // Only a step Claude is working on moves; one that waits on you or has stopped stands still.
        const isStill = isCalm || standing !== null
        let element: RenderChildren
        if (vector && list.approval === 'waiting') {
          // Nothing has started while the plan waits for Start: the first step is one more to come, and the amber of
          // the header is the only call on you.
          element = step(key, kit.open('Next'), <Text wrap="truncate-end">{one.name}</Text>, '')
        } else if (vector) {
          // The bar shows how far the step is, so no number stands beside it; a step that waits on you or has stopped
          // goes grey, the header saying why. With no progress reported yet there is no bar, only what Claude is
          // doing, in its own words when they fit.
          const activity = list.phase === 'working' ? list.activity : null
          const doing =
            activity === null
              ? ''
              : activity.detail !== null && widthOf(activity.detail) <= 48
                ? activity.detail
                : `${activity.label}${activity.count > 1 ? ` (${activity.count})` : ''}`
          // Before Claude reports how far it is, a short bar travels along the track: the row reads as every working
          // row does, and no word repeats the header. A calm screen keeps still, so it shows no bar then.
          const isSweeping = standing === null && !hasPercent && !isCalm
          const tail = isReasonOnStep && reason !== '' ? reason.charAt(0).toUpperCase() + reason.slice(1) : doing
          const note = noteOf(one)
          // A few letters of what Claude is doing say nothing: it shows only where a dozen or more fit. Why the step
          // stopped always shows; the header no longer says it.
          const tailRoom = columns - 3 - widthOf(one.name) - (hasPercent || isSweeping ? 10 : 0) - (note !== '' ? widthOf(note) + 3 : 0)
          element = step(
            key,
            kit.badge(standing?.icon ?? 'play', standing?.tone ?? 'active', label),
            <Text bold wrap="truncate-end">
              {one.name}
            </Text>,
            tailRoom >= 14 || (isReasonOnStep && reason !== '') ? tail : '',
            hasPercent || isSweeping ? (
              <Box key="state" flexDirection="row" alignItems="center" flexShrink={0}>
                {hasPercent
                  ? kit.meter('active', shownPercent, 0, label, 72)
                  : kit.meter('active', null, ((tick % 12) + 0.5) / 12, label, 72)}
              </Box>
            ) : undefined,
            note,
          )
        } else {
          const filled = Math.round(shownPercent / 10)
          const sweepAt = tick % (METER + 3)
          const meter = hasPercent
            ? '█'.repeat(filled) + '░'.repeat(METER - filled)
            : isStill
              ? '░'.repeat(METER)
              : Array.from({ length: METER }, (_, cell) => (cell >= sweepAt - 2 && cell <= sweepAt ? '█' : '░')).join('')
          element = (
            <Box key={key} flexDirection="row">
              <Text color={standing?.label === 'Stuck' ? 'yellow' : 'cyan'}>{standing?.mark ?? '▶ '}</Text>
              <Text bold>{fit(one.name, nameWidth)}</Text>
              <Text color="cyan">{bar(meter)}</Text>
              <Text>{fit(label, LABEL_WIDTH)}</Text>
              {usageCell(one)}
            </Box>
          )
        }
        lines.push({ key, isActive: true, element })
        // What Claude is doing right now, in plain words: a line of its own on the terminal; elsewhere it follows the bar.
        if (list.phase === 'working' && list.activity !== null && !vector) {
          const { label: doing, count, detail } = list.activity
          const plain = `${doing}${count > 1 ? ` (${count})` : ''}`
          // Claude's own sentence when it fits the line whole; otherwise the short plain label, never a cut sentence.
          const sentence = detail !== null && widthOf(`    Now: ${detail}`) <= columns - 1 ? `Now: ${detail}` : plain
          lines.push({ key: 'activity', isActive: false, element: under('activity', sentence) })
        }
      } else {
        const label = index === firstUpcoming ? 'Next' : 'Later'
        lines.push({
          key,
          isActive: false,
          element: vector ? (
            step(key, kit.open(label), <Text wrap="truncate-end">{one.name}</Text>, '')
          ) : (
            <Box key={key} flexDirection="row">
              <Text dimColor>○ </Text>
              <Text dimColor>{fit(one.name, nameWidth)}</Text>
              <Text dimColor>{bar('░'.repeat(METER))}</Text>
              <Text dimColor>{label}</Text>
            </Box>
          ),
        })
      }
      for (const helper of helpersOf(one.id).filter(helper => !(foldsDone && one.status === 'done') || helper.status === 'running')) {
        const helperKey = `helper-${helper.id}`
        // Say "in the background" once: not when the task's own name already does.
        const kindLabel =
          helper.kind === 'background'
            ? /background/i.test(helper.label)
              ? null
              : 'in the background'
            : helper.type === 'general-purpose'
              ? 'helper'
              : helper.type
        const details = (
          isDetailed
            ? [
                kindLabel,
                helper.model,
                helper.effort ? `${helper.effort} effort` : null,
                helper.tokens > 0 ? `${formatTokens(helper.tokens)} tokens` : null,
              ]
            : [kindLabel]
        )
          .filter(Boolean)
          .join(' · ')
        const isRunning = helper.status === 'running'
        if (vector) {
          lines.push({
            key: helperKey,
            isActive: isRunning,
            element: line(
              helperKey,
              kit.blank('Helper'),
              <Box flexDirection="row" alignItems="center" gap={1}>
                {isRunning
                  ? kit.ring(null, isCalm ? 0 : tick, 'Running', 13)
                  : helper.status === 'failed'
                    ? kit.badge('close', 'alert', 'Failed', 13)
                    : kit.badge('check', 'ok', 'Done', 13)}
                <Text wrap="truncate-end">
                  <Text dimColor={!isRunning}>{helper.label}</Text>
                  {details !== '' && <Text dimColor>{` · ${details}`}</Text>}
                </Text>
              </Box>,
            ),
          })
          continue
        }
        const icon = isRunning ? (isCalm ? '◐' : SPINNER[tick % SPINNER.length]!) : helper.status === 'failed' ? '✗' : '✓'
        // The whole row is the description's: "in the background" and the details go first when it is short of room.
        const room = Math.max(4, columns - 7)
        const hasRoom = details !== '' && widthOf(helper.label) + 1 + widthOf(details) <= room
        lines.push({
          key: helperKey,
          isActive: isRunning,
          element: (
            <Box key={helperKey} flexDirection="row">
              <Text dimColor>{'  ↳ '}</Text>
              <Text color={isRunning ? 'cyan' : helper.status === 'failed' ? 'red' : 'green'}>{`${icon} `}</Text>
              <Text dimColor={!isRunning} wrap="truncate-end">
                {hasRoom ? helper.label : fit(helper.label, room).trimEnd()}
              </Text>
              {hasRoom && <Text dimColor wrap="truncate-end">{` ${details}`}</Text>}
            </Box>
          ),
        })
      }
    })

    // Window the lines so the current step (and what runs under it) stays in view,
    // and say how many steps are out of view.
    const focus = Math.max(0, lines.findIndex(one => one.isActive))
    // One line of context above the current step when there is room for it.
    const windowAt = (size: number) => Math.min(Math.max(0, focus - (size > 2 ? 1 : 0)), Math.max(0, lines.length - size))
    const stepsIn = (from: number, to: number) =>
      lines.slice(from, to).reduce((sum, one) => sum + (one.key.startsWith('task-') ? (one.steps ?? 1) : 0), 0)
    const isCut = stepsIn(0, windowAt(room)) + stepsIn(windowAt(room) + room, lines.length) > 0
    // The "more steps" line needs a row of its own; with a single row the current step wins.
    const shown = isCut && room > 1 ? room - 1 : room
    const first = windowAt(shown)
    const above = stepsIn(0, first)
    const below = stepsIn(first + shown, lines.length)
    const rows = lines.slice(first, first + shown).map(one => one.element)
    if (above + below > 0 && shown < room) {
      const more = [above > 0 ? `${above} earlier` : '', below > 0 ? `${below} more ${below === 1 ? 'step' : 'steps'}` : '']
        .filter(Boolean)
        .join(' · ')
      rows.push(
        vector ? (
          under('more', more)
        ) : (
          <Text key="more" dimColor wrap="truncate-end">
            {`  … ${more}`}
          </Text>
        ),
      )
    }

    return withBeneath(
      <Box flexDirection="column" width={columns}>
        {row(header)}
        {rows}
        {warnings}
        {actions}
      </Box>,
    )
  })
}
