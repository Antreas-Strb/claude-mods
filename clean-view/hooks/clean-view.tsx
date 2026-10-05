import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderChildren, Timer } from 'claude-code'

import type { CleanViewChecklist, CleanViewHelper, CleanViewTask, CleanViewTaskSize, CleanViewUsage } from '../types'
import { findSecrets, maskPrivate } from './privacy'

const PLUGIN = 'clean-view'
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
const STORE_KEY = 'cleanViewEnabled'
const DETAIL_KEY = 'cleanViewDetail'
const MAX_NAME = 40
const METER = 10
const LABEL_WIDTH = 7
const TICK_MS = 250
const COLLAPSE_MS = 5000
const RESEND_WINDOW_MS = 2 * 60 * 1000
const LIMIT_WARN = 80
const LIMIT_ALERT = 95
const LONG_CHAT = 75
const SIZE_WEIGHT: Record<CleanViewTaskSize, number> = { S: 1, M: 2, L: 3 }
const LIMIT_LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', spend_limit: 'spending' }

const DENIED = 'you said no to a step, so Claude paused'
const FAILING = 'a step keeps failing, Claude is trying another way'
const PERMISSION = 'Claude needs your OK to continue'
const QUESTION = 'Claude has a question for you'
const WAITING = 'Claude is waiting for your reply'

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const detailAtom = atom({ plugin: 'clean-view', key: 'detailLevel' } as const, 'simple')
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, null)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)
const NO_USAGE: CleanViewUsage = { limits: [], limitPercent: null, limitLabel: null, contextPercent: null }
const usageAtom = atom({ plugin: 'clean-view', key: 'usage' } as const, NO_USAGE)

