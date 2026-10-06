import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderChildren, RenderSurface, Timer } from 'claude-code'

import type {
  GlanceChecklist,
  GlanceHelper,
  GlanceHistoryEntry,
  GlanceTask,
  GlanceTaskSize,
  GlanceUsage,
} from '../types'
import {
  HISTORY_PREFIX,
  clockTime,
  dayFromArgument,
  dayKey,
  entryFromChecklist,
  expiredHistoryKeys,
  longDay,
  projectName,
  shiftDay,
  teamReport,
  upsertEntry,
} from './history'
import { findSecrets, maskPrivate } from './privacy'

const PLUGIN = 'glance'
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
const HANDOFF_KEY = 'lastHandoff'
const MAX_NAME = 40
const METER = 10
const LABEL_WIDTH = 7
const TICK_MS = 250
const COLLAPSE_MS = 5000
const RESEND_WINDOW_MS = 2 * 60 * 1000
const LIMIT_WARN = 80
const LIMIT_ALERT = 95
const LONG_CHAT = 75
const SIZE_WEIGHT: Record<GlanceTaskSize, number> = { S: 1, M: 2, L: 3 }
const LIMIT_LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', spend_limit: 'spending' }

const DENIED = 'you said no to a step, so Claude paused'
const FAILING = 'a step keeps failing, Claude is trying another way'
const PERMISSION = "Answer Claude's request in the chat"
const QUESTION = "Answer Claude's question in the chat"
const WAITING = 'Reply to Claude in the box below'

const enabledAtom = atom({ plugin: 'glance', key: 'glanceEnabled' } as const, true)
const detailAtom = atom({ plugin: 'glance', key: 'detailLevel' } as const, 'simple')
const checklistAtom = atom({ plugin: 'glance', key: 'checklist' } as const, null)
const tickAtom = atom({ plugin: 'glance', key: 'tick' } as const, 0)
const NO_USAGE: GlanceUsage = { limits: [], limitPercent: null, limitLabel: null, contextPercent: null }
const usageAtom = atom({ plugin: 'glance', key: 'usage' } as const, NO_USAGE)
const historyAtom = atom({ plugin: 'glance', key: 'historyView' } as const, null)
const HISTORY_PANE = 'glance-history'
const handoffAtom = atom({ plugin: 'glance', key: 'handoffState' } as const, 'idle')
const HANDOFF_CONFIRM_MS = 8000
// What the Continue button sends, as the person's own words; turn.start knows it and keeps the job going.
const CONTINUE_TEXT = 'Please continue where you left off.'
const HANDOFF_PROMPT = `Write a handoff note so a brand-new chat can carry on this work without this conversation.
Cover, briefly: the goal; what is already done; what is left, in order; decisions made and why; the files, commands
or links that matter; and the very next step. Under 300 words, no preamble.
Start with exactly: "Continuing from an earlier chat. Here is where things stand:"`

const PROMPT_SECTION = `# Glance (progress checklist)
The person follows your work on a checklist above the prompt, in plain English.
- A question you can answer straight away, with no tools, needs no plan: just answer.
- Before you use any other tool, call plan_steps (tool ${PLAN_TOOL}) with 2 to 8 steps in order. If it is deferred, load it with ToolSearch first. If this session has TodoWrite or TaskCreate you may use that to-do list as the plan instead.
- Give each step a size in plan_steps' sizes list, in the same order: S (a few minutes), M, or L (the biggest pieces of work).
- Then call report_progress (tool ${PROGRESS_TOOL}) as real progress happens, and with percent 100 the moment a step finishes.
- Write every step name in plain English a non-technical person understands, under 40 characters, starting with a verb, like "Build the pricing section".
- Never put file paths, file names, commands, code or tool names in a step name.`

const CODE_FILE =
  /\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kts?|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|bash|json|ya?ml|toml|css|scss|sass|less|html?|md|mdx|sql|vue|svelte|lock|env|xml|ini|cfg|conf|txt|csv|log)\W*$/i

