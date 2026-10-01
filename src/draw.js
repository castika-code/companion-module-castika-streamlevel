const { Canvas } = require('./png.js')
const { State } = require('./source.js')

// Colors.
const BACKGROUND = [0, 0, 0]
const BAR_EMPTY = [26, 26, 26]
// The empty part of an incoming bar whose source carries a filter that is
// switched on.
const BAR_EMPTY_FILTERED = [45, 125, 215]
const VU_TICK = [10, 10, 12]
const PEAK_HOLD = [245, 245, 250]
const RED_LINE = [120, 40, 38]
const FLOOR = [110, 118, 112]
// The bar drawn where there is no reading.
const HATCH = [98, 98, 106]
const OUTLINE = [118, 118, 126]
// The same bar, incoming, where the source carries a filter that is switched on.
const HATCH_FILTERED = [23, 63, 108]
const OUTLINE_FILTERED = [29, 81, 140]
// The diagonal struck across a button whose setting names an input this
// connection does not have.
const MISSET = [186, 186, 196]

// What belongs to the source rather than to one channel: the mute state along
// the bottom, the fader up the middle, and the level across the top.
const MUTE_OPEN = [16, 42, 200]
const MUTE_ON = [225, 55, 45]
const FADER_TRACK = [78, 78, 86]
const FADER_KNOB = [225, 225, 232]
// The knob of a fader nobody can move, on a bus that has none.
const FADER_FIXED = [138, 140, 150]
// The knob on a meter that has no reading.
const FADER_IDLE = [126, 126, 134]
const IDLE = [34, 34, 36]

// The two sets of band colors OBS offers for its own meters, lit colors only.
const PALETTES = {
	// OBS as it comes.
	default: {
		bands: [
			[76, 255, 76],
			[255, 255, 76],
			[255, 76, 76],
		],
		// The ramp a bar and its strip take while the source feeds a track the
		// stream ignores.
		alarm: [
			[90, 28, 76],
			[235, 90, 205],
		],
	},
	// OBS's color blind set.
	colorblind: {
		bands: [
			[148, 46, 116],
			[249, 73, 51],
			[99, 172, 190],
		],
		alarm: [
			[85, 85, 85],
			[205, 205, 205],
		],
	},
}

/** The colors to draw with: the set the user picked, and whether to blend them. */
function paletteFor(name, style) {
	return { ...(PALETTES[name] ?? PALETTES.default), gradient: style === 'gradient' }
}

// Geometry, as fractions of one button, so the same code serves every key size.
// The margins keep the drawing off the curve of the key cap.
const SIDE_MARGIN = 0.1
const END_MARGIN = 0.11

// The end margin of a button set to the taller size, top and bottom.
const END_MARGIN_MAX = 0.05
const STRIP = 0.065
// The fader column: the knob is this wide and the slot it runs in a third of it.
const FADER_WIDTH = 0.13
const BAR_GAP = 0.05

// The scale OBS draws its own meters on. Decibels, floored at -60.
const FLOOR_DB = -60

// Where OBS changes color: the alignment level and the permitted maximum.
const ALIGNMENT_DB = -20
const MAXIMUM_DB = -9

/** A multiplier from OBS in decibels, with silence as minus infinity. */
function decibels(multiplier) {
	if (!(multiplier > 0)) return -Infinity
	return 20 * Math.log10(multiplier)
}

// How a level is turned into a height on the bar, and how much of the bar the
// top twenty decibels are given. Two straight runs meeting at the alignment
// level: even decibels is what OBS does, so a bar drawn that way stands at the
// same height as the bar in the mixer.
const SHARE_OF_TOP = {
	even: 1 / 3,
	expanded: 1 / 2,
	expanded2: 2 / 3,
	expanded3: 3 / 4,
}

const SCALES = {}
for (const [name, top] of Object.entries(SHARE_OF_TOP)) {
	const meet = 1 - top
	SCALES[name] = {
		at: (db) =>
			db <= ALIGNMENT_DB
				? (meet * (db - FLOOR_DB)) / (ALIGNMENT_DB - FLOOR_DB)
				: meet + (top * (db - ALIGNMENT_DB)) / -ALIGNMENT_DB,
	}
}

