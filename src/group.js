/**
 * Working out which buttons belong to the same meter.
 *
 * Nobody declares a block. Buttons set to show the same thing, sitting next to
 * each other, become one meter covering the ground they occupy. The shape does
 * not have to be a rectangle: three buttons in an L are painted as the two by two
 * they sit in, and the corner nobody claimed is not drawn.
 */

/**
 * Everything about a button that decides which meter it belongs to.
 *
 * The scale and the meter size are part of it because both change where a bar
 * starts and stops, so two neighbors that disagreed would make nonsense of the
 * join. The scale handed in is the resolved one, so two buttons both following
 * the connection still join.
 */
function meterKey(options) {
	return JSON.stringify({
		page: options.page,
		source: options.source,
		side: options.side ?? 'both',
		scale: options.scale ?? 'even',
		size: options.size ?? 'compact',
	})
}

/**
 * Split buttons into meters. They join when they want the same thing and touch
 * edge to edge, so two separate pairs of one input stay two meters.
 */
function group(buttons) {
	const byKey = new Map()
	for (const button of buttons) {
		const key = `${button.page}\u0000${button.key}`
		if (!byKey.has(key)) byKey.set(key, [])
		byKey.get(key).push(button)
	}

	const meters = []
	for (const members of byKey.values()) {
		for (const island of islands(members)) {
			meters.push(describe(island))
		}
	}
	return meters
}

/** Connected runs of buttons, joined through shared edges. */
function islands(members) {
	// A cell can hold more than one button in the moment after one is moved onto
	// another, so each cell keeps a list.
	const at = new Map()
	for (const button of members) {
		const cell = `${button.row},${button.column}`
		if (!at.has(cell)) at.set(cell, [])
		at.get(cell).push(button)
	}

	const seen = new Set()
	const found = []

	for (const button of members) {
		const start = `${button.row},${button.column}`
		if (seen.has(start)) continue

		const island = []
		const queue = [start]
		seen.add(start)

		while (queue.length > 0) {
			const here = queue.pop()
			const current = at.get(here)[0]
			island.push(...at.get(here))

			const neighbors = [
				`${current.row - 1},${current.column}`,
				`${current.row + 1},${current.column}`,
				`${current.row},${current.column - 1}`,
				`${current.row},${current.column + 1}`,
			]
			for (const neighbor of neighbors) {
				if (at.has(neighbor) && !seen.has(neighbor)) {
					seen.add(neighbor)
					queue.push(neighbor)
				}
			}
		}
		found.push(island)
	}
	return found
}

/** The ground an island covers, and where each button sits inside it. */
function describe(island) {
	const top = Math.min(...island.map((button) => button.row))
	const left = Math.min(...island.map((button) => button.column))
	const bottom = Math.max(...island.map((button) => button.row))
	const right = Math.max(...island.map((button) => button.column))

	return {
		key: island[0].key,
		options: island[0].options,
		rows: bottom - top + 1,
		cols: right - left + 1,
		members: island.map((button) => ({
			id: button.id,
			row: button.row - top,
			col: button.column - left,
		})),
	}
}

module.exports = { meterKey, group }
