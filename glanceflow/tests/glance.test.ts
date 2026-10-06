import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { GlanceHistoryEntry, GlanceOutcome } from '../types'

import { activityOf, carryTokens, isContinueWords, isLatinText, isStartWords, cleanName, fit, formatCost, formatTokens, headerDetails, ownWords, prettyModel, tokenNote } from '../hooks/glance'
import { findSecrets, maskPrivate } from '../hooks/privacy'
import { dayFromArgument, dayKey, expiredHistoryKeys, longDay, paceFromHistory, shiftDay, teamReport, weekSummary } from '../hooks/history'

const PLAN = 'mcp__glanceflow__plan_steps'
const PROGRESS = 'mcp__glanceflow__report_progress'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  plugin: 'glanceflow',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

/** Calls a tool as the engine does; typed loosely, since the full tool table is too wide to check here. */
function callTool($: Engine, input: unknown): Promise<{ deny?: string; result?: unknown }> {
  return ($.tool.call as unknown as (input: unknown) => Promise<{ deny?: string; result?: unknown }>)(input)
}

/** The world beneath the plugin: clock, store, Haiku and every tool answer from memory. */
function world(on: On) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Build my landing page', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Notification', () => ({}) as never)
}

/** Turns on the detailed view: models, tokens, cache and plan usage. */
async function detailsOn($: Engine) {
  await $.command.run({ command: 'glanceflow', args: 'details on' } as never)
}

async function texts($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 80): Promise<string[]> {
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns }, surface })
  const found = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  const buttons = (await ui.findAll({ type: 'Button' })).map(one => one.text)
  await ui.unmount()

  return [...found, ...buttons]
}

describe('clean names', () => {
  test('backtick code is stripped', () => {
    expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  })

  test('a path disappears from the middle of a sentence', () => {
    expect(cleanName('update the src/app/page.tsx header text')).toBe('Update the header text')
    expect(cleanName('Fix styles.css and the menu')).toBe('Fix and the menu')
  })

  test('an 80-character name trims to 40 or less at a word boundary', () => {
    const long = 'Rewrite the welcome message so that it sounds warmer and friendlier to new visitors'
    const name = cleanName(long)
    expect(name.length <= 40).toBe(true)
    expect(name.endsWith('…')).toBe(true)
    expect(long.startsWith(name.slice(0, -1))).toBe(true)
  })

  test('nothing left becomes a friendly placeholder', () => {
    expect(cleanName('`npm run build`')).toBe('Working on it')
  })
})

test('a to-do list plus a 60% report draws done, current, next and up next rows', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, {
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
    ],
  } as never)
  await callTool($, { tool: PROGRESS, task: 'Build the pricing section', percent: 60 } as never)

  for (const surface of SURFACES) {
    const shown = (await texts($, surface)).join('\n')
    expect(shown).toContain('✓')
    expect(shown).toContain('Read your brand notes')
    expect(shown).toContain('▶')
    expect(shown).toContain('██████░░░░')
    expect(shown).toContain('60%')
    expect(shown).toContain('Next')
    expect(shown).toContain('Later')
    expect(shown).toContain('GlanceFlow: Simple')
  }
})

test('a permission prompt shows Needs you', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })

  for (const surface of SURFACES) {
    const shown = (await texts($, surface)).join('\n')
    expect(shown).toContain('Needs you')
    expect(shown).toContain("Answer Claude's request in the chat")
    expect(shown).toContain('‖')
  }
})

test('/glanceflow off hides the band but keeps the button', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.command.run({ command: 'glanceflow', args: 'off' } as never)

  for (const surface of SURFACES) {
    const shown = (await texts($, surface)).join('\n')
    expect(shown).not.toContain('Understand your request')
    expect(shown).toContain('GlanceFlow: Off')
  }
})

test('plan_steps then report_progress at 100 checks off step one and starts step two', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  const planned = await callTool($, { tool: PLAN, steps: ['Read your notes', 'Write the page', 'Check it'] } as never)
  expect(planned.result).toBe('Planned 3 steps. The first one has started.')
  const reported = await callTool($, { tool: PROGRESS, task: 'Read your notes', percent: 100 } as never)
  expect(reported.result).toBe('Progress noted: 100%.')

  const shown = await texts($, 'terminal')
  const at = (text: string) => shown.findIndex(one => one.includes(text))
  // Row order: mark, name, meter, label.
  expect(shown[at('Read your notes') - 1]).toContain('✓')
  expect(shown[at('Read your notes') + 2]?.trim()).toBe('Done')
  expect(shown[at('Write the page') - 1]).toContain('▶')
  expect(shown[at('Check it') + 2]?.trim()).toBe('Next')
})

test('any tool is denied before a plan exists and allowed after', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  const before = await callTool($, { tool: 'Bash', command: 'ls' })
  expect(before.deny).toContain('plan_steps')

  const allowed = await callTool($, { tool: 'ToolSearch', query: 'select:x', max_results: 1 })
  expect(allowed.deny).toBe(undefined)

  await callTool($, { tool: PLAN, steps: ['Look around', 'Answer you'] } as never)
  const after = await callTool($, { tool: 'Bash', command: 'ls' })
  expect(after.deny).toBe(undefined)
})

test('a finished job says All done and collapses after 5 seconds', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Notification', () => ({}) as never)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Do it', 'Check it'] } as never)
  await clock.advance(134_000)
  await callTool($, { tool: PROGRESS, task: 'Check it', percent: 100 } as never)
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('✓ All done')
  expect(shown).toContain('took 2m 14s')
  await clock.advance(5000)
  const collapsed = (await texts($, 'terminal')).join('\n')
  expect(collapsed).toContain('✓ All done')
  expect(collapsed).not.toContain('Do it')
})

// Sample secrets are built at run time, so no key-shaped text sits in the repository
// (where secret scanners would flag it).
const fakeKey = (length: number) => ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz123456'.slice(0, length)].join('-')
const SAMPLE_PASSWORD = ['hunter', '22'].join('')
const SAMPLE_CARD = Array(4).fill('4242').join(' ')
const SAMPLE_ASSIGNMENT = `${['API', 'KEY'].join('_')}=${['abcd', '1234', 'efgh'].join('')}`

describe('privacy', () => {
  test('passwords, keys and card numbers are found', () => {
    expect(findSecrets(`my password is ${SAMPLE_PASSWORD}`)).toContain('a password')
    expect(findSecrets('ο κωδικός μου είναι gata1234')).toContain('a password')
    expect(findSecrets(`use ${fakeKey(32)}`)).toContain('a key or token')
    expect(findSecrets(SAMPLE_ASSIGNMENT)).toContain('a password or key')
    expect(findSecrets(`card ${SAMPLE_CARD} please`)).toContain('a card number')
  })

  test('ordinary messages are left alone', () => {
    expect(findSecrets('Build my landing page with a pricing section')).toEqual([])
    expect(findSecrets('Order 1234 5678 is late')).toEqual([])
  })

  test('everyday words that sound like credentials are not held back', () => {
    for (const text of [
      'Author: Antreas Stirmpou',
      'OAuth: enabled for the login page',
      'tokens: 128kcached in Details',
      'auth: required for /api routes',
      'PIN: optional for now',
      'set GLANCE_AUTH_MODE: simple',
      'Δες το authentication: fallback',
      'Ο κωδικός: γράψε τον καθαρά',
    ]) {
      expect(findSecrets(text)).toEqual([])
      expect(maskPrivate(text)).toBe(text)
    }
    expect(findSecrets(`${['DB', 'PASSWORD'].join('_')}=letmein`)).toContain('a password or key')
    expect(findSecrets(`${['AUTH', 'TOKEN'].join('_')}: ${['abc', '123', 'def'].join('')}`)).toContain('a password or key')
    expect(findSecrets('pin: 4821')).toContain('a password')
  })

  test('the screen hides emails, phones and keys; names drop them', () => {
    const masked = maskPrivate(`mail jane@example.com or call 555-123-4567, key ${fakeKey(22)}`)
    expect(masked).not.toContain('jane@example.com')
    expect(masked).not.toContain('555-123-4567')
    expect(masked).not.toContain(fakeKey(22))
    expect(cleanName('Email jane@example.com the invoice')).toBe('Email the invoice')
  })
})

test('a message with a password is held back once, then sent when sent again', async ($, on) => {
  world(on)
  let entered = 0
  on('prompt.submit', (_, e) => {
    entered += 1
    return { text: e.text }
  })
  const prompt = { text: `log in with password: ${SAMPLE_PASSWORD}`, wait: false, origin: { kind: 'composer' } } as never

  const first = await $.prompt.submit(prompt)
  expect((first as { drop?: string }).drop).toContain('password')
  expect(entered).toBe(0)

  await $.prompt.submit(prompt)
  expect(entered).toBe(1)

  await $.prompt.submit({ text: 'Build my landing page', wait: false, origin: { kind: 'composer' } } as never)
  expect(entered).toBe(2)
})