// A window on the quiet, for the question asked before going live: with nobody
// speaking, how loud is the room. Anything above the top of the window pins
// there.
const NOISE_BOTTOM_DB = -90
const NOISE_TOP_DB = -30
SCALES.noise = { at: (db) => (db - NOISE_BOTTOM_DB) / (NOISE_TOP_DB - NOISE_BOTTOM_DB) }

// The color turns are worked out from the mapping, so the bands cannot part
// company with the heights they belong to. They are left unclamped, so in a
// window that reaches neither of them the whole bar takes the lowest band.
for (const scale of Object.values(SCALES)) {
	scale.alignment = scale.at(ALIGNMENT_DB)
	scale.maximum = scale.at(MAXIMUM_DB)
	scale.marksMaximum = scale.maximum > 0 && scale.maximum < 1
}

/** The scale named in the settings, or the one OBS uses. */
function scaleFor(name) {
	return SCALES[name] ?? SCALES.even
}

/** A multiplier from OBS as a position on the bar, 0 at the floor, 1 at 0 dB. */
function position(multiplier, scale = SCALES.even) {
	return clamp(scale.at(decibels(multiplier)))
}

function mix(a, b, t) {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t),
	]
}

function dim(color, amount) {
	return [Math.round(color[0] * amount), Math.round(color[1] * amount), Math.round(color[2] * amount)]
}

/**
 * The color a bar or a strip has at a given height.
 *
 * Stripes are the three flat bands OBS paints, with a hard edge at each turn.
 * The gradient blends the same three colors across the same turns, so the two
 * styles disagree about shading and never about where the thresholds are. On the
 * off-track frame both give way to one ramp in the palette's alarm color.
 */
function levelColor(at, palette, scale, offTrack = false) {
	if (offTrack) return mix(palette.alarm[0], palette.alarm[1], at)

	const [low, mid, high] = palette.bands
	if (at >= scale.maximum) return high
	if (!palette.gradient) return at < scale.alignment ? low : mid
	if (at < scale.alignment) return mix(low, mid, at / scale.alignment)
	return mix(mid, high, (at - scale.alignment) / (scale.maximum - scale.alignment))
}

function clamp(value) {
	if (!(value > 0)) return 0
	return value > 1 ? 1 : value
}

/**
 * Placing what a meter is made of across the width it has.
 *
 * A meter is painted at its full size and cut into buttons afterwards, so where
 * the joins land is decided here: a bar is never cut by a join. Either it sits
 * inside one button, or it covers a whole number of them.
 */

/** The items across a meter, left to right, before any of them has a position. */
function itemsOf(groups, channels) {
	const items = []
	for (const group of groups) {
		if (group === 'fader') {
			items.push({ kind: 'fader' })
			continue
		}
		channels.forEach((channel, index) => items.push({ kind: 'bar', channel, index, incoming: group === 'pre' }))
	}
	return items
}

/** The gap that belongs between two neighboring items. */
function between(a, b, sizes) {
	return a.kind === 'fader' || b.kind === 'fader' ? sizes.faderGap : sizes.gap
}

/**
 * Lay a run of items across one span. Every bar in the run is given the same
 * whole number of pixels, and the pixels they cannot divide go to the gaps
 * between them, one to a gap and spread across them, which spends the whole span.
 */
function place(items, from, to, sizes) {
	const gaps = items.slice(1).map((item, i) => between(items[i], item, sizes))
	const inner = gaps.reduce((total, gap) => total + gap, 0)
	const bars = items.filter((item) => item.kind === 'bar').length
	const faders = items.length - bars
	const start = Math.round(from)
	const space = Math.round(to) - start - faders * sizes.faderWidth - inner
	const width = Math.max(2, Math.floor(space / bars))
	const over = Math.max(0, space - width * bars)

	const boxes = []
	let cursor = start
	items.forEach((item, i) => {
		boxes.push({ ...item, x: cursor, width: item.kind === 'fader' ? sizes.faderWidth : width })
		cursor += boxes[boxes.length - 1].width
		if (i < gaps.length)
			cursor += gaps[i] + Math.floor(((i + 1) * over) / gaps.length) - Math.floor((i * over) / gaps.length)
	})
	return boxes
}

/**
 * At least as many buttons as bars: each bar is given a whole number of them.
 * Buttons left over stay black and sit at the end away from the fader, so the
 * fader keeps its place against the outer margin.
 */
