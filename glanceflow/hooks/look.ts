/**
 * GlanceFlow's look: one icon set and one set of tones, so every screen draws the same marks.
 *
 * Surfaces that draw vectors (the desktop app, VS Code, the phone) get these SVG icons and meters; the terminal draws
 * the glyph named beside each, one cell wide. Both come from the same names, so a status reads the same everywhere.
 */

export type Tone = 'ok' | 'active' | 'warn' | 'alert' | 'quiet'

/**
 * The vector tones, matched to the desktop app's own green, blue, amber and grey; an image can't read the app's
 * theme, so each also stays visible on a light window.
 */
export const TONE: Record<Tone, string> = {
  ok: '#3fa45a',
  active: '#3194d4',
  warn: '#d9970b',
  alert: '#e0574b',
  quiet: '#8e8e8e',
}

/** The same tones as the terminal names them, for text and glyphs. */
export const TONE_TEXT: Record<Tone, string | undefined> = {
  ok: 'green',
  active: 'cyan',
  warn: 'yellow',
  alert: 'red',
  quiet: undefined,
}

/** Each icon on a 24 × 24 grid, stroked 1.75 wide with round ends and joins: one weight and one corner for all. */
const PATHS = {
  check: '<path d="M6.8 12.5l3.4 3.4 7-7.4"/>',
  done: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.4l2.4 2.4 4.7-5"/>',
  alert: '<path d="M10.3 5.1a2 2 0 0 1 3.4 0l6.9 11.9a2 2 0 0 1-1.7 3H5.1a2 2 0 0 1-1.7-3z"/><path d="M12 10v3.6"/><path d="M12 16.6v.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.6V12l2.9 1.9"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  pause: '<path d="M9 6.6v10.8M15 6.6v10.8" stroke-width="3.2"/>',
  play: '<path d="M8.6 6.8v10.4a.8.8 0 0 0 1.2.7l8.2-5.2a.8.8 0 0 0 0-1.4L9.8 6.1a.8.8 0 0 0-1.2.7z"/>',
  close: '<path d="M8 8l8 8M16 8l-8 8"/>',
  plan: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="M4.8 6.5h.01M4.8 12h.01M4.8 17.5h.01"/>',
  history: '<path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8"/><path d="M3.6 4.3v4.1h4.1"/><path d="M12 7.8v4.4l2.9 1.8"/>',
  sliders: '<path d="M4 7.5h9.3M18.1 7.5H20"/><circle cx="15.7" cy="7.5" r="2.3"/><path d="M4 16.5h1.9M10.7 16.5H20"/><circle cx="8.3" cy="16.5" r="2.3"/>',
  fresh: '<path d="M5.6 5h12.8A1.6 1.6 0 0 1 20 6.6v8.8a1.6 1.6 0 0 1-1.6 1.6H10.6L6 20.4V17h-.4A1.6 1.6 0 0 1 4 15.4V6.6A1.6 1.6 0 0 1 5.6 5z"/><path d="M12 8.4v5.2M9.4 11h5.2"/>',
  bang: '<path d="M12 7.2v5.6"/><path d="M12 16.6v.01"/>',
  eye: '<path d="M2.8 12S6 6.2 12 6.2 21.2 12 21.2 12 18 17.8 12 17.8 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.6"/>',
  sound: '<path d="M4.2 9.8v4.4h3.3l4.2 3.5V6.3L7.5 9.8z"/><path d="M15.3 9.3a3.8 3.8 0 0 1 0 5.4"/><path d="M17.9 6.8a7.4 7.4 0 0 1 0 10.4"/>',
  bell: '<path d="M6.3 16.6v-5.1a5.7 5.7 0 0 1 11.4 0v5.1l1.4 1.8H4.9z"/><path d="M10.1 21h3.8"/>',
  moon: '<path d="M19.6 14.4A7.9 7.9 0 0 1 9.6 4.4a7.9 7.9 0 1 0 10 10z"/>',
  approve: '<rect x="4.2" y="4.2" width="15.6" height="15.6" rx="3.2"/><path d="M8.3 12.2l2.5 2.5 4.9-5.1"/>',
  lock: '<rect x="5.2" y="10.6" width="13.6" height="9.4" rx="2.2"/><path d="M8.3 10.6V8a3.7 3.7 0 0 1 7.4 0v2.6"/><path d="M12 14.3v2"/>',
  tidy: '<path d="M8 4.8l4 4 4-4"/><path d="M8 19.2l4-4 4 4"/><path d="M5 12h14"/>',
  file: '<path d="M13.6 3.9H7.3a1.4 1.4 0 0 0-1.4 1.4v13.4a1.4 1.4 0 0 0 1.4 1.4h9.4a1.4 1.4 0 0 0 1.4-1.4V8.4z"/><path d="M13.6 3.9v4.5h4.5"/>',
  sub: '<path d="M7 5v7a3 3 0 0 0 3 3h7.5"/><path d="M14.6 12l3 3-3 3"/>',
  spark: '<path d="M12 4.5c.5 3.9 3.6 7 7.5 7.5-3.9.5-7 3.6-7.5 7.5-.5-3.9-3.6-7-7.5-7.5 3.9-.5 7-3.6 7.5-7.5z"/>',
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1v14l-6-4-6 4v-14a1 1 0 0 1 1-1z"/>',
  ship: '<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="12" r="2.2"/><path d="M7 8.2v7.6"/><path d="M7 8.2c0 2.8 2.6 3.8 7.8 3.8"/>',
  more: '<path d="M6.4 12h.01M12 12h.01M17.6 12h.01" stroke-width="3.4"/>',
} as const

