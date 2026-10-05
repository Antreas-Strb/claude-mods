export type CleanViewTaskStatus = 'done' | 'active' | 'upcoming'

/** How big a step is: small, medium or large, counting 1, 2 or 3 toward overall progress. */
export type CleanViewTaskSize = 'S' | 'M' | 'L'

export type CleanViewTask = {
  id: string
  name: string
  status: CleanViewTaskStatus
  percent: number
  hasReported: boolean
  size: CleanViewTaskSize
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
export type CleanViewPhase = 'working' | 'needsYou' | 'stuck' | 'stopped' | 'background' | 'done'

/** A helper working under a step: a subagent, or a background task such as a long command. */
export type CleanViewHelper = {
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

export type CleanViewChecklist = {
  title: string
  phase: CleanViewPhase
  tasks: CleanViewTask[]
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
  helpers: CleanViewHelper[]
  /** Tokens of requests outside any step, such as Claude's final answer: counted in the job's total only. */
  extraTokens: number
  /** Of those, the tokens read from the prompt cache. */
  extraCachedTokens: number
}

/** One plan window and how much of it is used. */
export type CleanViewLimit = {
  /** In plain words: "5-hour", "weekly", "spending". */
  label: string
  /** 0 to 100. */
  percent: number
}

/** The plan limits and chat length, shown under the checklist. */
export type CleanViewUsage = {
  /** Every plan window the last response reported; empty off a subscription. */
  limits: CleanViewLimit[]
  /** The fullest plan window, 0 to 100; null off a subscription. */
  limitPercent: number | null
  /** Which window that is, in plain words ("5-hour", "weekly"). */
  limitLabel: string | null
  /** How full this chat's context window is, 0 to 100. */
  contextPercent: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      /** `simple`: steps, progress and time. `detailed`: also models, effort, tokens, cache and plan usage. */
      detailLevel: 'simple' | 'detailed'
      checklist: CleanViewChecklist | null
      tick: number
      usage: CleanViewUsage
    }
  }
}