test('with the password guard off, a message with a password is sent straight away', async ($, on) => {
  world(on)
  let entered = 0
  on('prompt.submit', (_, e) => {
    entered += 1
    return { text: e.text }
  })
  const off = await $.command.run({ command: 'glanceflow', args: 'guard off' } as never)
  expect(off.text).toContain('password guard is off')
  const prompt = { text: `log in with password: ${SAMPLE_PASSWORD}`, wait: false, origin: { kind: 'composer' } } as never

  const sent = await $.prompt.submit(prompt)
  expect((sent as { drop?: string }).drop).toBeUndefined()
  expect(entered).toBe(1)

  const on_ = await $.command.run({ command: 'glanceflow', args: 'guard on' } as never)
  expect(on_.text).toContain('password guard is on')
  const held = await $.prompt.submit(prompt)
  expect((held as { drop?: string }).drop).toContain('password')
  expect(entered).toBe(1)
})

test('overall progress, time left and a grown plan show in the header and footer', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('ui.render', { component: 'SessionMode' }, (t$, e) => {
    const { Text } = t$.ui.resolve(e)
    return Text({ children: [e.props.modes.join(' & ')] })
  })

  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  // Sizes 1 + 2 + 2 + 3 = 8 units of work.
  await callTool($, { tool: PLAN, steps: ['Read notes', 'Write copy', 'Add form', 'Polish it'], sizes: ['S', 'M', 'M', 'L'] })
  await clock.advance(3 * 60_000)
  await callTool($, { tool: PROGRESS, task: 'Read notes', percent: 100 })
  await callTool($, { tool: PROGRESS, task: 'Write copy', percent: 100 })

  // 3 of 8 units in 3 minutes: 38%, about 5 minutes left.
  const shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('38%')
  expect(shown).toContain('about 5m left')

  const footer = await $.ui.mount({ plugin: 'glanceflow', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await footer.find({ type: 'Text' }))?.text).toContain('◎ 38% · ~5m')
  await footer.unmount()

  await callTool($, { tool: PROGRESS, task: 'Fix the menu', percent: 10 })
  expect((await texts($, 'terminal', 120)).join('\n')).toContain('plan grew 4 → 5')
  // Narrower: the note drops before the title is squeezed.
  const narrow = (await texts($, 'terminal', 80)).join('\n')
  expect(narrow).not.toContain('plan grew')
  expect(narrow).toContain('Build my landing page')
})

test('a nearly used-up limit and a long chat show gentle warnings', async ($, on) => {
  world(on)
  let compacted = false
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.compact', () => {
    compacted = true
    return { skip: 'nothing to compact in a test' }
  })
  await $.session.measure({
    context: { window: 200_000, tokens: 160_000, percent: 80 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 85 }],
    changed: ['context', 'rateLimits'],
  })

  for (const surface of SURFACES) {
    const shown = (await texts($, surface)).join('\n')
    expect(shown).toContain("You've used 85% of your 5-hour limit")
    expect(shown).toContain('This chat is 80% full')
    expect(shown).toContain('Tidy it up')
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'compact' })
  await ui.unmount()
  expect(compacted).toBe(true)
})

test('Claude forgetting 100 on the last step still ends in All done', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Do it', 'Check it'] })
  await callTool($, { tool: PROGRESS, task: 'Check it', percent: 80 })
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('✓ All done')
  expect(shown).not.toContain('Needs you')
})

test('two open steps after an answer still say Needs you', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Do it', 'Check it', 'Ship it'] })
  await $.turn.complete({ answer: 'Which colour?', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  expect((await texts($, 'terminal')).join('\n')).toContain('Needs you')
})

test('narrow headers drop the least important details first', () => {
  const parts = ['38%', 'about 5m left', 'plan grew 4 → 5']
  expect(headerDetails(parts, 80)).toBe(' · 38% · about 5m left · plan grew 4 → 5')
  expect(headerDetails(parts, 25)).toBe(' · 38% · about 5m left')
  expect(headerDetails(parts, 5)).toBe(' · 38%')
  expect(headerDetails(['', '1m 12s', ''], 40)).toBe(' · 1m 12s')
})

test('time left replaces time spent in the header', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['One', 'Two', 'Three', 'Four'] })
  await clock.advance(4 * 60_000)
  await callTool($, { tool: PROGRESS, task: 'Two', percent: 100 })

  const shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('about 4m left')
  expect(shown).not.toContain('4m 0s')
})

test("notes an app adds before the prompt don't name the job", async ($, on) => {
  world(on)
  expect(ownWords('<system-reminder>\nThe user started this session without a folder.\n</system-reminder>\nWrite a sea poem')).toBe('Write a sea poem')
  await $.turn.start({
    text: '<system-reminder>\nThe user started this session without choosing a project folder.\n</system-reminder>\nWrite a sea poem',
    turnId: 't1',
  })
  const shown = (await texts($, 'terminal')).join('\n')
  expect(shown).not.toContain('session without')
  expect(shown).toContain('Write a sea poem')
})

test('model ids read the way people say them', () => {
  expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('haiku')).toBe('Haiku')
  expect(prettyModel(null)).toBe(null)
})

test('a subagent shows under its step with its model and effort, then checks off', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'a1' }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  await detailsOn($)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Look around the project', 'Write the page'] })
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'Find the pricing data',
    description: 'Find the pricing data',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  } as never)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-4-5-20251001', effort: 'low', messageCount: 1, agentId: 'a1' } as never)) {
    // drain the step
  }

  for (const surface of SURFACES) {
    const shown = (await texts($, surface)).join('\n')
    expect(shown).toContain('↳')
    expect(shown).toContain('Find the pricing data')
    expect(shown).toContain('Explore · Haiku 4.5 · low effort')
  }

  await $.turn.complete({ answer: 'found it', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' })
  const after = await texts($, 'terminal')
  const at = after.findIndex(one => one.includes('Find the pricing data'))
  expect(after[at - 1]).toContain('✓')
})

test('background work keeps the job open until it finishes', async ($, on) => {
  world(on)
  on('classic.Stop', () => ({}) as never)
  await $.turn.start({ text: 'Merge the pull request', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Merge it', 'Watch the checks'] })
  await callTool($, { tool: PROGRESS, task: 'Watch the checks', percent: 100 })
  await $.turn.complete({ answer: 'Merged. Watching CI.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Wait for main CI and Vercel status to settle' }],
  } as never)

  let shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('Still working in the background')
  expect(shown).toContain('1 left')
  expect(shown).toContain('Wait for main CI and Vercel status')
  expect(shown).toContain('in the background')
  expect(shown).not.toContain('All done')

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('✓ All done')
})

test('Claude waiting for its own helper is not Needs you; it is when Claude waits for the person', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'a1' }) as never)
  await $.turn.start({ text: 'Ship the engine change', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Make the change', 'Get an independent review', 'Report results'] })
  await callTool($, { tool: PROGRESS, task: 'Make the change', percent: 100 })
  await $.agent.spawn({
    tool_use_id: 'tu1', prompt: 'Review it', description: 'Review the change', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  } as never)
  // Claude ends its turn to wait for the review.
  await $.turn.complete({ answer: 'Waiting for the review.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  let shown = (await texts($, 'terminal')).join('\n')
  expect(shown).not.toContain('Needs you')
  expect(shown).toContain('Review the change')
  expect(shown).not.toContain('‖ Pause')

  // The review ends; Claude wakes up on its own and carries on.
  await $.turn.complete({ answer: 'Looks good.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'a1' } as never)
  await $.turn.start({ text: '<task-notification>Review the change finished</task-notification>', turnId: 't3' })
  shown = (await texts($, 'terminal')).join('\n')
  expect(shown).not.toContain('Needs you')
  expect(shown).toContain('‖ Pause')

  // Claude stops with steps left and nothing running: now it waits for the person, and says where to answer.
  await $.turn.complete({ answer: 'Shall I file the follow-ups?', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })
  shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('Needs you')
  expect(shown).toContain('Reply to Claude in the box below')
})

test('a background shell Claude waits for is not Needs you either', async ($, on) => {
  world(on)
  on('classic.Stop', () => ({}) as never)
  await $.turn.start({ text: 'Run the end-to-end test', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Start the test', 'Read the results', 'Report back'] })
  await callTool($, { tool: PROGRESS, task: 'Start the test', percent: 100 })
  await $.turn.complete({ answer: 'Started; waiting.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Run the live test' }],
  } as never)

  const shown = (await texts($, 'terminal')).join('\n')
  expect(shown).not.toContain('Needs you')
  expect(shown).toContain('Run the live test')
})

test('a background task whose name already says background is not labelled twice', async ($, on) => {
  world(on)
  on('classic.Stop', () => ({}) as never)
  await $.turn.start({ text: 'Run a timer', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Start the timer', 'Report back'] })
  await callTool($, { tool: PROGRESS, task: 'Report back', percent: 100 })
  await $.turn.complete({ answer: 'Started.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Wait 60 seconds in background' }],
  } as never)

  const rows = (await texts($, 'terminal')).filter(one => !one.startsWith('◷'))
  expect(rows.join('\n')).toContain('Wait 60 seconds in background')
  expect(rows.join('\n')).not.toContain('in the background')
})

const USAGE = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 400 }

test('token counts read short', () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(12_400)).toBe('12.4k')
  expect(formatTokens(11_000)).toBe('11k')
  expect(formatTokens(212_000)).toBe('212k')
  expect(formatTokens(3_200_000)).toBe('3.2M')
})

test('a new plan keeps the tokens already counted', () => {
  const old = [
    { id: 'a', name: 'Understand your request', status: 'active', percent: 0, hasReported: false, size: 'M', summary: null, tokens: 500, cachedTokens: 100, startedAt: null, finishedAt: null },
  ] as const
  const next = [
    { id: 'p0', name: 'Write the page', status: 'active', percent: 0, hasReported: false, size: 'M', summary: null, tokens: 0, cachedTokens: 0, startedAt: null, finishedAt: null },
    { id: 'p1', name: 'Check it', status: 'upcoming', percent: 0, hasReported: false, size: 'M', summary: null, tokens: 0, cachedTokens: 0, startedAt: null, finishedAt: null },
  ] as const
  const carried = carryTokens([...old], [...next])
  expect(carried[0]?.tokens).toBe(500)
  expect(carried.reduce((sum, one) => sum + one.tokens, 0)).toBe(500)
})

test('each step shows its tokens and how much came from the cache', async ($, on) => {
  world(on)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { ...USAGE, model: 'claude-opus-5-5' } } as never
  })
  await detailsOn($)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Read notes', 'Write copy'] })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never)) {
    // drain
  }

  for (const surface of SURFACES) {
    const shown = (await texts($, surface, 120)).join('\n')
    // 1,000 + 1,000 + 10,000 + 400 = 12.4k: 2.4k new, 10k read back from the cache.
    expect(shown).toContain('2.4k new · 10k cached')
  }

  await callTool($, { tool: PROGRESS, task: 'Write copy', percent: 100 })
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect((await texts($, 'terminal', 120)).join('\n')).toMatch(/All done .* · 2\.4k new · 10k cached/)
})

