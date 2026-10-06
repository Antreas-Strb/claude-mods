// The day's history of jobs, for a retro: pure functions, no engine calls.

import type { CleanViewChecklist, CleanViewHistoryEntry, CleanViewOutcome } from '../types'

export const HISTORY_PREFIX = 'history:'
export const HISTORY_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** A moment's local day, YYYY-MM-DD: the store key's suffix. */
export function dayKey(at: number): string {
  const date = new Date(at)

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A moment's local time of day, HH:MM. */
export function clockTime(at: number): string {
  const date = new Date(at)

  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The day a /simple history argument names: today, yesterday, or YYYY-MM-DD. Null when it names none. */
export function dayFromArgument(argument: string, now: number): string | null {
  const word = argument.trim().toLowerCase()
  if (word === '' || word === 'today') return dayKey(now)
  if (word === 'yesterday') return dayKey(now - DAY_MS)

  return /^\d{4}-\d{2}-\d{2}$/.test(word) ? word : null
}

const OUTCOME: Record<CleanViewChecklist['phase'], CleanViewOutcome> = {
  working: 'working',
  needsYou: 'waiting',
  stuck: 'stuck',
  stopped: 'stopped',
  background: 'background',
  done: 'done',
}

/** One job as the history keeps it. */
export function entryFromChecklist(list: CleanViewChecklist, project: string): CleanViewHistoryEntry {
  const tokens = list.tasks.reduce((sum, one) => sum + one.tokens, list.extraTokens)
  const cached = list.tasks.reduce((sum, one) => sum + one.cachedTokens, list.extraCachedTokens)

  return {
    jobId: list.jobId,
    project,
    startedAt: list.startedAt,
    finishedAt: list.finishedAt,
    title: list.title,
    outcome: OUTCOME[list.phase],
    stepsDone: list.tasks.filter(one => one.status === 'done').length,
    stepsTotal: list.tasks.length,
    newTokens: tokens - cached,
    cachedTokens: cached,
    doneSteps: list.hasPlan ? list.tasks.filter(one => one.status === 'done').map(one => one.name) : [],
    openSteps: list.hasPlan ? list.tasks.filter(one => one.status !== 'done').map(one => one.name) : [],
    isQuickAnswer: !list.hasPlan,
  }
}

/** The day's entries with this one added, or replacing its earlier self. */
export function upsertEntry(entries: unknown, entry: CleanViewHistoryEntry): CleanViewHistoryEntry[] {
  const list = Array.isArray(entries) ? (entries as CleanViewHistoryEntry[]) : []

  return [...list.filter(one => one.jobId !== entry.jobId), entry].sort((a, b) => a.startedAt - b.startedAt)
}

/** Store keys of days older than the history keeps. */
export function expiredHistoryKeys(keys: readonly string[], now: number): string[] {
  const oldest = dayKey(now - HISTORY_DAYS * DAY_MS)

  return keys.filter(key => key.startsWith(HISTORY_PREFIX) && key.slice(HISTORY_PREFIX.length) < oldest)
}

/** The folder name people know a project by. */
export function projectName(project: string): string {
  return project.split(/[\\/]/).filter(Boolean).pop() ?? project
}

/** The day before or after a YYYY-MM-DD day. */
export function shiftDay(day: string, by: number): string {
  const [year, month, date] = day.split('-').map(Number)

  return dayKey(new Date(year!, month! - 1, date! + by, 12).getTime())
}

/** "Tuesday 6 October 2026", or the YYYY-MM-DD day where the runtime has no date names. */
export function longDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  try {
    return new Date(year!, month! - 1, date!, 12).toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
  } catch {
    return day
  }
}

/** Time as a manager would say it: "under a minute", "12 min", "1 h 5 min". */
export function plainDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`

  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

/**
 * A short daily update for the team, a manager or a CEO: what got done, what is still open, and the time
 * spent. Plain words only: no tokens, models or file names, and quick questions are left out.
 */
export function teamReport(view: { day: string; project: string; entries: CleanViewHistoryEntry[] }): string {
  const jobs = view.entries.filter(one => !one.isQuickAnswer)
  const took = (one: CleanViewHistoryEntry) =>
    one.finishedAt === null ? '' : ` (${plainDuration(one.finishedAt - one.startedAt)})`
  const lines = [`Daily update · ${projectName(view.project)} · ${longDay(view.day)}`, '']

  if (jobs.length === 0) {
    return [...lines, 'No planned work was recorded on this day.'].join('\n')
  }

  const done = jobs.filter(one => one.outcome === 'done')
  const open = jobs.filter(one => one.outcome !== 'done' && one.outcome !== 'stuck')
  const blocked = jobs.filter(one => one.outcome === 'stuck')

  if (done.length > 0) {
    lines.push('Done')
    for (const one of done) {
      lines.push(`• ${one.title}${took(one)}`)
      if (one.doneSteps.length > 1) lines.push(`  ${one.doneSteps.join(' · ')}`)
    }
    lines.push('')
  }
  if (open.length > 0) {
    lines.push('Still in progress')
    for (const one of open) {
      const next = one.openSteps[0] ? `; next: ${one.openSteps[0].charAt(0).toLowerCase()}${one.openSteps[0].slice(1)}` : ''
      lines.push(`• ${one.title}: ${one.doneSteps.length} of ${one.stepsTotal} steps done${next}`)
    }
    lines.push('')
  }
  if (blocked.length > 0) {
    lines.push('Needs attention')
    for (const one of blocked) lines.push(`• ${one.title}: it got stuck and needs a decision`)
    lines.push('')
  }

  const time = jobs.reduce((sum, one) => sum + (one.finishedAt === null ? 0 : one.finishedAt - one.startedAt), 0)
  lines.push(
    `${done.length} of ${jobs.length} ${jobs.length === 1 ? 'task' : 'tasks'} finished · ${plainDuration(time)} of work`,
  )

  return lines.join('\n')
}
