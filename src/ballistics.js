/**
 * How a meter moves, as the OBS mixer moves it: the two curves the mixer
 * applies to the raw numbers, with OBS's own constants.
 */

// The loudness integration time in milliseconds and the peak fall in decibels
// per second, both OBS's own.
const INTEGRATION_MS = 300
const FALL_DB_PER_SECOND = 11.76

// The factor OBS applies to each step of the loudness filter.
const STEP_SCALE = 0.99

// The loudest either curve may stand.
const CEILING_DB = 0

// How long the peak mark stands, after the fader. Long enough to outlast the
// bar's own fall.
const PEAK_HOLD_MS = 4000

// How long it stands before the fader.
const INPUT_PEAK_HOLD_MS = 1000

// How far a falling peak may go before it is left alone.
const FLOOR_DB = -100

/** A multiplier from OBS in decibels, with silence as minus infinity. */
function decibels(multiplier) {
	if (!(multiplier > 0)) return -Infinity
	return 20 * Math.log10(multiplier)
}

/** Decibels back to the multiplier the drawing reads, with silence as zero. */
function multiplier(db) {
	return Number.isFinite(db) ? Math.pow(10, db / 20) : 0
}

/** Anything that remembers something per channel, keyed by channel and side. */
class Remembers {
	constructor() {
		this.standing = new Map()
	}

	/** Drop the channels of sources the predicate no longer recognizes. */
	forget(keep) {
		for (const channel of [...this.standing.keys()]) {
			if (!keep(channel)) this.standing.delete(channel)
		}
	}

	/** Drop everything remembered, for a connection starting over. */
	clear() {
		this.standing.clear()
	}
}

/** A curve that moves one number per channel toward the readings. */
class Ballistic extends Remembers {
	/**
	 * Take one reading and hand back the value to draw. Called once per channel
	 * per frame and nowhere else: it is what advances the curve.
	 */
	reading(key, index, value, now) {
		const channel = `${key}:${index}`
		const held = this.standing.get(channel)
		const db = this.move(decibels(value), held, now)
		this.standing.set(channel, { db, at: now })
		return multiplier(db)
	}
}

/**
 * The loudness, which OBS runs through a first order filter over decibels:
 * displayed += (reading - displayed) * (elapsed / integration time).
 */
class Loudness extends Ballistic {
	constructor(integration = INTEGRATION_MS) {
		super()
		this.integration = integration
	}

	move(target, held, now) {
		if (!Number.isFinite(target)) {
			// Silence is minus infinity decibels: no filter can be aimed at it.
			return -Infinity
		}
		if (held === undefined || !Number.isFinite(held.db)) {
			// A channel's line starts at its first reading rather than at the floor.
			return Math.min(CEILING_DB, target)
		}
		// The elapsed time comes off the wire and can exceed the integration time,
		// so the step is capped at one.
		const step = Math.min(1, Math.max(0, ((now - held.at) / this.integration) * STEP_SCALE))
		return Math.min(CEILING_DB, held.db + (target - held.db) * step)
	}
}

/** The peak, which OBS lets rise at once and then fall at a steady rate. */
class Peak extends Ballistic {
	constructor(fallPerSecond = FALL_DB_PER_SECOND) {
		super()
		this.fallPerSecond = fallPerSecond
	}

	move(target, held, now) {
		if (held === undefined || !Number.isFinite(held.db)) {
			return Number.isFinite(target) ? Math.min(CEILING_DB, target) : -Infinity
		}
		if (!(target < held.db)) return Math.min(CEILING_DB, target)

		const fallen = held.db - (this.fallPerSecond * Math.max(0, now - held.at)) / 1000
		return Math.max(FLOOR_DB, Math.max(target, fallen))
	}
}

/** The mark left standing above the bar, at the highest the sound reached lately. */
class Hold extends Remembers {
	highest(key, index, value, now, duration) {
		const channel = `${key}:${index}`
		const held = this.standing.get(channel)
		if (!held || value >= held.value || now - held.at > duration) {
			this.standing.set(channel, { value, at: now })
			return value
		}
		return held.value
	}
}

module.exports = {
	Loudness,
	Peak,
	Hold,
	INTEGRATION_MS,
	FALL_DB_PER_SECOND,
	PEAK_HOLD_MS,
	INPUT_PEAK_HOLD_MS,
}