test('plan usage shows all the time, not only near the limit', async ($, on) => {
  world(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await detailsOn($)
  await $.session.measure({
    context: { window: 200_000, tokens: 68_000, percent: 34 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42 },
      { kind: 'seven_day', percentUsed: 18 },
    ],
    changed: ['context', 'rateLimits'],
  })

  for (const surface of SURFACES) {
    const shown = (await texts($, surface)).join('\n')
    expect(shown).toContain('Plan usage: 5-hour 42% · weekly 18% · chat 34% full')
    expect(shown).not.toContain('⚠')
  }
})

test('the simple view hides models, tokens and low plan usage; the Details button shows them', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'a1' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { ...USAGE, model: 'claude-opus-5-5' } } as never
  })
  await $.session.measure({
    context: { window: 200_000, tokens: 68_000, percent: 34 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42 }],
    changed: ['context', 'rateLimits'],
  })
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Look around', 'Write the page'] })
  await $.agent.spawn({
    tool_use_id: 'tu1', prompt: 'Find the prices', description: 'Find the prices', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
  } as never)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never)) {
    // drain
  }

  for (const surface of SURFACES) {
    const simple = (await texts($, surface, 120)).join('\n')
    expect(simple).toContain('Find the prices')
    expect(simple).toContain('GlanceFlow: Simple')
    expect(simple).not.toContain('Haiku 4.5')
    expect(simple).not.toContain('tokens')
    expect(simple).not.toContain('cached')
    expect(simple).not.toContain('Plan usage')
  }

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 120 }, surface: 'terminal' })
  await ui.press({ key: 'toggle' })
  await ui.unmount()
  const detailed = (await texts($, 'terminal', 120)).join('\n')
  expect(detailed).toContain('GlanceFlow: Details')
  expect(detailed).toContain('Explore · Haiku 4.5')
  expect(detailed).toContain('2.4k new · 10k cached')
  expect(detailed).toContain('Plan usage: 5-hour 42%')
})

test('the simple view still warns near a plan limit', async ($, on) => {
  world(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 200_000, tokens: 68_000, percent: 34 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 85 }],
    changed: ['context', 'rateLimits'],
  })
  expect((await texts($, 'terminal')).join('\n')).toContain("You've used 85% of your 5-hour limit")
})

test('a quick answer with no plan ends as one plain step', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'What time zone is Athens in?', turnId: 't1' })
  await $.turn.complete({ answer: 'Eastern European Time.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('✓ All done')
  expect(shown).toContain('Answer your question')
  expect(shown).not.toContain('Plan the steps')
})

test('one button cycles Simple, Details and Off', async ($, on) => {
  world(on)
  const press = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }
  expect((await texts($, 'terminal')).join('\n')).toContain('GlanceFlow: Simple')
  await press()
  expect((await texts($, 'terminal')).join('\n')).toContain('GlanceFlow: Details')
  await press()
  expect((await texts($, 'terminal')).join('\n')).toContain('GlanceFlow: Off')
  await press()
  expect((await texts($, 'terminal')).join('\n')).toContain('GlanceFlow: Simple')
})

test('in details, the current step fills gradually and shows its time; done steps show how long they took', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await detailsOn($)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Read notes', 'Write copy'], sizes: ['M', 'M'] })

  // No pace yet: a medium step is expected to take 3 minutes, so after 90 seconds it is about half done.
  await clock.advance(90_000)
  let shown = (await texts($, 'terminal', 120)).join('\n')
  expect(shown).toContain('█████░░░░░')
  expect(shown).toContain('50%')
  expect(shown).toContain('1m 30s · ~2m left')
  expect(shown).not.toContain('Working')

  // The first step took 2 minutes; the second, the same size, is expected to take 2 minutes too.
  await clock.advance(30_000)
  await callTool($, { tool: PROGRESS, task: 'Read notes', percent: 100 })
  await clock.advance(60_000)
  shown = (await texts($, 'terminal', 120)).join('\n')
  expect(shown).toContain('took 2m 0s')
  expect(shown).toContain('50%')
  expect(shown).toContain('1m 0s · ~1m left')
})

test('the simple view keeps the sweep until Claude reports', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Read notes', 'Write copy'] })
  const shown = (await texts($, 'terminal', 120)).join('\n')
  expect(shown).toContain('Working')
  expect(shown).not.toContain('took')
})

test('token notes put new tokens first and cached ones after', () => {
  expect(tokenNote(228_000, 225_000)).toBe('3k new · 225k cached')
  expect(tokenNote(5_000, 0)).toBe('5k tokens')
  expect(tokenNote(0, 0)).toBe('')
})