function wholeButtons(items, barCount, ahead, sizes, unitWidth, cols, sideMargin, side) {
	const per = Math.floor(cols / barCount)
	const spare = cols - barCount * per
	const first = (side === 'pre' ? spare : 0) * unitWidth
	const step = per * unitWidth
	const left = first + sideMargin
	const right = first + barCount * step - sideMargin

	// The gap between two bars is laid across the line where they meet, so the
	// join falls in open space.
	const after = Math.floor(sizes.gap / 2)
	const before = sizes.gap - after
	const edges = Array.from({ length: barCount }, (_, i) => ({
		from: i === 0 ? left : first + i * step + after,
		to: i === barCount - 1 ? right : first + (i + 1) * step - before,
	}))

	let fader = null
	if (ahead === 0) {
		fader = { kind: 'fader', x: left, width: sizes.faderWidth }
		edges[0].from = left + sizes.faderWidth + sizes.faderGap
	} else if (ahead === barCount) {
		fader = { kind: 'fader', x: right - sizes.faderWidth, width: sizes.faderWidth }
		edges[barCount - 1].to = right - sizes.faderWidth - sizes.faderGap
	} else if (ahead > 0) {
		// Astride the line the two bar groups meet at.
		const x = Math.round(first + ahead * step - sizes.faderWidth / 2)
		fader = { kind: 'fader', x, width: sizes.faderWidth }
		edges[ahead - 1].to = x - sizes.faderGap
		edges[ahead].from = x + sizes.faderWidth + sizes.faderGap
	}

	const boxes = fader ? [fader] : []
	const bars = items.filter((item) => item.kind === 'bar')
	bars.forEach((bar, i) => {
		const x = Math.round(edges[i].from)
		boxes.push({ ...bar, x, width: Math.max(2, Math.round(edges[i].to) - x) })
	})
	return boxes
}

/**
 * More bars than buttons: each button takes a whole number of them, as even a
 * share as the counts allow, the earlier buttons taking the odd one. Within a
 * button the bars share what is left after the margins and the fader.
 */
function sharedButtons(items, barCount, ahead, sizes, unitWidth, cols, sideMargin) {
	const base = Math.floor(barCount / cols)
	let odd = barCount - base * cols
	const counts = []
	const starts = []
	let running = 0
	for (let k = 0; k < cols; k++) {
		const mine = base + (odd > 0 ? 1 : 0)
		if (odd > 0) odd--
		counts.push(mine)
		starts.push(running)
		running += mine
	}

	const after = Math.floor(sizes.gap / 2)
	const before = sizes.gap - after
	const spans = counts.map((_, k) => ({
		from: k === 0 ? sideMargin : k * unitWidth + after,
		to: k === cols - 1 ? cols * unitWidth - sideMargin : (k + 1) * unitWidth - before,
	}))

	// Which button the fader belongs to, or the join it lies across.
	let astride = null
	let faderIn = -1
	if (ahead === 0) faderIn = 0
	else if (ahead === barCount) faderIn = cols - 1
	else if (ahead > 0) {
		const k = starts.indexOf(ahead)
		if (k > 0) {
			const x = Math.round(k * unitWidth - sizes.faderWidth / 2)
			astride = { kind: 'fader', x, width: sizes.faderWidth }
			spans[k - 1].to = x - sizes.faderGap
			spans[k].from = x + sizes.faderWidth + sizes.faderGap
		} else {
			faderIn = counts.findIndex((count, i) => ahead > starts[i] && ahead < starts[i] + count)
		}
	}

	const bars = items.filter((item) => item.kind === 'bar')
	const boxes = astride ? [astride] : []
	for (let k = 0; k < cols; k++) {
		const run = []
		for (let i = 0; i < counts[k]; i++) {
			if (faderIn === k && ahead === starts[k] + i) run.push({ kind: 'fader' })
			run.push(bars[starts[k] + i])
		}
		if (faderIn === k && ahead === starts[k] + counts[k]) run.push({ kind: 'fader' })
		boxes.push(...place(run, spans[k].from, spans[k].to, sizes))
	}
	return boxes
}

/** Where everything on a meter sits, before any of it is drawn. */
function layout(items, sizes, unitWidth, cols, sideMargin, side) {
	const barCount = items.filter((item) => item.kind === 'bar').length
	if (barCount === 0) return []
	const faderAt = items.findIndex((item) => item.kind === 'fader')
	const ahead = faderAt < 0 ? -1 : items.slice(0, faderAt).filter((item) => item.kind === 'bar').length

	return cols >= barCount
		? wholeButtons(items, barCount, ahead, sizes, unitWidth, cols, sideMargin, side)
		: sharedButtons(items, barCount, ahead, sizes, unitWidth, cols, sideMargin)
}

