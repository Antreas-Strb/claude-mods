import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import { GLYPH, TONE_TEXT, badgeSvg, dotsSvg, iconSvg, meterSvg, openRingSvg, ringSvg } from './look'
import type { IconName, Tone } from './look'

/** Icon size in the band and the panels, in CSS px: a touch smaller than the desktop's 14.5px text. */
const ICON = 15
/** The desktop's line of text, in CSS px: marks are drawn this tall, centered, so they line up with a first line. */
const LINE = 21
/** The room a mark of ICON size takes, in cells: as wide as the room a line under it keeps, so the two start alike. */
const MARK = 2

/**
 * The marks every screen draws, from one icon set (look.ts): SVG where the surface draws vectors (the desktop app,
 * VS Code, the phone), one-cell glyphs on the terminal, so a status reads the same everywhere.
 */
export function kitOf(table: ElementTable, surface: RenderSurface) {
  const { Box, Text } = table
  // The terminal's table answers for Svg too, and draws it as an empty box: go by the surface.
  const Svg = surface !== 'terminal' && 'Svg' in table ? table.Svg : null
  // Every drawing says what it is: the desktop app draws nothing for an Svg whose alt is empty.
  const draw = (source: string, alt: string, width: number, height = width): RenderElement | null =>
    Svg ? <Svg source={source} alt={alt} width={width} height={height} /> : null
  // A mark of ICON size sits in MARK cells, so a blank of the same cells lines a line up under it with nothing to read.
  const placed = (drawn: RenderElement | null, size: number) =>
    drawn !== null && size === ICON ? (
      <Box width={MARK} flexShrink={0}>
        {drawn}
      </Box>
    ) : (
      drawn
    )
  const glyph = (name: IconName, tone: Tone) => (
    <Text color={TONE_TEXT[tone]} dimColor={tone === 'quiet'}>
      {GLYPH[name]}
    </Text>
  )

  return {
    isVector: Svg !== null,
    /** A line icon. */
    icon: (name: IconName, tone: Tone, alt: string, size = ICON) => placed(draw(iconSvg(name, tone, size, LINE), alt, size, LINE), size) ?? glyph(name, tone),
    /** A filled disc with the icon in white: done, failed, waiting on you, stopped. */
    badge: (name: IconName, tone: Tone, alt: string, size = ICON) =>
      placed(draw(badgeSvg(name, tone, size, LINE), alt, size, LINE), size) ?? glyph(name, tone),
    /** The current step: a ring filled to `percent`, or turning with `turn` while there is none. */
    ring: (percent: number | null, turn: number, alt: string, size = ICON, tone: Tone = 'active') =>
      placed(draw(ringSvg(tone, size, percent, turn, LINE), alt, size, LINE), size) ?? glyph('play', tone),
    /** A step still to come. */
    open: (alt: string, size = ICON) => placed(draw(openRingSvg(size, LINE), alt, size, LINE), size) ?? <Text dimColor>○</Text>,
    /** A mark's room with nothing in it, so a line under a step starts where the step's name does; no drawing, so a
     * screen reader passes over it. */
    blank: () => (Svg ? <Box width={MARK} flexShrink={0} /> : <Text> </Text>),
    /** A slim bar; vector surfaces only. */
    meter: (tone: Tone, percent: number | null, sweep: number, alt: string, width = 96) => draw(meterSvg(tone, width, percent, sweep), alt, width, 6),
    /** Where the welcome cards are; vector surfaces only. */
    dots: (count: number, current: number) => draw(dotsSvg(count, current), `Card ${current + 1} of ${count}`, count * 11 + 3, 6),
  }
}