test("Claude's final answer counts in the job's total, not in the last step", async ($, on) => {
  world(on)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: 'claude-opus-5-5' } } as never
  })
  await detailsOn($)
  await $.turn.start({ text: 'Remove the files', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Move them away', 'Check they are gone'] })
  await callTool($, { tool: PROGRESS, task: 'Check they are gone', percent: 100 })
  // Every step is done; this request is the final answer.
  for await (const _ of $.turn.step({ turnId: 't1', index: 3, model: 'claude-opus-5-5', effort: 'high', messageCount: 5 } as never)) {
    // drain
  }
  await $.turn.complete({ answer: 'Removed.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const shown = await texts($, 'terminal', 120)
  expect(shown.join('\n')).toMatch(/All done .* · 2\.4k new · 10k cached/)
  expect(shown.some(line => line.includes('new ·') && !line.includes('All done'))).toBe(false)
})

const PANE = {
  plugin: 'glanceflow',
  component: 'Pane',
  requestId: 'glanceflow-history',
  props: { title: 'History', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

/** A project folder, and a pane that opens. */
function historyWorld(on: On, project: { cwd: string }) {
  on('session.cwd', () => ({ value: project.cwd }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
}

async function paneTexts($: Engine): Promise<string[]> {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const found = [
    ...(await ui.findAll({ type: 'Text' })),
    ...(await ui.findAll({ type: 'Select' })),
    ...(await ui.findAll({ type: 'Button' })),
  ].map(one => one.text)
  await ui.unmount()

  return found
}

describe('history days', () => {
  test('today, yesterday and a date are understood', () => {
    const now = new Date(2026, 9, 6, 12).getTime()
    expect(dayFromArgument('', now)).toBe('2026-10-06')
    expect(dayFromArgument(' yesterday', now)).toBe('2026-10-05')
    expect(dayFromArgument(' 2026-09-30', now)).toBe('2026-09-30')
    expect(dayFromArgument(' last week', now)).toBe(null)
  })

  test('days older than 30 are cleaned away', () => {
    const now = new Date(2026, 9, 6, 12).getTime()
    expect(expiredHistoryKeys(['history:2026-08-01', 'history:2026-09-20', 'glanceEnabled'], now)).toEqual([
      'history:2026-08-01',
    ])
  })
})

test("each finished job is saved, and /glanceflow history shows the day's jobs for this project", async ($, on) => {
  const clock = mock.clock(on, { now: new Date(2026, 9, 6, 9, 42).getTime() })
  mock.store(on)
  const project = { cwd: '/work/landing-site' }
  historyWorld(on, project)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}) as never)

  // A finished job.
  await $.turn.start({ text: 'Build the pricing section', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Write it', 'Check it'] })
  await clock.advance(12 * 60_000 + 30_000)
  await callTool($, { tool: PROGRESS, task: 'Check it', percent: 100 })
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  // A stopped job.
  await clock.advance(60_000)
  await $.turn.start({ text: 'Fix the menu', turnId: 't2' })
  await callTool($, { tool: PLAN, steps: ['Find the menu', 'Fix it', 'Check it'] })
  await clock.advance(2 * 60_000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' })

  // A job in another project stays out of this one's history.
  project.cwd = '/work/other-project'
  await $.turn.start({ text: 'Rename the files', turnId: 't3' })
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })
  project.cwd = '/work/landing-site'

  const result = await $.command.run({ command: 'glanceflow', args: 'history' } as never)
  expect(result.text).toBe(`History for ${dayKey(clock.now())}: 2 tasks.`)

  const shown = (await paneTexts($)).join('\n')
  expect(shown).toContain('09:42')
  expect(shown).toContain('Build the pricing section')
  expect(shown).toContain('2/2 · 12m 30s')
  expect(shown).toContain('Fix the menu')
  expect(shown).toContain('■')
  expect(shown).toContain('0/3 · 2m 0s')
  expect(shown).not.toContain('Rename the files')
  expect(shown).toContain('Total: 2 tasks · 1 done, 1 stopped · 14m 30s')
})

test('a day with nothing saved says so', async ($, on) => {
  world(on)
  historyWorld(on, { cwd: '/work/landing-site' })
  await $.command.run({ command: 'glanceflow', args: 'history 2026-01-01' } as never)
  expect((await paneTexts($)).join('\n')).toContain('No tasks saved for this project on that day yet.')
})

const ENTRY = {
  project: '/work/landing-site',
  newTokens: 3000,
  cachedTokens: 225_000,
  isQuickAnswer: false,
} as const

test('the team report is plain: done, in progress, stuck and time, without tokens or quick questions', () => {
  const at = new Date(2026, 9, 6, 9, 0).getTime()
  const report = teamReport({
    day: '2026-10-06',
    project: '/work/landing-site',
    entries: [
      { ...ENTRY, jobId: 'a', startedAt: at, finishedAt: at + 12 * 60_000, title: 'Build the pricing section', outcome: 'done', stepsDone: 2, stepsTotal: 2, doneSteps: ['Write the prices', 'Check the layout'], openSteps: [] },
      { ...ENTRY, jobId: 'b', startedAt: at + 20 * 60_000, finishedAt: at + 22 * 60_000, title: 'Fix the menu', outcome: 'stopped', stepsDone: 1, stepsTotal: 3, doneSteps: ['Find the menu'], openSteps: ['Fix the links', 'Check it'] },
      { ...ENTRY, jobId: 'c', startedAt: at + 30 * 60_000, finishedAt: at + 31 * 60_000, title: 'Update the footer', outcome: 'stuck', stepsDone: 0, stepsTotal: 2, doneSteps: [], openSteps: ['Edit it', 'Check it'] },
      { ...ENTRY, jobId: 'd', startedAt: at + 40 * 60_000, finishedAt: at + 40 * 60_000, title: 'Answer your question', outcome: 'done', stepsDone: 1, stepsTotal: 1, doneSteps: [], openSteps: [], isQuickAnswer: true },
    ],
  })
  expect(report).toContain('Daily update · landing-site ·')
  expect(report).toContain('Done\n• Build the pricing section (12 min)\n  Write the prices · Check the layout')
  expect(report).toContain('Still in progress\n• Fix the menu: 1 of 3 steps done; next: fix the links')
  expect(report).toContain('Needs attention\n• Update the footer: it got stuck and needs a decision')
  expect(report).toContain('1 of 3 tasks finished · 15 min of work')
  expect(report).not.toContain('Answer your question')
  expect(report).not.toContain('token')
  expect(report).not.toContain('cached')
})

test('before any work the band says where the plan will show, without a Fresh chat button', async ($, on) => {
  world(on)
  const shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain("Ask Claude for something: its plan shows here")
  expect(shown).toContain('☰ History')
  expect(shown).not.toContain('Fresh chat')
})

test('Details keeps the tool rows in view; Simple hides them', async ($, on) => {
  world(on)
  const PROGRESS_ROW = {
    plugin: 'glanceflow',
    component: 'ToolProgress',
    props: { tool_use_id: 'tu1', kind: 'background_hint', hint: '(ctrl+b to run in background)' },
  } as const
  let drawn = ''
  on('ui.render', { component: 'ToolProgress' }, (_, e) => {
    drawn = (e.props as { hint: string }).hint
    return { type: 'Text', props: {}, children: [drawn] } as never
  })
  const hint = async () => {
    const ui = await $.ui.mount({ ...PROGRESS_ROW, surface: 'terminal' } as never)
    await ui.unmount()
    return drawn
  }
  expect(await hint()).not.toContain('ctrl+b')
  await detailsOn($)
  expect(await hint()).toContain('ctrl+b')
})

test('a long plan says how many steps are out of view', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'] })
  await callTool($, { tool: PROGRESS, task: 'Three', percent: 100 })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 4 }, surface: 'terminal' })
  const shown = (await ui.findAll({ type: 'Text' })).map(one => one.text).join('\n')
  await ui.unmount()
  expect(shown).toContain('… 3 earlier · 4 more steps')
  expect(shown).toContain('Four')
})

test('a long plan folds its finished steps and the ones after next, so the band stays short', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'] })
  await callTool($, { tool: PROGRESS, task: 'Three', percent: 100, summary: 'Wrote the three sections' })
  const shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('3 steps done')
  expect(shown).toContain('    Wrote the three sections')
  expect(shown).toContain('Four')
  expect(shown).toContain('Five')
  expect(shown).toContain('3 more steps')
  for (const hidden of ['One', 'Two', 'Six', 'Seven', 'Eight']) expect(shown).not.toMatch(new RegExp(`^${hidden}\\b`, 'm'))

  // Five steps or fewer stay as they are.
  await $.turn.start({ text: 'Fix the menu', turnId: 't2' })
  await callTool($, { tool: PLAN, steps: ['A1', 'B2', 'C3', 'D4', 'E5'] })
  await callTool($, { tool: PROGRESS, task: 'B2', percent: 100 })
  const short = (await texts($, 'terminal')).join('\n')
  for (const name of ['A1', 'B2', 'C3', 'D4', 'E5']) expect(short).toContain(name)
})

test('names in any script line up: CJK and emoji take two cells', () => {
  expect(fit('Read notes', 12)).toBe('Read notes  ')
  expect(fit('设计页面', 10)).toBe('设计页面  ')
  expect(fit('设计页面设计', 9)).toBe('设计页面…')
  expect(fit('设计页面设计', 8)).toBe('设计页… ')
  expect(fit('Ship it 🚀', 10)).toBe('Ship it 🚀')
  expect(fit('Διάβασε τις σημειώσεις', 10)).toBe('Διάβασε τ…')
})

test('with room for one row, the current step is the one shown', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['One', 'Two', 'Three', 'Four'] })
  await callTool($, { tool: PROGRESS, task: 'One', percent: 100 })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 3 }, surface: 'terminal' })
  const shown = (await ui.findAll({ type: 'Text' })).map(one => one.text).join('\n')
  await ui.unmount()
  expect(shown).toContain('Two')
  expect(shown).not.toContain('One ')
})

test('the band has History and Fresh chat buttons while GlanceFlow is on', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  for (const surface of SURFACES) {
    const shown = (await texts($, surface)).join('\n')
    expect(shown).toContain('☰ History')
    expect(shown).toContain('↻ Fresh chat')
  }
  await $.command.run({ command: 'glanceflow', args: 'off' } as never)
  const off = (await texts($, 'terminal')).join('\n')
  expect(off).not.toContain('☰ History')
})

test('the History button opens the panel; the day picker moves between days', async ($, on) => {
  const clock = mock.clock(on, { now: new Date(2026, 9, 6, 10, 0).getTime() })
  mock.store(on, {
    'history:2026-10-05': [
      { ...ENTRY, jobId: 'y', startedAt: new Date(2026, 9, 5, 15, 0).getTime(), finishedAt: new Date(2026, 9, 5, 15, 5).getTime(), title: 'Write the welcome email', outcome: 'done', stepsDone: 2, stepsTotal: 2, doneSteps: ['Draft it', 'Check it'], openSteps: [] },
    ],
  })
  let opened = 0
  on('session.cwd', () => ({ value: '/work/landing-site' }) as never)
  on('ui.open', () => {
    opened += 1
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', () => undefined as never)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'history' })
  await band.unmount()
  expect(opened).toBe(1)

  let pane = (await paneTexts($)).join('\n')
  expect(pane).toContain(`landing-site · ${longDay(dayKey(clock.now()))}`)
  expect(pane).toContain('No tasks saved for this project on that day yet.')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'earlier' })
  await ui.unmount()
  pane = (await paneTexts($)).join('\n')
  expect(pane).toContain('Write the welcome email')
  expect(pane).toContain(longDay('2026-10-05'))
  expect(pane).toContain('Later ▶')

  const picker = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await $.ui.select({ plugin: 'glanceflow', key: 'day', value: dayKey(clock.now()) })
  await picker.unmount()
  expect((await paneTexts($)).join('\n')).toContain('No tasks saved')
  expect(shiftDay('2026-10-01', -1)).toBe('2026-09-30')
})