/** Sparse diagonal lines, the usual way of saying "no reading here". */
function hatch(canvas, x, y, width, height, color) {
	for (let py = 0; py < height; py++) {
		for (let px = 0; px < width; px++) {
			if ((px + py) % 5 === 0) canvas.rect(x + px, y + py, 1, 1, color)
		}
	}
}

/**
 * One bold diagonal, corner to corner, the mark for an entry struck out.
 *
 * Drawn per button rather than once across a whole meter, because one diagonal
 * across a block misses buttons and the fault belongs to every button carrying
 * the setting.
 */
function strike(canvas, x0, y0, x1, y1, thickness, color) {
	const dx = x1 - x0
	const dy = y1 - y0
	const steps = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy))))
	const half = Math.floor(thickness / 2)
	for (let i = 0; i <= steps; i++) {
		const x = Math.round(x0 + (dx * i) / steps) - half
		const y = Math.round(y0 + (dy * i) / steps) - half
		canvas.rect(x, y, thickness, thickness, color)
	}
}

/**
 * Paint a whole meter, which may cover a block of buttons. It is painted at its
 * full size and cut up afterwards, so the bars, the fader and the strips carry
 * across the joins instead of restarting on every button.
 */
function drawBlock(width, height, rows, cols, spec) {
	return paint(width * cols, height * rows, width, height, spec)
}

/**
 * The button, laid out as the signal runs: what arrives on the left, the fader
 * in the middle, what leaves on the right.
 */
function paint(width, height, unitWidth, unitHeight, spec) {
	const {
		channels = [],
		muted = false,
		fader = null,
		wrongTrack = false,
		live = true,
		// The setting names an input this connection does not have.
		misset = false,
		blinkOn = true,
		filters = [],
		side = 'both',
		bus = false,
		palette: paletteName = 'default',
		style = 'stripes',
		scale: scaleName = 'even',
		// How much room the ends of the meter give away.
		size = 'compact',
	} = spec
	const palette = paletteFor(paletteName, style)
	const scale = scaleFor(scaleName)

	const canvas = new Canvas(width, height)
	canvas.fill(BACKGROUND)

	// Feeding a track the stream ignores has no level of its own, so it takes the
	// bars and the strips above them, alternating them into the palette's alarm
	// color on the blink. The bars keep their heights on both frames.
	const offTrack = wrongTrack && blinkOn

	// Marked on the part of an incoming bar no level fills, hollow bars included, and
	// steady on both blink frames. OBS reports the filters of a source whether or not
	// it is in the scene, so this is read rather than remembered.
	const filtered = filters.some(Boolean)

	// Sizes come from one button, not from the whole block, so strips and margins
	// stay the same thickness however many buttons a meter covers. The margin goes
	// on the outside of the whole meter and never at a join between two buttons.
	const sideMargin = Math.max(1, Math.round(unitWidth * SIDE_MARGIN))
	const endMargin = Math.max(1, Math.round(unitHeight * (size === 'max' ? END_MARGIN_MAX : END_MARGIN)))
	const strip = Math.max(2, Math.round(unitHeight * STRIP))
	const faderWidth = Math.max(3, Math.round(unitWidth * FADER_WIDTH))
	const gap = Math.max(1, Math.round(unitWidth * BAR_GAP))
	const faderGap = Math.max(1, Math.round(gap / 2))

	// Companion draws the button's name on a layer above this picture, and the top
	// margin is where it lands, so no band is held clear for it here.
	const safeTop = endMargin
	const safeBottom = height - endMargin

	const barTop = safeTop + strip + 2
	const barBottom = safeBottom - strip - 2
	const barHeight = barBottom - barTop

	if (channels.length === 0 || barHeight <= 0) return canvas

	// What the button is made of, left to right. The mix carries one bar group
	// rather than two, and its fader is fixed: a bus has no fader or mute of its
	// own.
	const groups = bus
		? ['fader', 'post']
		: side === 'both'
			? ['pre', 'fader', 'post']
			: side === 'pre'
				? ['pre', 'fader']
				: ['fader', 'post']
	// Where everything sits is worked out before anything is drawn, so a channel's
	// strip, bar and mute mark are placed from one pair of edges.
	const sizes = { gap, faderGap, faderWidth }
	const items = itemsOf(groups, channels)
	const cols = Math.max(1, Math.round(width / unitWidth))
	const boxes = layout(items, sizes, unitWidth, cols, sideMargin, bus ? 'post' : side)

	for (const box of boxes) {
		if (box.kind === 'fader') {
			// The fader column runs the whole way between the margins, so the knob
			// has the longest travel the key allows.
			drawFader(canvas, box.x, safeTop, box.width, safeBottom - safeTop, {
				fader,
				live,
				unit: unitHeight,
				fixed: bus,
				misset,
			})
			continue
		}

		// Each channel speaks for itself, above and below. The strip carries that
		// channel's own level and its own clip; the mute mark carries the same color
		// under every bar, since OBS has no mute per channel.
		const { channel, incoming } = box
		drawStatusStrip(canvas, box.x, safeTop, box.width, strip, { channel, incoming, live, offTrack, palette, scale })
		drawMuteStrip(canvas, box.x, safeBottom - strip, box.width, strip, { muted, live })
		drawBar(
			canvas,
			box.x,
			barTop,
			box.width,
			barHeight,
			channel,
			incoming,
			offTrack,
			palette,
			scale,
			misset,
			filtered && incoming,
		)
	}

	// Last, so the mark lies over everything else the button drew. One stroke per
	// button, across that button's own bar area.
	if (misset) {
		const rows = Math.max(1, Math.round(height / unitHeight))
		const thickness = Math.max(2, Math.round(Math.min(unitWidth, unitHeight) * 0.03))
		const inset = Math.floor(thickness / 2)
		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				const x0 = Math.max(sideMargin, col * unitWidth) + inset
				const x1 = Math.min(width - sideMargin, (col + 1) * unitWidth) - 1 - inset
				const y0 = Math.max(barTop, row * unitHeight) + inset
				const y1 = Math.min(barBottom, (row + 1) * unitHeight) - 1 - inset
				if (x1 > x0 && y1 > y0) strike(canvas, x0, y0, x1, y1, thickness, MISSET)
			}
		}
	}

	return canvas
}