const PROMPT_SECTION = `# Clean View (progress checklist)
The person is not technical and sees a simple checklist instead of tool calls.
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

function fit(text: string, width: number): string {
  if (width <= 0) {
    return ''
  }

  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)
}

function task(name: string, status: CleanViewTask['status'], id = name, size: CleanViewTaskSize = 'M'): CleanViewTask {
  return { id, name, status, percent: status === 'done' ? 100 : 0, hasReported: status === 'done', size, tokens: 0, cachedTokens: 0 }
}

/** Token counts move to the new plan's step of the same name; the rest go to its first step, so the job total holds. */
export function carryTokens(old: CleanViewTask[], next: CleanViewTask[]): CleanViewTask[] {
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

function tokenNote(tokens: number, cachedTokens: number): string {
  if (tokens <= 0) return ''
  const cached = Math.round((100 * cachedTokens) / tokens)

  return `${formatTokens(tokens)} tokens${cached > 0 ? ` · ${cached}% cached` : ''}`
}

function sizeOf(raw: unknown): CleanViewTaskSize {
  const size = String(raw ?? '').trim().toUpperCase()

  return size === 'S' || size === 'L' ? size : 'M'
}

/** Overall progress: finished work out of the plan, S/M/L counting 1/2/3, the current step in part. */
export function overallProgress(tasks: CleanViewTask[]): { percent: number; doneCount: number; work: number } {
  const total = tasks.reduce((sum, one) => sum + SIZE_WEIGHT[one.size], 0)
  const work = tasks.reduce((sum, one) => {
    const weight = SIZE_WEIGHT[one.size]
    if (one.status === 'done') return sum + weight
    if (one.status === 'active' && one.hasReported) return sum + (weight * one.percent) / 100
    return sum
  }, 0)

  return {
    percent: total ? Math.round((100 * work) / total) : 0,
    doneCount: tasks.filter(one => one.status === 'done').length,
    work: total ? work / total : 0,
  }
}

/** Time left at this job's own pace since the plan; nothing until two steps are done. */
export function timeLeft(list: CleanViewChecklist, at: number): number | null {
  const { doneCount, work } = overallProgress(list.tasks)
  if (list.planAt === null || doneCount < 2 || work <= 0 || work >= 1) return null

  return Math.round(((at - list.planAt) / work) * (1 - work))
}

/**
 * Steps still open after Claude answered. The last step alone still open counts as done:
 * Claude finished but forgot to report 100.
 */
function hasUnfinishedWork(tasks: CleanViewTask[]): boolean {
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
function currentStepId(list: CleanViewChecklist): string {
  return (list.tasks.find(one => one.status === 'active') ?? list.tasks[list.tasks.length - 1])?.id ?? ''
}

export type BackgroundTask = { id: string; type: string; status: string; description: string }

/** Background tasks as the latest list has them: new ones join, ones no longer listed have finished. */
export function reconcileBackground(list: CleanViewChecklist, tasks: readonly BackgroundTask[]): CleanViewHelper[] {
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
      (one): CleanViewHelper => ({
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

function isBusy(list: CleanViewChecklist): boolean {
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
function settle(tasks: CleanViewTask[]): CleanViewTask[] {
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
export function applyProgress(tasks: CleanViewTask[], rawName: string, rawPercent: number): CleanViewTask[] {
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
  previous: CleanViewTask[],
): CleanViewTask[] {
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

const now = ($: $) => $.clock.now()

const syncTicker = ($: $, list: CleanViewChecklist | null) => {
  const isAnimated = list !== null && (list.phase === 'working' || list.phase === 'needsYou' || list.phase === 'background')
  if (isAnimated && ticker === undefined) {
    ticker = $.clock.every(TICK_MS, () => void update($, tickAtom, tick => (tick ?? 0) + 1))
  }
  if (!isAnimated && ticker !== undefined) {
    ticker.cancel()
    ticker = undefined
  }
}

const change = async ($: $, fn: (list: CleanViewChecklist) => CleanViewChecklist | null) => {
  const next = await update($, checklistAtom, list => (list ? fn(list) : list))
  syncTicker($, next)

  return next
}

const startJob = async ($: $, text: string, jobId: string) => {
  const previous = await read($, checklistAtom)
  const list: CleanViewChecklist = {
    title: cleanName(text.split('\n')[0]),
    phase: 'working',
    tasks: [task('Understand your request', 'active'), task('Plan the steps', 'upcoming')],
    needsYouReason: null,
    stuckReason: null,
    startedAt: await now($),
    finishedAt: null,
    isCollapsed: false,
    hasPlan: false,
    jobId,
    planAt: null,
    plannedCount: 0,
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

const addHelper = ($: $, helper: Omit<CleanViewHelper, 'stepId'>) =>
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

  return change($, current => {
    const helper = agentId === undefined ? undefined : current.helpers.find(one => one.id === agentId)
    const stepId =
      helper && current.tasks.some(one => one.id === helper.stepId) ? helper.stepId : currentStepId(current)
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

const measureUsage = async ($: $, usage: CleanViewUsage) => {
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
  $.ui.toast(isEnabled ? 'Clean View is on: tool details are hidden' : 'Clean View is off: showing everything')
}

const setDetail = async ($: $, isDetailed: boolean) => {
  await update($, detailAtom, () => (isDetailed ? 'detailed' : 'simple'))
  await $.store.set(DETAIL_KEY, isDetailed ? 'detailed' : 'simple')
  $.ui.toast(
    isDetailed ? 'Details on: models, tokens, cache and plan usage' : 'Details off: just the steps and progress',
  )
}

export function registerCleanView(on: On): void {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)
    await update($, enabledAtom, () => stored !== false)
    const detail = await $.store.get(DETAIL_KEY)
    await update($, detailAtom, () => (detail === 'detailed' ? 'detailed' : 'simple'))
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
      name: 'simple',
      description: 'Clean View: /simple on|off (or /simple to flip it), /simple details on|off for models, tokens and usage',
    })
    // A reload drops the module's timers; pick the animation back up.
    syncTicker($, await read($, checklistAtom))

    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg.startsWith('details')) {
      const choice = arg.slice('details'.length).trim()
      const isDetailed =
        choice === 'on' ? true : choice === 'off' ? false : (await read($, detailAtom)) !== 'detailed'
      await setDetail($, isDetailed)

      return { text: isDetailed ? 'Clean View details are on.' : 'Clean View details are off.' }
    }
    const isEnabled = arg === 'on' ? true : arg === 'off' ? false : !(await read($, enabledAtom))
    await setEnabled($, isEnabled)

    return { text: isEnabled ? 'Clean View is on.' : 'Clean View is off.' }
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

    return { drop: 'The message looked like it held a password or key, so Clean View held it back.' }
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
    await change($, current => ({ ...current, helpers: reconcileBackground(current, tasks) }))
    await settleFinished($, await now($), false)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const text = ownWords(e.text)
    if (text && !text.startsWith('/')) {
      const list = await read($, checklistAtom)
      if (list === null || list.phase === 'done' || list.phase === 'stopped' || list.phase === 'background') {
        await startJob($, text, e.turnId)
      } else {
        await setWorking($)
      }
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
      await update($, checklistAtom, (list): CleanViewChecklist => ({
        planAt: list?.hasPlan ? (list.planAt ?? started) : started,
        plannedCount: list?.hasPlan ? list.plannedCount : steps.length,
        title: list?.title ?? 'Working on it',
        startedAt: list?.startedAt ?? started,
        jobId: list?.jobId ?? call.tool_use_id,
        finishedAt: null,
        isCollapsed: false,
        needsYouReason: null,
        stuckReason: null,
        phase: 'working',
        hasPlan: true,
        tasks: carryTokens(list?.tasks ?? [], tasks),
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

    if (list !== null) {
      if (e.reason === 'error') {
        // StopFailure may already have named the cause; keep its sentence.
        if (list.phase !== 'stuck') {
          await setStuck($, apiErrorSentence('unknown'))
        }
      } else if (e.reason === 'refusal') {
        await setStuck($, "Claude couldn't help with that request")
      } else if (list.phase === 'stuck' && list.stuckReason === DENIED) {
        // Keep the explanation of why Claude paused.
      } else if (e.reason === 'aborted') {
        await change($, current => ({ ...current, phase: 'stopped', needsYouReason: null, finishedAt: finished }))
      } else if (list.hasPlan && hasUnfinishedWork(list.tasks)) {
        await change($, current => ({ ...current, phase: 'needsYou', needsYouReason: WAITING }))
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
    }

    return next(e)
  })

  on('ui.render', { component: ['ToolUse', 'ToolResult', 'ToolGroup'] }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) =>
    (await read($, enabledAtom)) ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e),
  )

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
    const columns = Math.max(20, e.props.bodyColumns)
    const current = await now($)

    // Plan usage, always in view; it turns yellow, then red, as a window fills.
    const warnings: RenderChildren[] = []
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

    const isWide = columns >= 110
    const button = (
      <Box flexDirection="row" gap={1}>
        {isEnabled &&
          (isWide ? (
            <Button key="details" label={isDetailed ? '▾ Details' : '▸ Details'} onPress={() => setDetail($, !isDetailed)} />
          ) : (
            <Button key="details" plain label={isDetailed ? '▾' : '▸'} onPress={() => setDetail($, !isDetailed)} />
          ))}
        <Button
          key="toggle"
          label={isEnabled ? '● Clean View: ON' : '○ Clean View: OFF'}
          variant={isEnabled ? 'primary' : 'secondary'}
          onPress={() => setEnabled($, !isEnabled)}
        />
      </Box>
    )
    // The Details button shrinks to one glyph on a narrow screen, so the header keeps its room.
    const headerWidth = Math.max(0, columns - (!isEnabled ? 24 : isWide ? 38 : 27))
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
          {row(<Text> </Text>)}
          {warnings}
        </Box>
      )
    }

    const elapsed = formatDuration((list.finishedAt ?? current) - list.startedAt)
    const jobTokens = list.tasks.reduce((sum, one) => sum + one.tokens, 0)
    const jobTokenNote = isDetailed && jobTokens > 0 ? `${formatTokens(jobTokens)} tokens` : ''
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
          {fit(`■ Stopped · ${list.title} · you pressed Esc`, headerWidth).trimEnd()}
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
      const hasGrown = list.hasPlan && list.plannedCount > 0 && list.tasks.length > list.plannedCount
      // Time left replaces time spent once there is an estimate.
      const details = headerDetails(
        [
          list.hasPlan ? `${overallProgress(list.tasks).percent}%` : '',
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
        </Box>
      )
    }

    // Name column: whatever the row leaves after mark, meter and label, so rows never wrap.
    const nameWidth = Math.max(4, Math.min(MAX_NAME, columns - 2 - 2 - METER - 2 - LABEL_WIDTH - 1))
    const room = Math.max(1, e.props.maxRows - 1 - warnings.length)
    const firstUpcoming = list.tasks.findIndex(one => one.status === 'upcoming')
    // What is left of the row after mark, name, meter and label: the step's tokens, when they fit.
    const usageRoom = columns - 2 - nameWidth - (METER + 2) - LABEL_WIDTH - 1
    const usageCell = (one: CleanViewTask) => {
      const note = tokenNote(one.tokens, one.cachedTokens)
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
        const filled = Math.round(one.percent / 10)
        const sweepAt = tick % (METER + 3)
        const meter = one.hasReported
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
              <Text>{fit(one.hasReported ? `${one.percent}%` : 'Working', LABEL_WIDTH)}</Text>
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
              <Text dimColor>{index === firstUpcoming ? 'Next' : 'Up next'}</Text>
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

    // Window the lines so the current step (and what runs under it) stays in view.
    const focus = Math.max(0, lines.findIndex(one => one.isActive))
    const first = Math.min(Math.max(0, focus - 1), Math.max(0, lines.length - room))
    const rows = lines.slice(first, first + room).map(one => one.element)

    return (
      <Box flexDirection="column" width={columns}>
        {row(header)}
        {rows}
        {warnings}
      </Box>
    )
  })
}