test('Team report shows the report and copies it', async ($, on) => {
  mock.clock(on, { now: new Date(2026, 9, 6, 18, 0).getTime() })
  mock.store(on, {
    'history:2026-10-06': [
      { ...ENTRY, jobId: 'a', startedAt: new Date(2026, 9, 6, 9, 0).getTime(), finishedAt: new Date(2026, 9, 6, 9, 12).getTime(), title: 'Build the pricing section', outcome: 'done', stepsDone: 2, stepsTotal: 2, doneSteps: ['Write it', 'Check it'], openSteps: [] },
    ],
  })
  let copied = ''
  on('session.cwd', () => ({ value: '/work/landing-site' }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => undefined as never)
  on('ui.copy', (_, e) => {
    copied = e.text
    return { value: { isCopied: true } } as never
  })
  await $.command.run({ command: 'glanceflow', args: 'history' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'report' })
  await ui.unmount()
  expect(copied).toContain('Daily update · landing-site')
  expect(copied).toContain('• Build the pricing section (12 min)')
  expect((await paneTexts($)).join('\n')).toContain('Daily update · landing-site')
})

test('Fresh chat asks for a second press, then clears the chat and sends a handoff note', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.toast', () => undefined as never)
  let cleared = false
  let sent = ''
  on('model.fork', () => ({ value: { isAnswered: true, text: 'Continuing from an earlier chat. Here is where things stand: the menu is fixed.', usage: {} } }) as never)
  on('command.run', (_, e) => {
    cleared = cleared || e.command === 'clear'
    return { text: '' }
  })
  on('prompt.submit', (_, e) => {
    sent = e.text
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  // Fresh chat shows once the chat has some work in it.
  await $.turn.start({ text: 'Fix the menu', turnId: 't1' })

  const press = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'handoff' })
    await ui.unmount()
  }

  // One press only arms it, and it calms down again after 8 seconds.
  await press()
  expect((await texts($, 'terminal')).join('\n')).toContain('Press again to start a fresh chat')
  expect(cleared).toBe(false)
  await clock.advance(8000)
  expect((await texts($, 'terminal')).join('\n')).toContain('↻ Fresh chat')

  // Two presses hand off.
  await press()
  await press()
  expect(cleared).toBe(true)
  expect(sent).toContain('Continuing from an earlier chat')
  expect((await texts($, 'terminal')).join('\n')).toContain('↻ Fresh chat')
})

test('Pause stops the running turn; Continue picks the same job up without typing', async ($, on) => {
  world(on)
  let aborted = ''
  let sent = ''
  on('turn.abort', (_, e) => {
    aborted = e.turnId
    return { value: undefined } as never
  })
  on('prompt.submit', (_, e) => {
    sent = e.text
    return { text: e.text }
  })
  const press = async (key: string) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key })
    await ui.unmount()
  }

  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Write the page', 'Check it'] })
  let shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('‖ Pause')
  expect(shown).not.toContain('▶ Continue')

  await press('pause')
  expect(aborted).toBe('t1')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
  shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('‖ Paused · ')
  expect(shown).toContain('▶ Continue')
  expect(shown).not.toContain('‖ Pause\n')
  // The step itself says it is paused, not working.
  expect(shown).toContain('\nPaused ')
  expect(shown).not.toContain('\nWorking')

  await press('continue')
  expect(sent).toBe('Please continue where you left off.')
  await $.turn.start({ text: sent, turnId: 't2' })
  shown = (await texts($, 'terminal')).join('\n')
  // The same job and plan, working again.
  expect(shown).toContain('Write the page')
  expect(shown).toContain('▶ ')
  expect(shown).not.toContain('Paused')
  expect(shown).not.toContain('Understand your request')
  expect(shown).toContain('‖ Pause')
})

test('after Esc the header says Stopped, and Continue is offered', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Write the page', 'Check it'] })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
  const shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('■ Stopped')
  expect(shown).toContain('you pressed Esc')
  expect(shown).toContain('▶ Continue')
})

test("a paused step's time stands still", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.abort', () => ({ value: undefined }) as never)
  await detailsOn($)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Write the page', 'Check it'] })
  await clock.advance(30_000)
  await $.command.run({ command: 'glanceflow', args: 'pause' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })

  const before = (await texts($, 'terminal', 120)).join('\n')
  expect(before).toContain('30s · ')
  await clock.advance(5 * 60_000)
  const after = (await texts($, 'terminal', 120)).join('\n')
  expect(after).toContain('30s · ')
  expect(after).not.toContain('5m 30s')
})


/** A world with a clock to move, and the sounds and words GlanceFlow plays. */
function soundWorld(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Notification', () => ({}) as never)
  on('classic.Stop', () => ({}) as never)
  const heard: string[] = []
  on('audio.play', (_, e) => {
    heard.push(String((e.clip as { asset?: string }).asset))
    return { value: undefined } as never
  })
  on('audio.speak', (_, e) => {
    heard.push(`say: ${(e as { text: string }).text}`)
    return { value: { via: 'system' } } as never
  })
  return { clock, heard }
}

test('sounds are off until turned on; then a chime when Claude needs you, gets stuck or finishes a long job', async ($, on) => {
  const { clock, heard } = soundWorld(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Write it', 'Check it', 'Ship it'] })
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' } as never)
  expect(heard).toEqual([])

  const result = await $.command.run({ command: 'glanceflow', args: 'sound on' } as never)
  expect(result.text).toContain('Sounds are on')
  heard.length = 0
  await callTool($, { tool: 'Bash', command: 'ls' })
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' } as never)
  expect(heard).toEqual(['sounds/needs-you.wav'])

  // A quick job ends quietly; a long one chimes.
  await clock.advance(2 * 60_000)
  await callTool($, { tool: PROGRESS, task: 'Ship it', percent: 100 })
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(heard).toEqual(['sounds/needs-you.wav', 'sounds/done.wav'])

  await $.turn.start({ text: 'What time is it?', turnId: 't2' })
  await $.turn.complete({ answer: 'Noon', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(heard).toEqual(['sounds/needs-you.wav', 'sounds/done.wav'])
})

test('voice mode also says it in a few words', async ($, on) => {
  const { clock, heard } = soundWorld(on)
  await $.command.run({ command: 'glanceflow', args: 'sound voice' } as never)
  heard.length = 0
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' } as never)
  // The words follow the chime.
  await clock.advance(1)
  expect(heard).toEqual(['sounds/needs-you.wav', 'say: Claude needs you'])
})

test('desktop notices are off until turned on; then the computer says why Claude needs you', async ($, on) => {
  const { clock, heard } = soundWorld(on)
  const shown: string[][] = []
  on('process.run', (_, e) => {
    const argv = (e as { argv: readonly string[] }).argv
    // Not a Mac here: osascript cannot start, so Linux's notify-send shows it.
    if (argv[0] === 'osascript') throw new Error('osascript: not found')
    shown.push([...argv.slice(-2)])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Write it', 'Check it', 'Ship it'] })
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' } as never)
  await clock.advance(1)
  expect(shown).toEqual([])

  const result = await $.command.run({ command: 'glanceflow', args: 'notify on' } as never)
  expect(result.text).toContain('Desktop notices are on')
  await clock.advance(1)
  expect(shown).toEqual([['Claude needs you', 'This is how GlanceFlow will tell you.']])
  shown.length = 0

  await callTool($, { tool: 'Bash', command: 'ls' })
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' } as never)
  await clock.advance(1)
  expect(shown).toHaveLength(1)
  expect(shown[0][0]).toBe('Claude needs you')
  expect(shown[0][1]).not.toBe('')
  // Sounds stay off: a notice alone.
  expect(heard).toEqual([])

  await clock.advance(2 * 60_000)
  await callTool($, { tool: PROGRESS, task: 'Ship it', percent: 100 })
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1)
  expect(shown.at(-1)?.[0]).toBe('All done')

  await $.command.run({ command: 'glanceflow', args: 'notify off' } as never)
  shown.length = 0
  await $.turn.start({ text: 'Fix the footer', turnId: 't2' })
  await callTool($, { tool: PLAN, steps: ['Fix it', 'Check it'] })
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' } as never)
  await clock.advance(1)
  expect(shown).toEqual([])
})

test('a finished job with helpers still running chimes only when they finish', async ($, on) => {
  const { clock, heard } = soundWorld(on)
  await $.command.run({ command: 'glanceflow', args: 'sound on' } as never)
  heard.length = 0
  await $.turn.start({ text: 'Merge the pull request', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Merge it', 'Watch the checks'] })
  await clock.advance(2 * 60_000)
  await callTool($, { tool: PROGRESS, task: 'Watch the checks', percent: 100 })
  await $.turn.complete({ answer: 'Merged.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Watch CI' }],
  } as never)
  expect(heard.filter(one => one === 'sounds/done.wav').length).toBeLessThanOrEqual(1)
  const before = heard.length
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  expect(heard.slice(before)).toEqual(['sounds/done.wav'])
})

test('tool calls read as plain words', () => {
  expect(activityOf('Read', {})).toBe('Reading files')
  expect(activityOf('Grep', {})).toBe('Searching the project')
  expect(activityOf('Edit', {})).toBe('Editing files')
  expect(activityOf('Bash', { command: 'npm test -- --watch=false' })).toBe('Running the tests')
  expect(activityOf('Bash', { command: 'pnpm add zod' })).toBe('Installing packages')
  expect(activityOf('Bash', { command: 'git status' })).toBe('Working with git')
  expect(activityOf('Bash', { command: 'ls -la' })).toBe('Running a command')
  expect(activityOf('mcp__slack__post', {})).toBe('Using a connected app')
  expect(activityOf(PROGRESS, {})).toBe(null)
  expect(activityOf('TodoWrite', {})).toBe(null)
})

test('under the current step, what Claude is doing right now, in plain words', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Read notes', 'Write copy'] })
  await callTool($, { tool: 'Read', file_path: '/work/a.md' })
  await callTool($, { tool: 'Read', file_path: '/work/b.md' })
  let shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('Reading files (2)')
  expect(shown).not.toContain('a.md')

  await callTool($, { tool: 'Bash', command: 'npm test' })
  shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('Running the tests')
  expect(shown).not.toContain('Reading files')

  // A finished step starts the next one with a clean line.
  await callTool($, { tool: PROGRESS, task: 'Read notes', percent: 100 })
  shown = (await texts($, 'terminal')).join('\n')
  expect(shown).not.toContain('Running the tests')
})

test('calm mode: nothing moves, and statuses read in bold', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const result = await $.command.run({ command: 'glanceflow', args: 'calm on' } as never)
  expect(result.text).toContain('Calm mode is on')
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Read notes', 'Write copy'] })
  // Only the clock text may change between frames; the bars and marks stay still.
  const still = (lines: string[]) => lines.join('\n').replace(/\d+s/g, '')
  const first = still(await texts($, 'terminal'))
  await clock.advance(750)
  const later = still(await texts($, 'terminal'))
  expect(later).toBe(first)
  expect(first).toContain('░░░░░░░░░░')

  await callTool($, { tool: PROGRESS, task: 'Write copy', percent: 100 })
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const done = (await ui.findAll({ type: 'Text' })).find(one => one.text.includes('All done'))
  await ui.unmount()
  expect((done?.props as { bold?: boolean } | undefined)?.bold).toBe(true)
})

test('costs read in plain dollars', () => {
  expect(formatCost(0.004)).toBe('<$0.01')
  expect(formatCost(0.4199)).toBe('$0.42')
  expect(formatCost(3)).toBe('$3.00')
})

test("in details, a job shows what it cost, and the history keeps it", async ($, on) => {
  world(on)
  historyWorld(on, { cwd: '/work/landing-site' })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const measure = (usd: number) =>
    $.session.measure({ context: { window: 200_000, tokens: 1000, percent: 1 }, rateLimits: [], cost: { usd }, changed: ['cost'] } as never)
  await measure(1)
  await detailsOn($)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Write it', 'Check it'] })
  await measure(1.42)
  expect((await texts($, 'terminal', 120)).join('\n')).toContain('$0.42')
  // Simple keeps money out of view.
  await $.command.run({ command: 'glanceflow', args: 'details off' } as never)
  expect((await texts($, 'terminal', 120)).join('\n')).not.toContain('$0.42')

  await callTool($, { tool: PROGRESS, task: 'Check it', percent: 100 })
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.command.run({ command: 'glanceflow', args: 'history' } as never)
  const pane = (await paneTexts($)).join('\n')
  expect(pane).toContain('$0.42')
})

/** A long chat, so the band offers Tidy it up; the test says what compaction and /compact do. */
async function tidyWorld($: Engine, on: On, compactCommand: () => void) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text: string }).text))
    return undefined as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.compact', () => {
    throw new Error('not now')
  })
  const commands: string[] = []
  on('command.run', (_, e) => {
    commands.push(e.command)
    if (e.command === 'compact') compactCommand()
    return { text: '' }
  })
  await $.session.measure({ context: { window: 200_000, tokens: 160_000, percent: 80 }, rateLimits: [], changed: ['context'] } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'compact' })
  await ui.unmount()
  return { toasts, commands }
}