// Across the top of one bar: the band that bar's own level sits in, which is the
// level read as a single color and so legible from across a room. It always
// carries something, since black is what a button that knows nothing shows.
//
// On the alarm frame it carries the warning instead of the level.
function drawStatusStrip(canvas, x, y, width, height, { channel, incoming, live, offTrack, palette, scale }) {
	if (!live) {
		canvas.rect(x, y, width, height, IDLE)
		return
	}

	// Not reaching the stream outranks anything else this strip could say.
	if (offTrack) {
		canvas.rect(x, y, width, height, palette.alarm[1])
		return
	}

	const clipping = incoming ? channel.incomingClipping : channel.state === State.CLIPPING
	if (clipping) {
		canvas.rect(x, y, width, height, palette.bands[2])
		return
	}

	const at = position(incoming ? channel.pre : channel.post, scale)
	canvas.rect(x, y, width, height, levelColor(at, palette, scale))
}

// Along the bottom of one bar: blue while the source is open, red while muted.
function drawMuteStrip(canvas, x, y, width, height, { muted, live }) {
	canvas.rect(x, y, width, height, !live ? IDLE : muted ? MUTE_ON : MUTE_OPEN)
}

// A fader drawn as a fader: a thin track with a knob on it, which cannot be
// mistaken for a level the way a filled column can.
function drawFader(canvas, x, y, width, height, { fader, live, unit, fixed = false, misset = false }) {
	const grooveWidth = Math.max(1, Math.round(width / 3))
	canvas.rect(x + Math.floor((width - grooveWidth) / 2), y, grooveWidth, height, live ? FADER_TRACK : IDLE)

	// A button naming an input that is not here has no fader to report, so the
	// groove is drawn and the knob is not.
	if (misset) return

	// The knob's height is kept odd so the line across it sits in the middle.
	let knobHeight = Math.max(5, Math.round(unit * 0.11))
	if (knobHeight % 2 === 0) knobHeight += 1

	// A fader that has not been read is placed in the middle of its groove, which
	// only the idle knob below ever draws: a live meter draws no knob at all.
	const standing = fader === null ? 0.5 : clamp(fader)
	const knobY = y + Math.round((height - knobHeight) * (1 - standing))

	if (!live) {
		// Where the fader stands outlives the reading: OBS answers for the volume
		// of every input it lists, in the scene or not.
		canvas.rect(x, knobY, width, knobHeight, FADER_IDLE)
		canvas.rect(x, knobY + Math.floor(knobHeight / 2), width, 1, IDLE)
		return
	}

	if (fader === null) return

	if (fixed) {
		// A bus carries no fader, so the knob stands at unity, duller and with no
		// line across it.
		canvas.rect(x, knobY, width, knobHeight, FADER_FIXED)
		return
	}

	canvas.rect(x, knobY, width, knobHeight, FADER_KNOB)
	canvas.rect(x, knobY + Math.floor(knobHeight / 2), width, 1, FADER_TRACK)
}