/** Turns any step or job name into short plain English. */
export function cleanName(raw: unknown): string {
  const words = maskPrivate(String(raw ?? ''))
    .replace(/`[^`]*`/g, ' ')
    .replace(/`/g, ' ')
    .split(/\s+/)
    .filter(word => word && !word.includes('•') && !/[/\\]/.test(word) && !CODE_FILE.test(word))
  let name = words.join(' ').replace(/\s+/g, ' ').trim()
  if (!name) {
    return 'Working on it'
  }
  name = name.charAt(0).toUpperCase() + name.slice(1)
  if (name.length <= MAX_NAME) {
    return name
  }
  const cut = name.slice(0, MAX_NAME - 1)
  const space = cut.lastIndexOf(' ')

  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–]+$/, '')}…`
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
  return { id, name, status, percent: status === 'done' ? 100 : 0, hasReported: status === 'done', size, tokens: 0, cachedTokens: 0, startedAt: null, finishedAt: null }
}

/** Token counts move to the new plan's step of the same name; the rest go to its first step, so the job total holds. */
export function carryTokens(old: GlanceTask[], next: GlanceTask[]): GlanceTask[] {
  const used = new Set<string>()
  const carried = next.map(one => {
    const same = old.find(before => before.name === one.name && !used.has(before.id))
    if (!same) return one
    used.add(same.id)
    return { ...one, tokens: same.tokens, cachedTokens: same.cachedTokens }
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

// A step of size M is expected to take 3 minutes until this job's own pace is known.
const DEFAULT_UNIT_MS = 90_000

/**
 * How far along the current step looks: time spent against the time this job's finished steps took per
 * unit of size. It fills gradually, stays below 100 until the step is checked off, and never falls below
 * what Claude reported.
 */
export function stepEstimate(list: GlanceChecklist, one: GlanceTask, at: number) {
  const done = list.tasks.filter(
    step => step.status === 'done' && step.startedAt !== null && step.finishedAt !== null && step.finishedAt > step.startedAt,
  )
  const units = done.reduce((sum, step) => sum + SIZE_WEIGHT[step.size], 0)
  const spent = done.reduce((sum, step) => sum + (step.finishedAt! - step.startedAt!), 0)
  const expected = Math.max(10_000, (units > 0 ? spent / units : DEFAULT_UNIT_MS) * SIZE_WEIGHT[one.size])
  const elapsedMs = one.startedAt === null ? 0 : Math.max(0, at - one.startedAt)
  const estimate = Math.min(95, Math.round((100 * elapsedMs) / expected))
  const percent = Math.min(99, Math.max(one.hasReported ? one.percent : 0, estimate))
  const leftMs = percent > 0 ? (elapsedMs * (100 - percent)) / percent : expected

  return { percent, elapsedMs, leftMs }
}

function leftLabel(ms: number): string {
  return ms < 60_000 ? '<1m left' : `~${formatLeft(ms)} left`
}

/** Time left at this job's own pace since the plan; nothing until two steps are done. */
export function timeLeft(list: GlanceChecklist, at: number): number | null {
  const { doneCount, work } = overallProgress(list.tasks)
  if (list.planAt === null || doneCount < 2 || work <= 0 || work >= 1) return null

  return Math.round(((at - list.planAt) / work) * (1 - work))
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
        label: cleanName(one.description),
        type: one.type,
        model: null,
        effort: null,
        status: 'running',
        tokens: 0,
      }),
    )

  return [...kept, ...added]
}

function isBusy(list: GlanceChecklist): boolean {
  return list.helpers.some(one => one.status === 'running')
}

/** The person's own words: notes an app adds around a prompt (<system-reminder>…) are not the request. */
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
let failuresInARow = 0
// A message held back for a password: memory only, never stored, and only to let the same one through on a resend.
let heldMessage: { text: string; at: number } | null = null
let limitLevel = 0
// The main loop's running turn, for the Pause button; and whether a pause asked for its end.
let runningTurn: string | undefined
let isPausing = false

const now = ($: $) => $.clock.now()

const syncTicker = ($: $, list: GlanceChecklist | null) => {
  const isAnimated = list !== null && (list.phase === 'working' || list.phase === 'needsYou' || list.phase === 'background')
  if (isAnimated && ticker === undefined) {
    ticker = $.clock.every(TICK_MS, () => void update($, tickAtom, tick => (tick ?? 0) + 1))
  }
  if (!isAnimated && ticker !== undefined) {
    ticker.cancel()
    ticker = undefined
  }
}

const change = async ($: $, fn: (list: GlanceChecklist) => GlanceChecklist | null) => {
  const at = await now($)
  const next = await update($, checklistAtom, list => {
    const changed = list ? fn(list) : list
    return changed ? { ...changed, tasks: stampTimes(changed.tasks, at) } : changed
  })
  syncTicker($, next)

  return next
}

const startJob = async ($: $, text: string, jobId: string) => {
  const previous = await read($, checklistAtom)
  const list: GlanceChecklist = {
    title: cleanName(text.split('\n')[0]),
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
    // Work still running from the last job stays in view.
    helpers: (previous?.helpers ?? []).filter(one => one.status === 'running'),
  }
  failuresInARow = 0
  collapse?.cancel()
  await update($, checklistAtom, () => list)
  syncTicker($, list)
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
        'like "Build my landing page". No file names, code, quotes or punctuation. ' +
        `Reply with the name only.\n\nRequest:\n${text.slice(0, 2000)}`,
    })
    if (!answer.isAnswered) {
      return
    }
    const title = cleanName((answer.text.split('\n')[0] ?? '').replace(/["'.]/g, ''))
    await change($, list => (list.jobId === jobId ? { ...list, title } : list))
  } catch {
    // The placeholder title stays.
  }
}

const setWorking = ($: $) =>
  change($, list =>
    list.phase === 'needsYou' || list.phase === 'stuck'
      ? { ...list, phase: 'working', needsYouReason: null, stuckReason: null }
      : list,
  )

const setNeedsYou = ($: $, reason: string) =>
  change($, list =>
    list.phase === 'done' || list.phase === 'stopped' ? list : { ...list, phase: 'needsYou', needsYouReason: reason },
  )

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
  await update($, historyAtom, () => ({ day, project, entries, days, isReportShown: false }))

  return isOpening ? $.ui.open({ id: HISTORY_PANE, title: `History · ${projectName(project)}`, closeOnEscape: true }) : null
}

const showReport = async ($: $, isShown: boolean, text: string, surface: RenderSurface) => {
  await update($, historyAtom, view => (view ? { ...view, isReportShown: isShown } : view))
  if (!isShown) return
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(
    copied.isCopied
      ? 'Team report copied: paste it into Slack, Teams or an email.'
      : 'The report is in the panel: select it there to copy it.',
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
    // Kept in case anything below fails: /glance handoff note puts it back in the prompt box.
    await $.store.set(HANDOFF_KEY, { at: await now($), note })
    try {
      await $.command.run({ command: 'clear', args: '' })
    } catch {
      $.ui.toast("Couldn't clear the chat. Type /glance handoff note to get the handoff note.")
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
    const entries = upsertEntry(await $.store.get(`${HISTORY_PREFIX}${day}`), entryFromChecklist(list, project))
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
    $.ui.toast(`You've used ${Math.round(usage.limitPercent)}% of your ${usage.limitLabel ?? ''} limit`.replace('  ', ' '))
  }
  limitLevel = level
}