test('Tidy it up falls back to /compact when the engine refuses to compact', async ($, on) => {
  const { toasts, commands } = await tidyWorld($, on, () => undefined)
  expect(commands).toContain('compact')
  expect(toasts.join('\n')).not.toContain("Couldn't tidy up")
})

test('when /compact fails too, Tidy it up says why', async ($, on) => {
  const { toasts } = await tidyWorld($, on, () => {
    throw new Error('a turn is running')
  })
  // The engine's reason shows in brackets, so the next report says what went wrong.
  expect(toasts.join('\n')).toMatch(/Couldn't tidy up the chat \(.+\)\. Type \/compact to try again\./)
})

test("once, GlanceFlow brings over Glance's settings and history; another mod's store is left alone", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  mock.env(on, { HOME: '/home/me' })
  const job = { jobId: 'j1', project: '/work', startedAt: 1, finishedAt: 2, title: 'Build the page', outcome: 'done', stepsDone: 1, stepsTotal: 1, newTokens: 0, cachedTokens: 0, doneSteps: ['Build the page'], openSteps: [], isQuickAnswer: false }
  const files: Record<string, unknown> = {
    'glance_claude-mods-1a2b.json': { 'history:2026-10-06': [job], glanceDetail: 'detailed', glanceSound: 'chime' },
    'glance_other-3c4d.json': { 'history:2026-10-06': [{ id: 'not ours' }], enabled: false },
    'notes_x-5e6f.json': { glanceCalm: true },
  }
  const reads: string[] = []
  on('fs.list', (_, e) => {
    expect(e.path).toBe('/home/me/.claude/plugins/store')
    return { value: Object.keys(files).map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) } as never
  })
  on('fs.read', (_, e) => {
    reads.push(e.path)
    return { value: JSON.stringify(files[e.path.split('/').pop()!]) } as never
  })
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  await $.session.start({ cwd: '/work', surface: 'terminal' } as never)
  await $.session.start({ cwd: '/work', surface: 'terminal' } as never)

  expect(store.get('history:2026-10-06')).toEqual([job])
  expect(store.get('glanceDetail')).toBe('detailed')
  expect(store.get('glanceSound')).toBe('chime')
  expect(store.get('glanceEnabled')).toBeUndefined()
  expect(store.get('glanceCalm')).toBeUndefined()
  expect(reads).toHaveLength(2)
})

/** A finished job in History: `units` of step size that took `ms` in all. */
function pastJob(jobId: string, project: string, units: number, ms: number, outcome: GlanceOutcome = 'done'): GlanceHistoryEntry {
  return { jobId, project, startedAt: 1, finishedAt: 2, title: 'Earlier job', outcome, stepsDone: 2, stepsTotal: 2, newTokens: 0, cachedTokens: 0, doneSteps: [], openSteps: [], isQuickAnswer: false, doneUnits: units, doneMs: ms }
}

test("a project's pace comes from its finished jobs, once there is enough to go on", () => {
  const site = '/work/landing-site'
  expect(paceFromHistory([pastJob('a', site, 4, 240_000)], site)).toBeNull()
  expect(
    paceFromHistory(
      [
        pastJob('a', site, 4, 240_000),
        pastJob('b', site, 4, 240_000),
        pastJob('c', '/work/other', 8, 10),
        pastJob('d', site, 8, 10, 'stopped'),
      ],
      site,
    ),
  ).toBe(60_000)
})

test("with this project's pace known, time left shows from the first step and leans toward this job's own pace", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'history:2026-10-05': [pastJob('a', '/work/landing-site', 4, 240_000), pastJob('b', '/work/landing-site', 4, 240_000)] })
  on('session.cwd', () => ({ value: '/work/landing-site' }) as never)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  // 1 + 2 + 2 + 3 = 8 units at this project's 1 minute a unit.
  await callTool($, { tool: PLAN, steps: ['Read notes', 'Write copy', 'Add form', 'Polish it'], sizes: ['S', 'M', 'M', 'L'] })
  expect((await texts($, 'terminal')).join('\n')).toContain('about 8m left')

  // This job's first unit took 30s: (30s + 2 × 60s) / 3 = 50s a unit, × 7 units left ≈ 6m.
  await clock.advance(30_000)
  await callTool($, { tool: PROGRESS, task: 'Read notes', percent: 100 })
  expect((await texts($, 'terminal')).join('\n')).toContain('about 6m left')
})

test('a finished job keeps the size and time of its steps, so the next job learns from it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  on('session.cwd', () => ({ value: '/work/landing-site' }) as never)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Notification', () => ({}) as never)

  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Write copy', 'Polish it'], sizes: ['M', 'L'] })
  await clock.advance(2 * 60_000)
  await callTool($, { tool: PROGRESS, task: 'Write copy', percent: 100 })
  await clock.advance(3 * 60_000)
  await callTool($, { tool: PROGRESS, task: 'Polish it', percent: 100 })
  await $.turn.complete({ turnId: 't1' } as never)

  const saved = [...store.entries()].find(([key]) => key.startsWith('history:'))?.[1] as { doneUnits: number; doneMs: number }[]
  expect(saved[0]?.doneUnits).toBe(5)
  expect(saved[0]?.doneMs).toBe(5 * 60_000)
})