export type IconName = keyof typeof PATHS

/** What a terminal draws for each icon: one cell wide, so rows line up. */
export const GLYPH: Record<IconName, string> = {
  check: '✓',
  done: '✓',
  alert: '⚠',
  clock: '◷',
  stop: '■',
  pause: '‖',
  play: '▶',
  close: '✗',
  plan: '▤',
  history: '≣',
  sliders: '⚙',
  fresh: '↻',
  bang: '!',
  eye: '◉',
  sound: '♪',
  bell: '◈',
  moon: '☾',
  approve: '▣',
  lock: '◆',
  tidy: '⇅',
  file: '▫',
  sub: '↳',
  spark: '✦',
  bookmark: '◆',
  ship: '⇡',
  more: '…',
}

const XMLNS = 'xmlns="http://www.w3.org/2000/svg"'

/**
 * A line icon in one tone, `size` px wide. Given a taller `height` (a line of text), it sits centered in it, so a
 * mark lines up with the first line of the text beside it.
 */
export function iconSvg(name: IconName, tone: Tone, size = 16, height = size): string {
  // Small icons get a heavier line, so they keep the weight of the text beside them.
  return `<svg ${XMLNS} viewBox="0 0 24 24" width="${size}" height="${height}" fill="none" stroke="${TONE[tone]}" stroke-width="${size <= 14 ? 2.1 : 1.75}" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`
}

/** A filled disc with the icon cut out in white: a step that is done, failed, waits on you or stopped. */
export function badgeSvg(name: IconName, tone: Tone, size = 16, height = size): string {
  return `<svg ${XMLNS} viewBox="0 0 24 24" width="${size}" height="${height}" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" fill="${TONE[tone]}"/><g stroke="#fff" stroke-width="2.3">${PATHS[name]}</g></svg>`
}

const RING = 2 * Math.PI * 8.5

/**
 * The current step: a ring that fills with its percentage. With none, a short arc stands at the turn `turn` gives
 * (a twelfth of a circle each), so a screen redrawn each tick spins it and a still screen holds it.
 */
export function ringSvg(tone: Tone, size = 16, percent: number | null = null, turn = 0, height = size): string {
  const known = percent !== null
  // A ring barely begun still shows a sliver, so it never reads as a step still to come.
  const length = (known ? Math.max(8, Math.min(100, percent)) / 100 : 0.3) * RING
  const start = known ? -90 : -90 + (turn % 12) * 30
  const arc =
    length > 0.5
      ? `<circle cx="12" cy="12" r="8.5" stroke="${TONE[tone]}" stroke-width="3" stroke-dasharray="${length.toFixed(2)} ${RING.toFixed(2)}" transform="rotate(${start} 12 12)"/>`
      : ''

  // The track takes the ring's own tone, faint, so a ring barely begun still reads apart from a step to come.
  return `<svg ${XMLNS} viewBox="0 0 24 24" width="${size}" height="${height}" fill="none" stroke-linecap="round"><circle cx="12" cy="12" r="8.5" stroke="${TONE[tone]}" stroke-opacity=".4" stroke-width="3"/>${arc}</svg>`
}

/** A step still to come: an open ring. */
export function openRingSvg(size = 16, height = size): string {
  return `<svg ${XMLNS} viewBox="0 0 24 24" width="${size}" height="${height}" fill="none"><circle cx="12" cy="12" r="8.5" stroke="${TONE.quiet}" stroke-width="1.9"/></svg>`
}

/**
 * A slim progress bar `width` px wide. A known `percent` fills from the left; with none, a short bar travels along
 * the track, `sweep` (0 to 1) saying how far.
 */
export function meterSvg(tone: Tone, width = 96, percent: number | null = null, sweep = 0): string {
  const height = 6
  const track = `<rect width="${width}" height="${height}" rx="3" fill="${TONE.quiet}" fill-opacity=".28"/>`
  let fill = ''
  if (percent !== null) {
    const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)
    if (filled > 0) fill = `<rect width="${Math.max(filled, height)}" height="${height}" rx="3" fill="${TONE[tone]}"/>`
  } else {
    const bar = Math.round(width * 0.28)
    const at = Math.round((width - bar) * Math.max(0, Math.min(1, sweep)))
    fill = `<rect x="${at}" width="${bar}" height="${height}" rx="3" fill="${TONE[tone]}"/>`
  }

  return `<svg ${XMLNS} viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${track}${fill}</svg>`
}

/** Step dots for a short sequence (the welcome cards): the current one long, the rest round. */
export function dotsSvg(count: number, current: number): string {
  let x = 0
  const marks = Array.from({ length: count }, (_, index) => {
    const width = index === current ? 14 : 6
    const mark = `<rect x="${x}" width="${width}" height="6" rx="3" fill="${index === current ? TONE.active : TONE.quiet}"${index === current ? '' : ' fill-opacity=".45"'}/>`
    x += width + 5
    return mark
  })

  return `<svg ${XMLNS} viewBox="0 0 ${x - 5} 6" width="${x - 5}" height="6">${marks.join('')}</svg>`
}
