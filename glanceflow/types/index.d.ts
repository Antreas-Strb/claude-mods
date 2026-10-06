export type GlanceTaskStatus = 'done' | 'active' | 'upcoming'

/** How big a step is: small, medium or large, counting 1, 2 or 3 toward overall progress. */
export type GlanceTaskSize = 'S' | 'M' | 'L'

export type GlanceTask = {
  id: string
  name: string
  status: GlanceTaskStatus
  percent: number
  hasReported: boolean
  size: GlanceTaskSize
  /** Tokens the model handled for this step: sent, read from the cache, written to it, and written back. */
  tokens: number
  /** Of those, the tokens read from the prompt cache. */
  cachedTokens: number
  /** When the step became the current one; null while upcoming. */
  startedAt: number | null
  /** When it was checked off; null until then. */
  finishedAt: number | null
}

/** `background`: Claude answered, but helpers or background tasks still run. */
export type GlancePhase = 'working' | 'needsYou' | 'stuck' | 'stopped' | 'background' | 'done'

/** A helper working under a step: a subagent, or a background task such as a long command. */
export type GlanceHelper = {
  id: string
  /** The step it was started under. */
  stepId: string
  kind: 'helper' | 'background'
  /** What it works on, in plain words. */
  label: string
  /** The helper type (Explore, general-purpose) or the background task's type (shell). */
  type: string
  /** The model it runs on, as people say it ("Haiku 4.5"); null until known. */
  model: string | null
  /** How hard it thinks (low to max); null until known or for a model without effort. */
  effort: string | null
  status: 'running' | 'done' | 'failed'
  /** Tokens this helper's own model requests handled. */
  tokens: number
}

export type GlanceChecklist = {
  title: string
  phase: GlancePhase
  tasks: GlanceTask[]
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number
  finishedAt: number | null
  isCollapsed: boolean
  /** True once Claude laid out a real plan (plan_steps, TodoWrite or TaskCreate). */
  hasPlan: boolean
  /** The turn that started this job; a late job name for another job is ignored. */
  jobId: string
  /** When the real plan arrived; the time-left estimate counts from here. */
  planAt: number | null
  /** How many steps the first plan had, to say when the plan grew. */
  plannedCount: number
  /** Subagents and background tasks this job started. */
  helpers: GlanceHelper[]
  /** Tokens of requests outside any step, such as Claude's final answer: counted in the job's total only. */
  extraTokens: number
  /** Of those, the tokens read from the prompt cache. */
  extraCachedTokens: number
  /** How a stopped job was stopped: Esc, or the Pause button. */
  stopKind: 'esc' | 'pause' | null
  /** What Claude is doing right now, in plain words ("Reading files"), and how many times in a row. */
  activity: { label: string; count: number } | null
  /** The session's spend in US dollars when the job started; null where the host keeps no ledger. */
  costAtStart: number | null
}

/** One plan window and how much of it is used. */
export type GlanceLimit = {
  /** In plain words: "5-hour", "weekly", "spending". */
  label: string
  /** 0 to 100. */
  percent: number
}

/** The plan limits and chat length, shown under the checklist. */
export type GlanceUsage = {
  /** Every plan window the last response reported; empty off a subscription. */
  limits: GlanceLimit[]
  /** The fullest plan window, 0 to 100; null off a subscription. */
  limitPercent: number | null
  /** Which window that is, in plain words ("5-hour", "weekly"). */
  limitLabel: string | null
  /** How full this chat's context window is, 0 to 100. */
  contextPercent: number | null
  /** What the session has cost so far in US dollars; null where the host keeps no ledger. */
  costUsd: number | null
}

/** How a job ended, as the history shows it. */
export type GlanceOutcome = 'done' | 'stopped' | 'stuck' | 'waiting' | 'background' | 'working'

/** One job in the day's history: kept in the store for 30 days, on this computer only. */
export type GlanceHistoryEntry = {
  jobId: string
  /** The folder the session ran in. */
  project: string
  startedAt: number
  finishedAt: number | null
  title: string
  outcome: GlanceOutcome
  stepsDone: number
  stepsTotal: number
  newTokens: number
  cachedTokens: number
  /** Names of the steps it finished, for the team report. */
  doneSteps: string[]
  /** Names of the steps still open. */
  openSteps: string[]
  /** A quick answer with no plan: listed in the panel, left out of the team report. */
  isQuickAnswer: boolean
  /** What the job cost in US dollars; absent where the host keeps no ledger. */
  costUsd?: number | null
}

/** What the history pane shows: one day of one project. */
export type GlanceHistoryView = {
  /** YYYY-MM-DD, local time. */
  day: string
  project: string
  entries: GlanceHistoryEntry[]
  /** Days with saved history, newest first, for the day picker. */
  days: string[]
  /** True while the plain-English team report shows in place of the list. */
  isReportShown: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'glanceflow': {
      glanceEnabled: boolean
      /** `simple`: steps, progress and time. `detailed`: also models, effort, tokens, cache and plan usage. */
      detailLevel: 'simple' | 'detailed'
      checklist: GlanceChecklist | null
      tick: number
      usage: GlanceUsage
      historyView: GlanceHistoryView | null
      /** The Fresh chat button: `armed` waits for a second press to confirm. */
      handoffState: 'idle' | 'armed' | 'working'
      /** Alerts: `chime` plays a short sound when Claude needs you, gets stuck or finishes a long job; `voice` also says it. */
      soundMode: 'off' | 'chime' | 'voice'
      /** Calm mode: nothing moves, and statuses read in bold. */
      isCalm: boolean
    }
  }
}