test("a finished step's summary shows under it until Claude moves on, and code stays out of it", async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Add pricing', 'Check it'] })
  await callTool($, {
    tool: PROGRESS,
    task: 'Add pricing',
    percent: 100,
    summary: 'Added a pricing table with three plans in `src/Pricing.tsx`',
  })
  let shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('    Added a pricing table with three plans in')
  expect(shown).not.toContain('Pricing.tsx')

  await callTool($, { tool: 'Read', file_path: '/work/a.md' })
  shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('Reading files')
  expect(shown).not.toContain('Added a pricing table')
})

test("the team report says what each step got done, in Claude's words where it gave them", () => {
  const report = teamReport({
    day: '2026-10-06',
    project: '/work/landing-site',
    entries: [
      { ...ENTRY, jobId: 'a', startedAt: 0, finishedAt: 12 * 60_000, title: 'Build the pricing section', outcome: 'done', stepsDone: 2, stepsTotal: 2, doneSteps: ['Write it', 'Check it'], doneNotes: ['Added three plans with monthly and yearly prices', ''], openSteps: [] },
    ],
  })
  expect(report).toContain('  ✓ Added three plans with monthly and yearly prices\n  ✓ Check it')
})

test('the weekly team report covers the 7 days up to the day picked, and This week switches to it', async ($, on) => {
  mock.clock(on, { now: new Date(2026, 9, 6, 18, 0).getTime() })
  const job = (jobId: string, day: number, title: string) => ({
    ...ENTRY,
    jobId,
    startedAt: new Date(2026, 9, day, 9, 0).getTime(),
    finishedAt: new Date(2026, 9, day, 9, 30).getTime(),
    title,
    outcome: 'done',
    stepsDone: 1,
    stepsTotal: 1,
    doneSteps: [title],
    openSteps: [],
  })
  mock.store(on, {
    'history:2026-10-06': [job('a', 6, 'Build the pricing section')],
    'history:2026-10-02': [job('b', 2, 'Fix the contact form')],
    'history:2026-09-29': [job('c', 29 - 30, 'Too old for this week')],
  })
  let copied = ''
  on('session.cwd', () => ({ value: '/work/landing-site' }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => undefined as never)
  on('ui.copy', (_, e) => {
    copied = e.text
    return { value: { isCopied: true } } as never
  })
  await $.command.run({ command: 'glanceflow', args: 'history' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'report' })
  await ui.unmount()
  const report = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await report.press({ key: 'span' })
  await report.unmount()
  expect(copied).toMatch(/Weekly update · landing-site · 30 Sept? 2026 to 6 Oct 2026/)
  expect(copied).toContain('• Build the pricing section (30 min)')
  expect(copied).toContain('• Fix the contact form (30 min)')
  expect(copied).not.toContain('Too old')
  expect(copied).toContain('2 of 2 tasks finished · 1 h of work')
  expect((await paneTexts($)).join('\n')).toContain('This day')
})

test('your week sums up every project: steps, tasks, time, the busiest day and the biggest tasks', async ($, on) => {
  mock.clock(on, { now: new Date(2026, 9, 6, 18, 0).getTime() })
  const job = (jobId: string, day: number, title: string, steps: number, project = '/work/landing-site') => ({
    ...ENTRY,
    jobId,
    project,
    startedAt: new Date(2026, 9, day, 9, 0).getTime(),
    finishedAt: new Date(2026, 9, day, 9, 30).getTime(),
    title,
    outcome: 'done',
    stepsDone: steps,
    stepsTotal: steps,
    doneSteps: Array.from({ length: steps }, (_, at) => `Step ${at + 1}`),
    openSteps: [],
  })
  mock.store(on, {
    'history:2026-10-06': [job('a', 6, 'Build the pricing section', 4), job('b', 6, 'Write the newsletter', 2, '/work/newsletter')],
    'history:2026-10-02': [job('c', 2, 'Fix the contact form', 1), { ...job('q', 2, 'What time is it?', 0), isQuickAnswer: true }],
    'history:2026-09-29': [job('d', 29 - 30, 'Too old for this week', 5)],
  })
  let copied = ''
  on('session.cwd', () => ({ value: '/work/landing-site' }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => undefined as never)
  on('ui.copy', (_, e) => {
    copied = e.text
    return { value: { isCopied: true } } as never
  })
  const result = await $.command.run({ command: 'glanceflow', args: 'week' } as never)
  expect(result.text).toBe('Claude checked off 7 steps in 3 tasks, and finished 3 of them.')
  expect(copied).toMatch(/Your week with Claude · 30 Sept? 2026 to 6 Oct 2026/)
  expect(copied).toContain('Time at work: 1 h 30 min, across 2 projects.')
  expect(copied).toContain('Busiest day: Tuesday, with 2 tasks.')
  expect(copied).toContain('• Build the pricing section (4 steps)')
  expect(copied).toContain('• Write the newsletter (2 steps)')
  expect(copied).not.toContain('Too old')
  expect(copied).not.toContain('What time is it')
  const shown = (await paneTexts($)).join('\n')
  expect(shown).toContain('Your week with Claude')
  expect(shown).not.toContain('This week')

  // From the list, Your week shows it again.
  const back = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await back.press({ key: 'back' })
  await back.unmount()
  copied = ''
  const list = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await list.press({ key: 'mine' })
  await list.unmount()
  expect(copied).toContain('Claude checked off 7 steps in 3 tasks')
})

test('a week with no planned work says so plainly', () => {
  expect(weekSummary([], '2026-10-06')).toContain('No planned work was recorded this week.')
})

test("the band says in one whole sentence what Claude is doing; the Plan says more", async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Check the page', 'Fix the links'] })
  await callTool($, { tool: 'Bash', command: 'npx playwright test --project=mobile', description: 'Check the page on a phone screen' })
  let shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('Now: Check the page on a phone screen')
  expect(shown).not.toContain('playwright')
  expect(shown).not.toContain('…')

  // Too long for a narrow band: the short label instead of a cut sentence.
  shown = (await texts($, 'terminal', 34)).join('\n')
  expect(shown).toContain('Running the tests')
  expect(shown).not.toContain('Now: Check')

  // The Plan, in Details, adds what Claude runs.
  await detailsOn($)
  const pane = await planPaneTexts($)
  expect(pane).toContain('Now: Check the page on a phone screen')
  expect(pane).toContain('↳ npx playwright test --project=mobile')
})

test('the Plan shows long step names whole in a narrow panel', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Keep the product profile private', 'Load the social media guide'] })
  const ui = await $.ui.mount({ ...PLAN_PANE, props: { ...PLAN_PANE.props, bodyColumns: 40 }, surface: 'terminal' })
  const pane = (await ui.findAll({ type: 'Text' })).map(one => one.text).join('\n')
  await ui.unmount()
  expect(pane).toContain('Keep the product profile private')
  expect(pane).toContain('Load the social media guide')
  expect(pane).not.toContain('priva…')
})

test('a request in another language gets an English title', () => {
  expect(isLatinText('Build my landing page')).toBe(true)
  expect(isLatinText('Φτιάξε τη σελίδα μου')).toBe(false)
  expect(isStartWords('Go ahead')).toBe(true)
  expect(isStartWords('ξεκίνα')).toBe(true)
  expect(isStartWords('change step two')).toBe(false)
})

test('with Approve the plan first on, Claude waits for Start before it works', async ($, on) => {
  world(on)
  const on_ = await $.command.run({ command: 'glanceflow', args: 'approve on' } as never)
  expect(on_.text).toContain('waits')
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  const planned = await callTool($, { tool: PLAN, steps: ['Write the page', 'Check it'] })
  expect(String(planned.result)).toContain('wait for their reply')
  let shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('Read the plan, then press Start')
  expect(shown).toContain('▶ Start')
  const denied = await callTool($, { tool: 'Bash', command: 'ls' })
  expect(denied.deny).toContain('not approved')

  await $.turn.start({ text: 'The plan looks good. Please start.', turnId: 't2' })
  const ran = await callTool($, { tool: 'Bash', command: 'ls' })
  expect(ran.deny).toBeUndefined()
  shown = (await texts($, 'terminal')).join('\n')
  expect(shown).not.toContain('▶ Start')
  expect(shown).toContain('Write the page')
})

const PLAN_PANE = {
  plugin: 'glanceflow',
  component: 'Pane',
  requestId: 'glanceflow-plan',
  props: { title: 'Plan', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

async function planPaneTexts($: Engine): Promise<string> {
  const ui = await $.ui.mount({ ...PLAN_PANE, surface: 'terminal' })
  const found = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))].map(one => one.text)
  await ui.unmount()

  return found.join('\n')
}