/**
 * One bar. The incoming side is drawn dimmer than the outgoing one, so the eye
 * lands on what is actually leaving the machine.
 */
function drawBar(
	canvas,
	x,
	y,
	width,
	height,
	channel,
	incoming,
	offTrack,
	palette,
	scale,
	misset = false,
	filtered = false,
) {
	if (channel.state === State.NOT_LIVE || channel.state === State.NO_CONNECTION) {
		// Nothing is being measured, so the bar is left hollow and hatched, the way
		// a chart marks missing data. A button set to an input that is not here gets
		// the hollow bar and the stroke instead, since no reading is missing there.
		canvas.outline(x, y, width, height, filtered ? OUTLINE_FILTERED : OUTLINE)
		if (!misset) hatch(canvas, x + 1, y + 1, width - 2, height - 2, filtered ? HATCH_FILTERED : HATCH)
		return
	}

	canvas.rect(x, y, width, height, filtered ? BAR_EMPTY_FILTERED : BAR_EMPTY)

	// The line the level must not cross, drawn on the empty bar so it can be seen
	// before it is reached.
	if (scale.marksMaximum) {
		const redLineY = y + height - 1 - Math.round((height - 1) * scale.maximum)
		canvas.rect(x, redLineY, width, 1, incoming ? dim(RED_LINE, 0.6) : RED_LINE)
	}

	// A floor line, so silence reads as a meter at rest.
	canvas.rect(x, y + height - 2, width, 2, incoming ? dim(FLOOR, 0.6) : FLOOR)

	const clipping = incoming ? channel.incomingClipping : channel.state === State.CLIPPING
	if (clipping) {
		canvas.rect(x, y, width, height, offTrack ? levelColor(1, palette, scale, true) : palette.bands[2])
		return
	}

	const postValue = incoming ? channel.pre : channel.post
	const loudnessValue = incoming ? channel.pre : channel.loudness

	const peak = Math.round((height - 1) * position(postValue, scale))
	for (let row = 0; row < peak; row++) {
		const at = row / (height - 1)
		// The incoming side is drawn back only below the line, so a source running
		// hot stays red on both sides.
		const shade = !incoming || at >= scale.maximum ? 1 : 0.6
		canvas.rect(x, y + height - 1 - row, width, 1, dim(levelColor(at, palette, scale, offTrack), shade))
	}

	// Two things in one bar, the way OBS draws them: the filled part is the peak
	// and the dark line inside it is the loudness.
	if (!incoming) {
		const loudness = Math.round((height - 1) * position(loudnessValue, scale))
		if (loudness > 0 && peak > 0) canvas.rect(x, y + height - 1 - loudness, width, 1, VU_TICK)
	}

	// The highest the bar has been lately, left standing above it.
	const hold = incoming ? channel.preHold : channel.hold
	if (hold > 0) {
		const holdY = y + height - 1 - Math.round((height - 1) * position(hold, scale))
		canvas.rect(x, holdY, width, 1, PEAK_HOLD)
	}
}

/** The blink phase, on for half a second and off for half a second. */
function blinkPhase(now = Date.now()) {
	return Math.floor(now / 500) % 2 === 0
}

/**
 * Where the fader sits, always on even decibels whatever the meter is set to: a
 * fader is where a control stands rather than a level.
 */
function faderPosition(multiplier) {
	return position(multiplier, SCALES.even)
}

module.exports = { drawBlock, blinkPhase, faderPosition, position, scaleFor }