const setEnabled = async ($: $, isEnabled: boolean) => {
  await update($, enabledAtom, () => isEnabled)
  await $.store.set(STORE_KEY, isEnabled)
  $.ui.toast(isEnabled ? 'Glance is on: tool details are hidden' : 'Glance is off: showing everything')
}

/** The one button: Simple → Details → Off → Simple. */
const cycleMode = async ($: $, isEnabled: boolean, isDetailed: boolean) => {
  const nextEnabled = !(isEnabled && isDetailed)
  const nextDetailed = isEnabled && !isDetailed
  await update($, enabledAtom, () => nextEnabled)
  await update($, detailAtom, () => (nextDetailed ? 'detailed' : 'simple'))
  await $.store.set(STORE_KEY, nextEnabled)
  await $.store.set(DETAIL_KEY, nextDetailed ? 'detailed' : 'simple')
  $.ui.toast(
    !nextEnabled
      ? 'Glance is off: showing everything'
      : nextDetailed
        ? 'Glance details: models, time, tokens, cache and plan usage'
        : 'Glance simple: just the steps and progress',
  )
}

const setDetail = async ($: $, isDetailed: boolean) => {
  await update($, detailAtom, () => (isDetailed ? 'detailed' : 'simple'))
  await $.store.set(DETAIL_KEY, isDetailed ? 'detailed' : 'simple')
  $.ui.toast(
    isDetailed ? 'Details on: models, tokens, cache and plan usage' : 'Details off: just the steps and progress',
  )
}