test('▤ Plan opens the whole plan beside the chat: every step, what it got done, its time and what Claude is doing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Notification', () => ({}) as never)

  expect(await planPaneTexts($)).toContain('No plan yet')
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  const steps = ['Read notes', 'Write copy', 'Add pricing', 'Add form', 'Add footer', 'Add menu', 'Check phones', 'Ship it']
  await callTool($, { tool: PLAN, steps })
  await clock.advance(90_000)
  await callTool($, { tool: PROGRESS, task: 'Read notes', percent: 100, summary: 'Found your colors and tone of voice' })
  await callTool($, { tool: 'Read', file_path: '/work/copy.md' })

  // The band keeps to its rows; the panel has room for every step.
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 6 }, surface: 'terminal' })
  await band.press({ key: 'plan' })
  await band.unmount()
  expect(opened).toEqual(['glanceflow-plan'])

  const pane = await planPaneTexts($)
  for (const name of steps) expect(pane).toContain(name)
  expect(pane).toContain(' took 1m 30s')
  expect(pane).toContain('    Found your colors and tone of voice')
  expect(pane).toContain('    Now: Reading files')
  expect(pane).toContain('1 of 8 steps done')
  // More than the band: when it started, the steps grouped, and how long each step still to come should take.
  expect(pane).toMatch(/Started \d\d:\d\d · 1m 30s so far/)
  expect(pane).toContain('Done\n')
  expect(pane).toContain('Now\n')
  expect(pane).toContain('Next\n')
  expect(pane).toContain(' about 2m')

  // In Details, the same percentage as the band, tokens per step, and what Claude needs from you.
  await $.command.run({ command: 'glanceflow', args: 'details on' } as never)
  await clock.advance(60_000)
  await callTool($, { tool: 'mcp__glanceflow__report_progress', task: 'Write copy', percent: 100 })
  await clock.advance(30_000)
  await callTool($, { tool: 'mcp__glanceflow__report_progress', task: 'Add pricing', percent: 40 })
  const band40 = (await texts($, 'terminal')).join('\n')
  const percent = /· (\d+)% ·/.exec(band40)?.[1]
  const details = await planPaneTexts($)
  expect(details).toContain(` ${percent}% · 2 of 8 steps done`)
  // Time left follows the percentage shown, so band and panel agree.
  const bandLeft = /about (\S+) left/.exec(band40)?.[1]
  expect(bandLeft).toBeDefined()
  expect(details).toContain(`about ${bandLeft} left`)
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' } as never)
  expect(await planPaneTexts($)).toContain("Needs you: Answer Claude's request in the chat")
  const desktop = await $.ui.mount({ ...PLAN_PANE, surface: 'desktop' })
  expect((await desktop.findAll({ type: 'Text' })).map(one => one.text).join('\n')).toContain('Ship it')
  await desktop.unmount()

  const result = await $.command.run({ command: 'glanceflow', args: 'plan' } as never)
  expect(result.text).toBe('The plan is in the side panel.')
  expect(opened).toHaveLength(2)
})

test('"continue" typed after Esc picks the same job up; a new request starts a new one', async ($, on) => {
  world(on)
  expect(['continue', 'Continue.', 'go on', 'keep going', 'please continue', 'Συνέχισε', 'συνέχισε παρακαλώ', 'προχώρα'].every(isContinueWords)).toBe(true)
  expect(['continue with the footer', 'add a menu', 'συνέχισε με το μενού'].some(isContinueWords)).toBe(false)

  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Write the page', 'Check it', 'Ship it'] })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
  let shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('■ Stopped')
  expect(shown).toContain('\nStopped')

  await $.turn.start({ text: 'συνέχισε', turnId: 't2' })
  shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('Build my landing page')
  expect(shown).toContain('Write the page')
  expect(shown).not.toContain('Stopped')

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' })
  await $.turn.start({ text: 'Add a contact form', turnId: 't3' })
  shown = (await texts($, 'terminal')).join('\n')
  expect(shown).not.toContain('Write the page')
})

test('the step Claude waits on says Waiting', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Write the page', 'Check it'] })
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' } as never)
  const shown = (await texts($, 'terminal')).join('\n')
  expect(shown).toContain('Needs you')
  expect(shown).toContain('\nWaiting')
  expect(shown).not.toContain('\nWorking')
})

test('in Simple the percentage moves with time before a step is checked off', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Write the page', 'Check it'] })
  expect((await texts($, 'terminal')).join('\n')).toContain(' · 0% · ')
  await clock.advance(90_000)
  const percent = Number(/ · (\d+)% · /.exec((await texts($, 'terminal')).join('\n'))?.[1])
  expect(percent).toBeGreaterThan(0)
  expect(percent).toBeLessThan(50)
})

test('in a narrow window the button gets short and the bars go before step names do', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] })
  const wide = (await texts($, 'terminal', 80)).join('\n')
  expect(wide).toContain('● GlanceFlow: Simple')
  expect(wide).toContain('░░░░░░░░░░')

  const narrow = (await texts($, 'terminal', 36)).join('\n')
  expect(narrow).toContain('● Simple')
  expect(narrow).not.toContain('GlanceFlow: Simple')
  expect(narrow).not.toContain('░░░░')
  expect(narrow).toContain('Read your brand notes')
})

test('⚙ Settings opens one panel for the view, sounds and calm mode, each with a line on what it does', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const opened: string[] = []
  const played: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('audio.play', (_, e) => {
    played.push(String((e.clip as { asset?: string }).asset))
    return { value: undefined } as never
  })
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: {} } as never }))
  on('ui.toast', () => undefined as never)
  on('tool.call', () => ({ result: {} as never }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  const SETTINGS = {
    plugin: 'glanceflow',
    component: 'Pane',
    requestId: 'glanceflow-settings',
    props: { title: 'Settings', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as const
  const settingsTexts = async () => {
    const ui = await $.ui.mount({ ...SETTINGS, surface: 'terminal' })
    const found = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))].map(one => one.text).join('\n')
    await ui.unmount()
    return found
  }
  const pick = async (key: string) => {
    const ui = await $.ui.mount({ ...SETTINGS, surface: 'terminal' })
    await ui.press({ key })
    await ui.unmount()
  }

  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await callTool($, { tool: PLAN, steps: ['Write the page', 'Check it'] })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'settings' })
  await band.unmount()
  expect(opened).toEqual(['glanceflow-settings'])

  let shown = await settingsTexts()
  expect(shown).toContain('● Simple')
  expect(shown).toContain('● Off')
  expect(shown).toContain('No sounds')
  expect(shown).toContain('Bars and spinners move')
  expect(shown).toContain('● 50%')

  await pick('view-detailed')
  await pick('sound-chime')
  await pick('calm-on')
  shown = await settingsTexts()
  expect(shown).toContain('● Details')
  expect(shown).toContain('● Chime')
  expect(shown).toContain('A short chime when Claude needs you')
  expect(shown).toContain('▶ Play it')
  expect(shown).toContain('Nothing on screen moves')
  expect(shown).toContain('● On')
  expect(played).toEqual(['sounds/needs-you.wav'])
  expect((await texts($, 'terminal')).join('\n')).toContain('GlanceFlow: Details')

  await pick('view-off')
  expect((await texts($, 'terminal')).join('\n')).toContain('GlanceFlow: Off')

  const result = await $.command.run({ command: 'glanceflow', args: 'settings' } as never)
  expect(result.text).toBe('Settings are in the side panel.')
  expect(opened).toHaveLength(2)
})

test('Tidy it up shows at the point picked in Settings, 50% full unless changed', async ($, on) => {
  world(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const full = async (percent: number) => {
    await $.session.measure({ context: { window: 200_000, tokens: percent * 2000, percent }, rateLimits: [], changed: ['context'] } as never)
    return (await texts($, 'terminal')).join('\n')
  }
  expect(await full(45)).not.toContain('Tidy it up')
  expect(await full(52)).toContain('This chat is 52% full. Claude saves a checkpoint')

  await $.command.run({ command: 'glanceflow', args: 'tidy at 60' } as never)
  expect(await full(52)).not.toContain('Tidy it up')
  expect(await full(61)).toContain('Tidy it up')
  const off = await $.command.run({ command: 'glanceflow', args: 'tidy off' } as never)
  expect(off.text).toBe('GlanceFlow will not offer to tidy up.')
  expect(await full(90)).not.toContain('Tidy it up')
})

test('Tidy it up saves a checkpoint first, compacts keeping it, and Claude reads it afterwards', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text: string }).text))
    return undefined as never
  })
  on('session.id', () => ({ value: 'chat-1' }) as never)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const forked: string[] = []
  on('model.fork', (_, e) => {
    forked.push(e.prompt)
    return { value: { isAnswered: true, text: 'Checkpoint: the pricing page is done; next, the contact form.', usage: {} } } as never
  })
  let instructions = ''
  on('session.compact', (_, e) => {
    instructions = String((e as { instructions?: string }).instructions ?? '')
    return { messages: [{ role: 'user', text: 'Summary of the chat so far.', toolUses: [] }] } as never
  })
  on('prompt.compose', () => ({ sections: [] }) as never)

  await $.session.measure({ context: { window: 200_000, tokens: 110_000, percent: 55 }, rateLimits: [], changed: ['context'] } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'compact' })
  await ui.unmount()

  expect(forked[0]).toContain('Write a checkpoint')
  expect(instructions).toContain('Checkpoint: the pricing page is done; next, the contact form.')
  expect(toasts).toContain('Chat tidied up. Claude keeps the checkpoint.')
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [], sections: [] } as never)
  const checkpoint = (composed as unknown as { sections: { id: string; text: string }[] }).sections.find(one => one.id === 'glanceflow:checkpoint')
  expect(checkpoint?.text).toContain('the pricing page is done')
})
