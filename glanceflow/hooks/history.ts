// The day's history of jobs, for a retro: pure functions, no engine calls.

import type { GlanceChecklist, GlanceFile, GlanceHistoryEntry, GlanceOutcome, GlanceTaskSize } from '../types'

export const HISTORY_PREFIX = 'history:'
export const HISTORY_DAYS = 30
/** How much each step size counts toward progress and pace. */
export const SIZE_WEIGHT: Record<GlanceTaskSize, number> = { S: 1, M: 2, L: 3 }
// The project's pace is trusted once its finished jobs hold this many size units: about three medium steps.
const MIN_PACE_UNITS = 6
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

/** The day a /glanceflow history argument names: today, yesterday, or YYYY-MM-DD. Null when it names none. */
export function dayFromArgument(argument: string, now: number): string | null {
  const word = argument.trim().toLowerCase()
  if (word === '' || word === 'today') return dayKey(now)
  if (word === 'yesterday') return dayKey(now - DAY_MS)

  return /^\d{4}-\d{2}-\d{2}$/.test(word) ? word : null
}

const OUTCOME: Record<GlanceChecklist['phase'], GlanceOutcome> = {
  working: 'working',
  needsYou: 'waiting',
  stuck: 'stuck',
  stopped: 'stopped',
  background: 'background',
  done: 'done',
}

