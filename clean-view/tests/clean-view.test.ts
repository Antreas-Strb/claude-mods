import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { carryTokens, cleanName, formatTokens, headerDetails, ownWords, prettyModel } from '../hooks/clean-view'
import { findSecrets, maskPrivate } from '../hooks/privacy'

const PLAN = 'mcp__clean-view__plan_steps'
const PROGRESS = 'mcp__clean-view__report_progress'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  plugin: 'clean-view',
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
  await $.command.run({ command: 'simple', args: 'details on' } as never)
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
    expect(shown).toContain('Up next')
    expect(shown).toContain('Clean View: Simple')
  }
})

test('a permission prompt shows Needs you', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })

  for (const surface of SURFACES) {
    const shown = (await texts($, surface)).join('\n')
    expect(shown).toContain('Needs you')
    expect(shown).toContain('Claude needs your OK to continue')
    expect(shown).toContain('‖')
  }
})

test('/simple off hides the band but keeps the button', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.command.run({ command: 'simple', args: 'off' } as never)

  for (const surface of SURFACES) {
    const shown = (await texts($, surface)).join('\n')
    expect(shown).not.toContain('Understand your request')
    expect(shown).toContain('Clean View: Off')
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

describe('privacy', () => {
  test('passwords, keys and card numbers are found', () => {
    expect(findSecrets('my password is hunter22')).toContain('a password')
    expect(findSecrets('ο κωδικός μου είναι gata1234')).toContain('a password')
    expect(findSecrets('use sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456')).toContain('a key or token')
    expect(findSecrets('API_KEY=abcd1234efgh')).toContain('a password or key')
    expect(findSecrets('card 4242 4242 4242 4242 please')).toContain('a card number')
  })

  test('ordinary messages are left alone', () => {
    expect(findSecrets('Build my landing page with a pricing section')).toEqual([])
    expect(findSecrets('Order 1234 5678 is late')).toEqual([])
  })

  test('the screen hides emails, phones and keys; names drop them', () => {
    const masked = maskPrivate('mail jane@example.com or call 555-123-4567, key sk-ant-api03-abcdefghijklmnopqrstuv')
    expect(masked).not.toContain('jane@example.com')
    expect(masked).not.toContain('555-123-4567')
    expect(masked).not.toContain('sk-ant-api03')
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
  const prompt = { text: 'log in with password: hunter22', wait: false, origin: { kind: 'composer' } } as never

  const first = await $.prompt.submit(prompt)
  expect((first as { drop?: string }).drop).toContain('password')
  expect(entered).toBe(0)

  await $.prompt.submit(prompt)
  expect(entered).toBe(1)

  await $.prompt.submit({ text: 'Build my landing page', wait: false, origin: { kind: 'composer' } } as never)
  expect(entered).toBe(2)
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

  const footer = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
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
    expect(shown).toContain('This chat is getting long')
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
    { id: 'a', name: 'Understand your request', status: 'active', percent: 0, hasReported: false, size: 'M', tokens: 500, cachedTokens: 100, startedAt: null, finishedAt: null },
  ] as const
  const next = [
    { id: 'p0', name: 'Write the page', status: 'active', percent: 0, hasReported: false, size: 'M', tokens: 0, cachedTokens: 0, startedAt: null, finishedAt: null },
    { id: 'p1', name: 'Check it', status: 'upcoming', percent: 0, hasReported: false, size: 'M', tokens: 0, cachedTokens: 0, startedAt: null, finishedAt: null },
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
    // 1,000 + 1,000 + 10,000 + 400 = 12.4k, 10,000 of them from the cache: 81%.
    expect(shown).toContain('12.4k tokens · 81% cached')
    expect(shown).toContain('12.4k tokens')
  }

  await callTool($, { tool: PROGRESS, task: 'Write copy', percent: 100 })
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect((await texts($, 'terminal', 120)).join('\n')).toMatch(/All done .* · 12\.4k tokens/)
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
    expect(simple).toContain('Clean View: Simple')
    expect(simple).not.toContain('Haiku 4.5')
    expect(simple).not.toContain('tokens')
    expect(simple).not.toContain('Plan usage')
  }

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 120 }, surface: 'terminal' })
  await ui.press({ key: 'toggle' })
  await ui.unmount()
  const detailed = (await texts($, 'terminal', 120)).join('\n')
  expect(detailed).toContain('Clean View: Details')
  expect(detailed).toContain('Explore · Haiku 4.5')
  expect(detailed).toContain('tokens')
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
  expect((await texts($, 'terminal')).join('\n')).toContain('Clean View: Simple')
  await press()
  expect((await texts($, 'terminal')).join('\n')).toContain('Clean View: Details')
  await press()
  expect((await texts($, 'terminal')).join('\n')).toContain('Clean View: Off')
  await press()
  expect((await texts($, 'terminal')).join('\n')).toContain('Clean View: Simple')
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