export function registerGlance(on: On): void {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)
    await update($, enabledAtom, () => stored !== false)
    const detail = await $.store.get(DETAIL_KEY)
    await update($, detailAtom, () => (detail === 'detailed' ? 'detailed' : 'simple'))
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
        },
        required: ['task', 'percent'],
      },
    })
    await $.command.register({
      name: 'glance',
      description:
        'Glance: /glance on|off, details on|off, pause, continue, history [yesterday|YYYY-MM-DD], handoff',
    })
    // The name Glance had before, kept so old habits still work.
    await $.command.register({ name: 'simple', description: 'Same as /glance' })
    // A reload drops the module's timers; pick the animation back up.
    syncTicker($, await read($, checklistAtom))

    return next(e)
  })

  on('command.run', { command: ['glance', 'simple'] }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg.startsWith('history')) {
      const day = dayFromArgument(arg.slice('history'.length), await now($))
      if (day === null) {
        return { text: 'Try /glance history, /glance history yesterday or /glance history 2026-10-06.' }
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

      return { text: isDetailed ? 'Glance details are on.' : 'Glance details are off.' }
    }
    const isEnabled = arg === 'on' ? true : arg === 'off' ? false : !(await read($, enabledAtom))
    await setEnabled($, isEnabled)

    return { text: isEnabled ? 'Glance is on.' : 'Glance is off.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, enabledAtom))) {
      return composed
    }

    return {
      sections: [...composed.sections, { id: `${PLUGIN}:checklist`, text: PROMPT_SECTION, scope: 'session' as const }],
    }
  })

  // Passwords and keys pasted into a message stay on this computer unless sent twice.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') {
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

    return { drop: 'The message looked like it held a password or key, so Glance held it back.' }
  })

  on('session.measure', async ($, e, next) => {
    const top = [...e.rateLimits].sort((a, b) => b.percentUsed - a.percentUsed)[0]
    await measureUsage($, {
      limits: e.rateLimits.map(one => ({ label: LIMIT_LABEL[one.kind] ?? one.kind, percent: one.percentUsed })),
      limitPercent: top ? top.percentUsed : null,
      limitLabel: top ? (LIMIT_LABEL[top.kind] ?? top.kind) : null,
      contextPercent: e.context.percent ?? null,
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

  // The footer keeps progress in view even when the checklist is shrunk.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const list = (await read($, enabledAtom)) ? await read($, checklistAtom) : null
    if (list !== null && list.phase === 'background') {
      const running = list.helpers.filter(one => one.status === 'running').length
      return next({ ...e, props: { ...e.props, modes: [`◷ ${running} in background`, ...e.props.modes] } })
    }
    if (list === null || !list.hasPlan || list.phase === 'done' || list.phase === 'stopped') {
      return next(e)
    }
    const left = timeLeft(list, await now($))
    const label = `◎ ${overallProgress(list.tasks).percent}%${left === null ? '' : ` · ~${formatLeft(left)}`}`

    return next({ ...e, props: { ...e.props, modes: [label, ...e.props.modes] } })
  })

  // Subagents: what they work on and which model, under the step that started them.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId !== undefined && e.parentAgentId === undefined) {
      await addHelper($, {
        id: started.agentId,
        kind: 'helper',
        label: cleanName(e.description),
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
    const result = yield* next(e)
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
    const text = ownWords(e.text)
    const current = await read($, checklistAtom)
    if (text === CONTINUE_TEXT && current !== null) {
      // The Continue button: the same job picks up again.
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
      if (list === null || list.phase === 'done' || list.phase === 'stopped' || list.phase === 'background') {
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

    if (tool === PLAN_TOOL) {
      const input = e as unknown as { steps?: unknown; sizes?: unknown }
      const steps = (Array.isArray(input.steps) ? input.steps : []).map(cleanName).slice(0, 8)
      const sizes = Array.isArray(input.sizes) ? input.sizes : []
      if (steps.length === 0) {
        return { deny: 'plan_steps needs 2 to 8 step names.' }
      }
      const tasks = settle(steps.map((name, index) => task(name, 'upcoming', `plan#${index}`, sizeOf(sizes[index]))))
      const started = await now($)
      await update($, checklistAtom, (list): GlanceChecklist => ({
        planAt: list?.hasPlan ? (list.planAt ?? started) : started,
        plannedCount: list?.hasPlan ? list.plannedCount : steps.length,
        extraTokens: list?.extraTokens ?? 0,
        extraCachedTokens: list?.extraCachedTokens ?? 0,
        stopKind: null,
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

      return { result: `Planned ${steps.length} steps. The first one has started.` }
    }

    if (tool === PROGRESS_TOOL) {
      const input = e as unknown as { task?: unknown; percent?: unknown }
      const percent = Math.min(100, Math.max(0, Math.round(Number(input.percent) || 0)))
      await change($, list => ({ ...list, tasks: applyProgress(list.tasks, String(input.task ?? ''), percent) }))

      return { result: `Progress noted: ${percent}%.` }
    }

    if (!isMain) {
      return next(e)
    }

    const isEnabled = await read($, enabledAtom)
    const list = await read($, checklistAtom)
    if (isEnabled && !ALWAYS_ALLOWED.has(tool) && !list?.hasPlan) {
      return {
        deny: `Call ${PLAN_TOOL} first to lay out the plan in plain English (load it with ToolSearch if it is deferred), then try again.`,
      }
    }

    if (tool === 'AskUserQuestion') {
      await setNeedsYou($, QUESTION)
    } else if (list?.phase === 'needsYou') {
      await setWorking($)
    }

    const ran = await next(e)

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
    const list = await read($, checklistAtom)
    runningTurn = undefined
    const wasPaused = isPausing
    isPausing = false

    if (list !== null) {
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
        await change($, current => (isBusy(current) ? current : { ...current, phase: 'needsYou', needsYouReason: WAITING }))
      } else {
        await change($, current => ({
          ...current,
          // A quick answer needed no plan: one plain step instead of the placeholders.
          tasks: current.hasPlan ? current.tasks : carryTokens(current.tasks, [task('Answer your question', 'done')]),
        }))
        await change($, current => ({
          ...current,
          phase: 'done',
          needsYouReason: null,
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
  on('ui.render', { component: 'Pane', requestId: HISTORY_PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const view = await read($, historyAtom)
    const columns = Math.max(30, e.props.bodyColumns)
    const today = dayKey(await now($))
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: HISTORY_PANE })} />
    if (view === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Type /glance history to see today's tasks.</Text>
          {close}
        </Box>
      )
    }

    // Day picker: earlier, a drop-down of saved days, later, and today.
    const dayLabel = (day: string) => (day === today ? `Today, ${day}` : day)
    const picker = (
      <Box key="picker" flexDirection="column" marginBottom={1}>
        <Text key="heading" bold wrap="truncate-end">
          {`${projectName(view.project)} · ${longDay(view.day)}`}
        </Text>
        <Box key="controls" flexDirection="row" gap={1}>
        <Button key="earlier" label="◀ Earlier" onPress={() => showHistory($, shiftDay(view.day, -1), false)} />
        {'Select' in table && table.Select ? (
          <table.Select
            key="day"
            label="Day: "
            value={view.day}
            options={view.days.map(day => ({ value: day, label: dayLabel(day) }))}
            onSelect={day => void showHistory($, day, false)}
          />
        ) : (
          <Text bold>{dayLabel(view.day)}</Text>
        )}
        {view.day < today && (
          <Button key="later" label="Later ▶" onPress={() => showHistory($, shiftDay(view.day, 1), false)} />
        )}
        {view.day !== today && <Button key="today" label="Today" onPress={() => showHistory($, today, false)} />}
        </Box>
      </Box>
    )

    const report = teamReport(view)
    if (view.isReportShown) {
      return (
        <Box flexDirection="column" width={columns}>
          {picker}
          {report.split('\n').map((line, index) => (
            <Text key={`report-${index}`} bold={index === 0} wrap="wrap">
              {line || ' '}
            </Text>
          ))}
          <Box key="report-actions" flexDirection="row" gap={1} marginTop={1}>
            <Button key="copy" variant="primary" label="Copy report" onPress={() => showReport($, true, report, e.surface)} />
            <Button key="back" label="Back to the list" onPress={() => showReport($, false, report, e.surface)} />
            {close}
          </Box>
        </Box>
      )
    }

    if (view.entries.length === 0) {
      return (
        <Box flexDirection="column" width={columns}>
          {picker}
          <Text dimColor>No tasks saved for this project on that day yet.</Text>
          {close}
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
    const titleWidth = Math.max(12, Math.min(MAX_NAME, columns - 9 - 36))
    const rows = view.entries.map(one => {
      const [mark, color] = marks[one.outcome]
      const took = one.finishedAt === null ? 'not finished' : formatDuration(one.finishedAt - one.startedAt)
      const details = [`${one.stepsDone}/${one.stepsTotal}`, took, tokenNote(one.newTokens + one.cachedTokens, one.cachedTokens)]
        .filter(Boolean)
        .join(' · ')
      return (
        <Box key={`job-${one.jobId}`} flexDirection="row">
          <Text dimColor>{`${clockTime(one.startedAt)}  `}</Text>
          <Text color={color} dimColor={one.outcome === 'stopped'}>{`${mark} `}</Text>
          <Text bold={one.outcome !== 'stopped'}>{fit(one.title, titleWidth)}</Text>
          <Text dimColor wrap="truncate-end">
            {` ${fit(details, Math.max(0, columns - 9 - titleWidth - 1)).trimEnd()}`}
          </Text>
        </Box>
      )
    })

    const finished = view.entries.filter(one => one.finishedAt !== null)
    const time = finished.reduce((sum, one) => sum + (one.finishedAt! - one.startedAt), 0)
    const newTokens = view.entries.reduce((sum, one) => sum + one.newTokens, 0)
    const cached = view.entries.reduce((sum, one) => sum + one.cachedTokens, 0)
    const counts = (Object.keys(marks) as GlanceHistoryEntry['outcome'][])
      .map(outcome => [outcome, view.entries.filter(one => one.outcome === outcome).length] as const)
      .filter(([, count]) => count > 0)
      .map(([outcome, count]) => `${count} ${outcome}`)
    const total = [
      `${view.entries.length} ${view.entries.length === 1 ? 'task' : 'tasks'}`,
      counts.join(', '),
      formatDuration(time),
      tokenNote(newTokens + cached, cached),
    ]
      .filter(Boolean)
      .join(' · ')

    return (
      <Box flexDirection="column" width={columns}>
        {picker}
        {rows}
        <Box key="total" marginTop={1}>
          <Text bold wrap="truncate-end">{`Total: ${total}`}</Text>
        </Box>
        <Box key="actions" flexDirection="row" gap={1} marginTop={1}>
          <Button key="report" variant="primary" label="Team report" onPress={() => showReport($, true, report, e.surface)} />
          {close}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const isEnabled = await read($, enabledAtom)
    const list = isEnabled ? await read($, checklistAtom) : null
    const tick = list ? await read($, tickAtom) : 0
    const usage = isEnabled ? await read($, usageAtom) : NO_USAGE
    const isDetailed = isEnabled && (await read($, detailAtom)) === 'detailed'
    const handoff = isEnabled ? await read($, handoffAtom) : 'idle'
    const columns = Math.max(20, e.props.bodyColumns)
    const current = await now($)

    // Plan usage, always in view; it turns yellow, then red, as a window fills.
    const warnings: RenderChildren[] = []
    // Last row: open the history, or hand this chat off to a fresh one (a second press confirms).
    const list0 = isEnabled ? await read($, checklistAtom) : null
    const canPause =
      runningTurn !== undefined &&
      list0 !== null &&
      (list0.phase === 'working' || list0.phase === 'needsYou') &&
      list0.needsYouReason !== WAITING
    const canContinue =
      list0 !== null &&
      (list0.phase === 'stopped' || list0.phase === 'stuck' || (list0.phase === 'needsYou' && list0.needsYouReason === WAITING))
    const actions = isEnabled ? (
      <Box key="actions" flexDirection="row" gap={2}>
        {canPause && <Button key="pause" plain label="‖ Pause" onPress={() => pauseJob($)} />}
        {canContinue && <Button key="continue" plain label="▶ Continue" onPress={() => continueJob($)} />}
        <Button key="history" plain label="☰ History" onPress={() => showHistory($, dayKey(current), true)} />
        {list0 !== null && (
        <Button
          key="handoff"
          plain
          label={
            handoff === 'armed'
              ? '↻ Press again to start a fresh chat'
              : handoff === 'working'
                ? '↻ Writing a handoff note…'
                : '↻ Fresh chat'
          }
          onPress={() => pressHandoff($)}
        />
        )}
      </Box>
    ) : null
    const usageParts = [
      ...usage.limits.map(one => `${one.label} ${Math.round(one.percent)}%`),
      usage.contextPercent === null ? '' : `chat ${Math.round(usage.contextPercent)}% full`,
    ].filter(Boolean)
    const top = usage.limitPercent ?? 0
    const isHigh = top >= LIMIT_WARN
    // The simple view speaks up only near a limit; the detailed view always shows usage.
    if (usageParts.length > 0 && (isDetailed || isHigh)) {
      warnings.push(
        <Box key="limit" width={columns}>
          <Text
            wrap="truncate-end"
            color={top >= LIMIT_ALERT ? 'red' : isHigh ? 'yellow' : undefined}
            dimColor={!isHigh}
          >
            {isHigh
              ? `⚠ You've used ${Math.round(top)}% of your ${usage.limitLabel ?? 'plan'} limit · ${usageParts.join(' · ')}`
              : `Plan usage: ${usageParts.join(' · ')}`}
          </Text>
        </Box>,
      )
    }
    if (usage.contextPercent !== null && usage.contextPercent >= LONG_CHAT) {
      warnings.push(
        <Box key="long-chat" flexDirection="row" justifyContent="space-between" width={columns}>
          <Box flexShrink={1}>
            <Text wrap="truncate-end" color="yellow">
              This chat is getting long. Tidying it up keeps Claude quick.
            </Text>
          </Box>
          <Button
            key="compact"
            label="Tidy it up"
            onPress={() =>
              $.session.compact().then(
                done => void (done.skip !== undefined && $.ui.toast('Nothing to tidy up yet.')),
                () => void $.ui.toast("Couldn't tidy up the chat. Type /compact to try again."),
              )
            }
          />
        </Box>,
      )
    }

    // One button for every choice: Simple → Details → Off.
    const button = (
      <Button
        key="toggle"
        label={!isEnabled ? '○ Glance: Off' : isDetailed ? '● Glance: Details' : '● Glance: Simple'}
        variant={isEnabled ? 'primary' : 'secondary'}
        onPress={() => cycleMode($, isEnabled, isDetailed)}
      />
    )
    const headerWidth = Math.max(0, columns - 27)
    const row = (header: RenderChildren) => (
      <Box key="header" flexDirection="row" justifyContent="space-between" width={columns}>
        <Box flexShrink={1} flexGrow={1}>
          {header}
        </Box>
        {button}
      </Box>
    )

    if (list === null) {
      return (
        <Box flexDirection="column" width={columns}>
          {row(
            isEnabled ? (
              <Text dimColor wrap="truncate-end">
                {fit("Ask Claude for something: its plan shows here", headerWidth).trimEnd()}
              </Text>
            ) : (
              <Text> </Text>
            ),
          )}
          {warnings}
          {actions}
        </Box>
      )
    }

    const elapsed = formatDuration((list.finishedAt ?? current) - list.startedAt)
    // A paused or stopped job's clock stands still at the moment it stopped.
    const stepClock = list.finishedAt ?? current
    const jobTokens = list.tasks.reduce((sum, one) => sum + one.tokens, list.extraTokens)
    const jobCached = list.tasks.reduce((sum, one) => sum + one.cachedTokens, list.extraCachedTokens)
    const jobTokenNote = isDetailed ? tokenNote(jobTokens, jobCached) : ''
    let header: RenderChildren
    if (list.phase === 'needsYou') {
      header = (
        <Text wrap="truncate-end">
          <Text bold inverse color="yellow">
            {' Needs you '}
          </Text>
          <Text> {fit(list.needsYouReason ?? PERMISSION, headerWidth - 12).trimEnd()}</Text>
        </Text>
      )
    } else if (list.phase === 'stuck') {
      header = (
        <Text wrap="truncate-end" color="yellow">
          {fit(`⚠ Stuck: ${list.stuckReason ?? FAILING}`, headerWidth).trimEnd()}
        </Text>
      )
    } else if (list.phase === 'stopped') {
      header = (
        <Text wrap="truncate-end" dimColor>
          {fit(
            list.stopKind === 'pause'
              ? `‖ Paused · press Continue to pick up · ${list.title}`
              : `■ Stopped · you pressed Esc · ${list.title}`,
            headerWidth,
          ).trimEnd()}
        </Text>
      )
    } else if (list.phase === 'background') {
      const running = list.helpers.filter(one => one.status === 'running').length
      header = (
        <Text wrap="truncate-end" color="cyan">
          {fit(`◷ Still working in the background · ${running} left · ${list.title} · ${elapsed}`, headerWidth).trimEnd()}
        </Text>
      )
    } else if (list.phase === 'done') {
      header = (
        <Text wrap="truncate-end" color="green">
          {fit(`✓ All done · ${list.title} · took ${elapsed}${jobTokenNote ? ` · ${jobTokenNote}` : ''}`, headerWidth).trimEnd()}
        </Text>
      )
    } else {
      const left = list.hasPlan ? timeLeft(list, current) : null
      const activeStep = list.tasks.find(one => one.status === 'active')
      const activeEstimate = isDetailed && activeStep ? stepEstimate(list, activeStep, stepClock).percent : undefined
      const hasGrown = list.hasPlan && list.plannedCount > 0 && list.tasks.length > list.plannedCount
      // Time left replaces time spent once there is an estimate.
      const details = headerDetails(
        [
          list.hasPlan ? `${overallProgress(list.tasks, activeEstimate).percent}%` : '',
          left === null ? elapsed : `about ${formatLeft(left)} left`,
          hasGrown ? `plan grew ${list.plannedCount} → ${list.tasks.length}` : '',
          jobTokenNote,
        ],
        headerWidth - Math.min(list.title.length, 20),
      )
      header = (
        <Text wrap="truncate-end">
          <Text bold>{fit(list.title, Math.max(8, headerWidth - details.length)).trimEnd()}</Text>
          <Text dimColor>{details}</Text>
        </Text>
      )
    }

    if (list.phase === 'done' && list.isCollapsed) {
      return (
        <Box flexDirection="column" width={columns}>
          {row(header)}
          {warnings}
          {actions}
        </Box>
      )
    }

    // Name column: whatever the row leaves after mark, meter and label, so rows never wrap.
    const nameWidth = Math.max(4, Math.min(MAX_NAME, columns - 2 - 2 - METER - 2 - LABEL_WIDTH - 1))
    const room = Math.max(1, e.props.maxRows - 1 - warnings.length - (actions ? 1 : 0))
    const firstUpcoming = list.tasks.findIndex(one => one.status === 'upcoming')
    // What is left of the row after mark, name, meter and label: the step's tokens, when they fit.
    const usageRoom = columns - 2 - nameWidth - (METER + 2) - LABEL_WIDTH - 1
    const usageCell = (one: GlanceTask) => {
      let timeNote = ''
      if (one.status === 'done' && one.startedAt !== null && one.finishedAt !== null) {
        timeNote = `took ${formatDuration(one.finishedAt - one.startedAt)}`
      } else if (one.status === 'active') {
        const estimate = stepEstimate(list, one, stepClock)
        timeNote = `${formatDuration(estimate.elapsedMs)} · ${leftLabel(estimate.leftMs)}`
      }
      const note = [timeNote, tokenNote(one.tokens, one.cachedTokens)].filter(Boolean).join(' · ')
      return isDetailed && note && usageRoom >= 12 ? <Text dimColor>{` ${fit(note, usageRoom - 1).trimEnd()}`}</Text> : null
    }
    const lastStepId = list.tasks[list.tasks.length - 1]?.id
    const stepIds = new Set(list.tasks.map(one => one.id))
    const helpersOf = (stepId: string) =>
      list.helpers
        .filter(one => one.stepId === stepId || (stepId === lastStepId && !stepIds.has(one.stepId)))
        // Running first, then the latest finished.
        .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'))
        .slice(0, HELPERS_PER_STEP)

    // Every line: each step, then the helpers working under it.
    const lines: { key: string; isActive: boolean; element: RenderChildren }[] = []
    list.tasks.forEach((one, index) => {
      const key = `task-${index}`
      if (one.status === 'done') {
        lines.push({
          key,
          isActive: false,
          element: (
            <Box key={key} flexDirection="row">
              <Text color="green">✓ </Text>
              <Text dimColor>{fit(one.name, nameWidth)}</Text>
              <Text color="green"> {'█'.repeat(METER)} </Text>
              <Text dimColor>{fit('Done', LABEL_WIDTH)}</Text>
              {usageCell(one)}
            </Box>
          ),
        })
      } else if (one.status === 'active') {
        // The details view fills the bar gradually from the time estimate; the simple view sweeps until Claude reports.
        const shownPercent = isDetailed ? stepEstimate(list, one, stepClock).percent : one.percent
        const hasPercent = isDetailed || one.hasReported
        const filled = Math.round(shownPercent / 10)
        const sweepAt = tick % (METER + 3)
        const meter = hasPercent
          ? '█'.repeat(filled) + '░'.repeat(METER - filled)
          : Array.from({ length: METER }, (_, cell) => (cell >= sweepAt - 2 && cell <= sweepAt ? '█' : '░')).join('')
        lines.push({
          key,
          isActive: true,
          element: (
            <Box key={key} flexDirection="row">
              <Text color="cyan">{list.phase === 'needsYou' ? '‖ ' : '▶ '}</Text>
              <Text bold>{fit(one.name, nameWidth)}</Text>
              <Text color="cyan"> {meter} </Text>
              <Text>{fit(hasPercent ? `${shownPercent}%` : 'Working', LABEL_WIDTH)}</Text>
              {usageCell(one)}
            </Box>
          ),
        })
      } else {
        lines.push({
          key,
          isActive: false,
          element: (
            <Box key={key} flexDirection="row">
              <Text dimColor>○ </Text>
              <Text dimColor>{fit(one.name, nameWidth)}</Text>
              <Text dimColor> {'░'.repeat(METER)} </Text>
              <Text dimColor>{index === firstUpcoming ? 'Next' : 'Later'}</Text>
            </Box>
          ),
        })
      }
      for (const helper of helpersOf(one.id)) {
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
        const icon =
          helper.status === 'running' ? SPINNER[tick % SPINNER.length]! : helper.status === 'failed' ? '✗' : '✓'
        lines.push({
          key: helperKey,
          isActive: helper.status === 'running',
          element: (
            <Box key={helperKey} flexDirection="row">
              <Text dimColor>{'  ↳ '}</Text>
              <Text color={helper.status === 'running' ? 'cyan' : helper.status === 'failed' ? 'red' : 'green'}>
                {`${icon} `}
              </Text>
              <Text dimColor={helper.status !== 'running'}>{fit(helper.label, Math.max(4, nameWidth - 4))}</Text>
              <Text dimColor wrap="truncate-end">
                {fit(` ${details}`, Math.max(0, columns - nameWidth - 2)).trimEnd()}
              </Text>
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
    const stepsIn = (from: number, to: number) => lines.slice(from, to).filter(one => one.key.startsWith('task-')).length
    const isCut = stepsIn(0, windowAt(room)) + stepsIn(windowAt(room) + room, lines.length) > 0
    // The "more steps" line needs a row of its own; with a single row the current step wins.
    const shown = isCut && room > 1 ? room - 1 : room
    const first = windowAt(shown)
    const above = stepsIn(0, first)
    const below = stepsIn(first + shown, lines.length)
    const rows = lines.slice(first, first + shown).map(one => one.element)
    if (above + below > 0 && shown < room) {
      const more = [above > 0 ? `${above} earlier` : '', below > 0 ? `${below} more ${below === 1 ? 'step' : 'steps'}` : '']
      rows.push(
        <Text key="more" dimColor wrap="truncate-end">
          {`  … ${more.filter(Boolean).join(' · ')}`}
        </Text>,
      )
    }

    return (
      <Box flexDirection="column" width={columns}>
        {row(header)}
        {rows}
        {warnings}
        {actions}
      </Box>
    )
  })
}