/** One job as the history keeps it. */
/** One job as the history keeps it; `costUsd` is what it cost, where the host keeps a ledger. */
/** "Added contact.html · changed styles.css and app.js": file names only, with the folder where two share a name. */
export function filesNote(files: readonly GlanceFile[], most = 4): string {
  const base = (path: string) => path.split(/[\\/]/).pop() ?? path
  const counts = new Map<string, number>()
  for (const one of files) counts.set(base(one.path), (counts.get(base(one.path)) ?? 0) + 1)
  const label = (path: string) => ((counts.get(base(path)) ?? 0) > 1 ? path.split(/[\\/]/).slice(-2).join('/') : base(path))
  const group = (verb: string, names: string[]) => {
    if (names.length === 0) return null
    const shown = names.slice(0, most)
    const more = names.length - shown.length
    const last = more > 0 ? `${more} more` : shown.pop()
    return `${verb} ${shown.length > 0 ? `${shown.join(', ')} and ${last}` : last}`
  }
  const text = [
    group('added', files.filter(one => one.isNew).map(one => label(one.path))),
    group('changed', files.filter(one => !one.isNew).map(one => label(one.path))),
  ]
    .filter(Boolean)
    .join(' · ')

  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** A History entry's files, as a step's are kept. */
export function entryFiles(entry: GlanceHistoryEntry): GlanceFile[] {
  return [...(entry.filesAdded ?? []).map(path => ({ path, isNew: true })), ...(entry.filesChanged ?? []).map(path => ({ path, isNew: false }))]
}

export function entryFromChecklist(list: GlanceChecklist, project: string, costUsd: number | null = null): GlanceHistoryEntry {
  const files = list.tasks.flatMap(one => one.files ?? [])
  const added = [...new Set(files.filter(one => one.isNew).map(one => one.path))]
  const tokens = list.tasks.reduce((sum, one) => sum + one.tokens, list.extraTokens)
  const cached = list.tasks.reduce((sum, one) => sum + one.cachedTokens, list.extraCachedTokens)
  const timed = list.hasPlan
    ? list.tasks.filter(one => one.status === 'done' && one.startedAt !== null && one.finishedAt !== null && one.finishedAt > one.startedAt)
    : []

  return {
    jobId: list.jobId,
    project,
    startedAt: list.startedAt,
    finishedAt: list.finishedAt,
    title: list.title,
    // A job that finished with a question for the person is still a finished job.
    outcome: list.phase === 'needsYou' && list.finishedAt !== null ? 'done' : OUTCOME[list.phase],
    stepsDone: list.tasks.filter(one => one.status === 'done').length,
    stepsTotal: list.tasks.length,
    newTokens: tokens - cached,
    cachedTokens: cached,
    doneSteps: list.hasPlan ? list.tasks.filter(one => one.status === 'done').map(one => one.name) : [],
    doneNotes: list.hasPlan ? list.tasks.filter(one => one.status === 'done').map(one => one.summary ?? '') : [],
    openSteps: list.hasPlan ? list.tasks.filter(one => one.status !== 'done').map(one => one.name) : [],
    filesAdded: added,
    filesChanged: [...new Set(files.filter(one => !one.isNew && !added.includes(one.path)).map(one => one.path))],
    isQuickAnswer: !list.hasPlan,
    costUsd,
    doneUnits: timed.reduce((sum, one) => sum + SIZE_WEIGHT[one.size], 0),
    doneMs: timed.reduce((sum, one) => sum + (one.finishedAt! - one.startedAt!), 0),
  }
}

/** How long one unit of step size takes in this project, from its finished jobs; null until there is enough to go on. */
export function paceFromHistory(entries: readonly GlanceHistoryEntry[], project: string): number | null {
  let units = 0
  let ms = 0
  for (const one of entries) {
    if (one.project === project && one.outcome === 'done' && (one.doneUnits ?? 0) > 0 && (one.doneMs ?? 0) > 0) {
      units += one.doneUnits!
      ms += one.doneMs!
    }
  }

  return units >= MIN_PACE_UNITS ? Math.round(ms / units) : null
}

/** The day's entries with this one added, or replacing its earlier self. */
export function upsertEntry(entries: unknown, entry: GlanceHistoryEntry): GlanceHistoryEntry[] {
  const list = Array.isArray(entries) ? (entries as GlanceHistoryEntry[]) : []

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
/** The days the weekly report covers: the day picked and the 6 before it. */
export const WEEK_DAYS = 7

/** YYYY-MM-DD as "30 Sep 2026". */
export function shortDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  try {
    return new Date(year!, month! - 1, date!, 12).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return day
  }
}

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
export function teamReport(
  view: { day: string; project: string; entries: GlanceHistoryEntry[] },
  span: 'day' | 'week' = 'day',
): string {
  const jobs = view.entries.filter(one => !one.isQuickAnswer)
  const took = (one: GlanceHistoryEntry) =>
    one.finishedAt === null ? '' : ` (${plainDuration(one.finishedAt - one.startedAt)})`
  const heading =
    span === 'week'
      ? `Weekly update · ${projectName(view.project)} · ${shortDay(shiftDay(view.day, -(WEEK_DAYS - 1)))} to ${shortDay(view.day)}`
      : `Daily update · ${projectName(view.project)} · ${longDay(view.day)}`
  const lines = [heading, '']

  if (jobs.length === 0) {
    return [...lines, `No planned work was recorded ${span === 'week' ? 'this week' : 'on this day'}.`].join('\n')
  }

  const done = jobs.filter(one => one.outcome === 'done')
  const open = jobs.filter(one => one.outcome !== 'done' && one.outcome !== 'stuck')
  const blocked = jobs.filter(one => one.outcome === 'stuck')

  if (done.length > 0) {
    lines.push('Done')
    for (const one of done) {
      lines.push(`• ${one.title}${took(one)}`)
      const notes = one.doneNotes ?? []
      if (notes.some(Boolean)) {
        // What each step got done, in Claude's words where it gave them.
        one.doneSteps.forEach((name, at) => lines.push(`  ✓ ${notes[at] || name}`))
      } else if (one.doneSteps.length > 1) {
        lines.push(`  ${one.doneSteps.join(' · ')}`)
      }
    }
    lines.push('')
  }
  if (open.length > 0) {
    // "Open", not "in progress": a stopped job is here too, and nobody may be on it right now.
    lines.push('Still open')
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

/** The weekday people say: "Tuesday", or the YYYY-MM-DD day where the runtime has no date names. */
function weekday(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  try {
    return new Date(year!, month! - 1, date!, 12).toLocaleDateString('en-GB', { weekday: 'long' })
  } catch {
    return day
  }
}

/**
 * A personal summary of the 7 days up to `day`, across every project: how many steps Claude checked off,
 * in how many tasks, the time, the busiest day and the biggest tasks. Plain words, made to share.
 */
export function weekSummary(entries: readonly GlanceHistoryEntry[], day: string): string {
  const jobs = entries.filter(one => !one.isQuickAnswer)
  const heading = `Your week with Claude · ${shortDay(shiftDay(day, -(WEEK_DAYS - 1)))} to ${shortDay(day)}`
  if (jobs.length === 0) {
    return `${heading}\n\nNo planned work was recorded this week. Ask Claude for something with a few steps, and it shows here.`
  }

  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  const steps = jobs.reduce((sum, one) => sum + one.doneSteps.length, 0)
  const finished = jobs.filter(one => one.outcome === 'done').length
  const time = jobs.reduce((sum, one) => sum + (one.finishedAt === null ? 0 : one.finishedAt - one.startedAt), 0)
  const projects = new Set(jobs.map(one => one.project))
  const perDay = new Map<string, number>()
  for (const one of jobs) perDay.set(dayKey(one.startedAt), (perDay.get(dayKey(one.startedAt)) ?? 0) + 1)
  const [busiest, busiestCount] = [...perDay].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!
  const biggest = [...jobs].filter(one => one.doneSteps.length > 0).sort((a, b) => b.doneSteps.length - a.doneSteps.length).slice(0, 3)

  const lines = [
    heading,
    '',
    `Claude checked off ${plural(steps, 'step', 'steps')} in ${plural(jobs.length, 'task', 'tasks')}, and finished ${finished} of them.`,
    `Time at work: ${plainDuration(time)}${projects.size > 1 ? `, across ${projects.size} projects` : ''}.`,
  ]
  if (perDay.size > 1) lines.push(`Busiest day: ${weekday(busiest)}, with ${plural(busiestCount, 'task', 'tasks')}.`)
  if (biggest.length > 0) {
    lines.push('', 'Biggest tasks')
    for (const one of biggest) lines.push(`• ${one.title} (${plural(one.doneSteps.length, 'step', 'steps')})`)
  }

  return lines.join('\n')
}
