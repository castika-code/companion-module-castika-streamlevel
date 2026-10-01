const { InstanceBase, InstanceStatus, Regex, combineRgb } = require('@companion-module/base')
const { CLIP_LEVEL, MIX_ID, MIX_NAME, State, classify } = require('./source.js')
const { Source } = require('./sources/obs.js')
const { blinkPhase, drawBlock, faderPosition } = require('./draw.js')
const { group, meterKey } = require('./group.js')
const { Hold, PEAK_HOLD_MS, INPUT_PEAK_HOLD_MS } = require('./ballistics.js')

// How often the buttons are repainted.
const REDRAW_MS = 100

// The level scales the connection offers: four views of the same sixty decibels,
// differing only in how much of the bar the top twenty are given.
const LEVEL_SCALES = [
	{ id: 'even', label: 'Regular' },
	{ id: 'expanded', label: 'Expanded top 1/2' },
	{ id: 'expanded2', label: 'Expanded top 2/3' },
	{ id: 'expanded3', label: 'Expanded top 3/4' },
]

// What a button may say about its scale: follow the connection, or the noise
// window, which is a different range read for a different question.
const FOLLOW_CONNECTION = 'default'
const BUTTON_SCALES = [
	{ id: FOLLOW_CONNECTION, label: 'Use the connection setting' },
	{ id: 'noise', label: 'Noise floor' },
]
const SCALE_IDS = BUTTON_SCALES.map((choice) => choice.id)

// How much room the meter gives away at the top and bottom of a key.
const METER_SIZES = [
	{ id: 'compact', label: 'Compact' },
	{ id: 'max', label: 'Max' },
]
const SIZE_IDS = METER_SIZES.map((choice) => choice.id)
const DEFAULT_SIZE = 'compact'

/** The connection's scale, with anything it no longer offers read as the scale OBS uses. */
function connectionScale(name) {
	return LEVEL_SCALES.some((choice) => choice.id === name) ? name : 'even'
}

// A bar that reaches full scale stays red for at least this long.
const CLIP_HOLD_MS = 1000

// How long the levels go on arriving after the last meter button has gone.
const WATCH_OFF_DELAY_MS = 5000

class StreamLevelInstance extends InstanceBase {
	async init(config, isFirstInit, secrets) {
		this.config = { ...config, password: secrets?.password ?? '' }
		this.fillInNewSettings(config)

		// The one source there is, reached only through the methods src/source.js
		// defines, so the drawing, the feedbacks and the presets carry nothing about
		// OBS. The settings object is handed over rather than copied out of, since the
		// source reads the address off it every time it opens.
		this.source = new Source(this.config, {
			onStatus: (state, message) => this.handleStatus(state, message),
			onChanged: () => this.catalogChanged(),
			onLog: (level, message) => this.log(level, message),
		})

		// Every button showing a meter, by feedback id, with where it sits.
		this.buttons = new Map()

		// The picture each button is currently showing.
		this.images = new Map()

		// When each channel last hit full scale, so the red can be held.
		this.clips = new Map()

		// The highest each channel has been lately, and when it got there.
		this.peaks = new Hold()

		// Nothing is drawn and no levels are asked for until a button wants a meter.
		this.redrawTimer = null
		this.idleTimer = null

		this.source.start()
		this.publishDefinitions()
	}

	async destroy() {
		if (this.redrawTimer) clearInterval(this.redrawTimer)
		if (this.idleTimer) clearTimeout(this.idleTimer)
		this.source?.stop()
	}

	/**
	 * Ask the source for levels, and repaint, because something is showing a meter.
	 * Called from the feedback path, which runs far more often than it changes, so
	 * applying a state already in force must cost nothing.
	 */
	startWatching() {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer)
			this.idleTimer = null
		}
		if (this.redrawTimer) return

		this.source.watchLevels(true)
		this.redrawTimer = setInterval(() => this.redraw(), REDRAW_MS)
	}

	/**
	 * Stop asking, once nothing has wanted the levels for a while. Stopping is the
	 * dangerous direction, so it is the slow one and checks again at the end of the
	 * wait. A button counts whether or not its input is reporting anything.
	 */
	scheduleStopWatching() {
		if (this.idleTimer || !this.redrawTimer) return
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null
			if (this.buttons.size > 0) return

			this.source.watchLevels(false)
			if (this.redrawTimer) {
				clearInterval(this.redrawTimer)
				this.redrawTimer = null
			}
		}, WATCH_OFF_DELAY_MS)
	}

	/**
	 * Give a setting added in a later version its default value. Companion marks the
	 * empty field invalid and refuses to save the form until someone touches it.
	 */
	fillInNewSettings(config) {
		const missing = {}
		if (!config.scheme) missing.scheme = 'ws'
		if (!config.palette) missing.palette = 'default'
		// A connection saved when the second palette was spelled the British way holds
		// a value the form no longer offers, so it is rewritten rather than reset.
		if (config.palette === 'colourblind') missing.palette = 'colorblind'
		if (!config.style) missing.style = 'stripes'
		if (!config.loudness) missing.loudness = 'smoothed'
		if (connectionScale(config.scale) !== config.scale) missing.scale = connectionScale(config.scale)
		if (Object.keys(missing).length === 0) return

		// Kept here as well as saved, so the first frames are drawn with them. Field by
		// field rather than a fresh object: the source is handed this object and reads
		// the address off it, so it must stay the same object.
		Object.assign(this.config, missing)

		// An undefined secrets argument means the secrets did not change, which is the
		// point here: this hand fills in a blank field and leaves the password alone.
		this.saveConfig({ ...config, ...missing }, undefined)
	}

	async configUpdated(config, secrets) {
		// The password lives in the secrets store, so it arrives separately. An update
		// carrying no secrets at all means they did not change rather than that they
		// were emptied, so only a secrets object that is present can clear it.
		const password = secrets ? (secrets.password ?? '') : (this.config?.password ?? '')
		const next = { ...config, password }

		// Only the settings naming the machine are worth a reconnection; the colors
		// change nothing OBS sends.
		const moved = ['host', 'port', 'password', 'scheme'].some((field) => next[field] !== this.config?.[field])
		// Field by field again: the source was handed this object and reads the address
		// off it when it opens.
		Object.assign(this.config, next)
		if (!moved) return

		this.source.stop()
		this.source.start()
	}

	/** A column nothing else will sit beside, kept stable per button. */
	lonelyColumn(id) {
		if (!this.lonely) this.lonely = new Map()
		if (!this.lonely.has(id)) this.lonely.set(id, this.lonely.size * 2)
		return this.lonely.get(id)
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				// Companion renders a full width static text longer than a hundred characters
				// as the text alone, and writes no label element at all when the label is
				// empty, so the empty label here leaves no gap.
				label: '',
				// The words are OBS's own, exactly as they appear on screen.
				value:
					'In OBS, open Tools, then WebSocket Server Settings, and tick Enable WebSocket server. ' +
					'Then enter the address, port and password below. Without the server OBS reports nothing ' +
					'and the buttons stay dark.',
			},
			// The fields are named after OBS rather than after a server.
			{
				type: 'textinput',
				id: 'host',
				label: 'OBS IP / Hostname',
				width: 6,
				default: '127.0.0.1',
				regex: Regex.HOSTNAME,
			},
			{
				type: 'number',
				id: 'port',
				label: 'OBS Port',
				width: 6,
				default: 4455,
				min: 1,
				max: 65535,
			},
			{
				// A secret field is hidden on screen and kept apart from the settings.
				type: 'secret-text',
				id: 'password',
				label: 'OBS Password',
				width: 12,
				default: '',
			},
			{
				// Plain WebSocket is what OBS itself serves; the secure form is for an OBS
				// reached through a proxy that terminates TLS.
				type: 'dropdown',
				id: 'scheme',
				label: 'Connection Type',
				width: 12,
				default: 'ws',
				choices: [
					{ id: 'ws', label: 'WebSocket (ws)' },
					{ id: 'wss', label: 'Secure WebSocket (wss)' },
				],
			},
			{
				// The entries name the colors rather than the OBS preset they belong to.
				type: 'dropdown',
				id: 'palette',
				label: 'Meter Colors',
				width: 12,
				default: 'default',
				choices: [
					{ id: 'default', label: 'Green, Yellow, Red' },
					{ id: 'colorblind', label: 'Magenta, Orange, Teal' },
				],
			},
			{
				// Whether those three colors are laid down flat or blended.
				type: 'dropdown',
				id: 'style',
				label: 'Meter Style',
				width: 12,
				default: 'stripes',
				choices: [
					{ id: 'stripes', label: 'Stripes' },
					{ id: 'gradient', label: 'Gradient' },
				],
			},
			{
				// The default scale for every button on this connection.
				type: 'dropdown',
				id: 'scale',
				label: 'Meter Scale',
				width: 12,
				default: 'even',
				choices: LEVEL_SCALES,
			},
			{
				// How the dark line inside the bar behaves.
				type: 'dropdown',
				id: 'loudness',
				label: 'Loudness Line',
				width: 12,
				default: 'smoothed',
				choices: [
					{ id: 'smoothed', label: 'Steady, as in the OBS mixer' },
					{ id: 'instant', label: 'Follows every change' },
				],
			},
		]
	}

	publishDefinitions() {
		this.setFeedbackDefinitions(this.feedbackDefinitions())
		this.setPresetDefinitions(...this.presetDefinitions())
	}

	/** The sources offered in the dropdown, the mix first, then the rest. */
	sourceChoices() {
		const sources = this.source.list()
		if (sources.length === 0) return [{ id: '', label: 'No audio inputs found in OBS' }]
		return sources.map((entry) => ({ id: entry.id, label: entry.name }))
	}

	feedbackDefinitions() {
		return {
			meter: {
				type: 'advanced',
				name: 'Audio level',
				// Companion draws this under the title, at a size and a place we do not
				// control, so the only lever is length.
				description:
					'Buttons that touch each other and match on Connection, Input Audio, Fader Side, ' +
					'Scale and Meter Size join into one meter and draw the level.',
				affectedProperties: ['png64'],
				options: [
					{
						type: 'dropdown',
						id: 'source',
						label: 'Input Audio',
						default: '',
						// The choices come from OBS, so an expression has nothing to offer here.
						disableAutoExpression: true,
						choices: this.sourceChoices(),
					},
					{
						// Which side of the fader this button shows.
						type: 'dropdown',
						id: 'side',
						label: 'Fader Side',
						default: 'both',
						disableAutoExpression: true,
						choices: [
							{ id: 'both', label: 'Both sides' },
							{ id: 'post', label: 'After the fader' },
							{ id: 'pre', label: 'Before the fader' },
						],
					},
					{
						// The level scale belongs to the connection, so that a row of meters can be
						// read against itself. A button says only whether it is looking at levels.
						type: 'dropdown',
						id: 'scale',
						label: 'Scale',
						default: FOLLOW_CONNECTION,
						disableAutoExpression: true,
						choices: BUTTON_SCALES,
					},
					{
						// How near the top and bottom of the key the bars reach.
						type: 'dropdown',
						id: 'size',
						label: 'Meter Size',
						default: DEFAULT_SIZE,
						disableAutoExpression: true,
						choices: METER_SIZES,
					},
					{
						// disableAutoExpression is safe beside useVariables and does not stop the
						// location arriving: the option parser sets parseVariables from the field
						// being a textinput with useVariables, so a plain value with variables in it
						// is expanded either way.
						type: 'textinput',
						id: 'location',
						label: 'Button Location',
						default: '$(this:page)/$(this:row)/$(this:column)',
						useVariables: true,
						disableAutoExpression: true,
					},
				],
				callback: (feedback) => {
					this.rememberButton(feedback)
					const png64 = this.images.get(feedback.id)
					return png64 ? { png64 } : {}
				},
				unsubscribe: (feedback) => {
					this.buttons.delete(feedback.id)
					this.images.delete(feedback.id)
					// The column a preset preview was given goes with it, since previews come and
					// go every time the Presets tab is opened.
					this.lonely?.delete(feedback.id)
					if (this.buttons.size === 0) this.scheduleStopWatching()
				},
			},
		}
	}

	/**
	 * Presets are handed over as a structure and the definitions it refers to. One
	 * preset per input, carrying that input's name, and a single empty preset where
	 * OBS has told us nothing yet, so the list is never bare.
	 *
	 * WHAT IT TAKES FOR THE PICTURE TO APPEAR AT ALL:
	 *
	 * 1. An advanced feedback's picture is not drawn on its own: the button needs an
	 *    Image element and the feedback a style override tying base64Image to png64.
	 * 2. The preset has to be `simple`, because Companion converts a legacy button
	 *    and that conversion is what builds the element and writes the override. It
	 *    also appends an inert imageBuffers layer that nothing feeds.
	 * 3. A `layered` preset placing the same element by hand lands a button with no
	 *    feedback on it at all.
	 * 4. A feedback added by hand to a plain button gets no override either, since a
	 *    plain button has no Image element to hang one on. Hence the order the help
	 *    gives: Image element first, feedback second.
	 * 5. Every option the form declares has to carry a value here, or Companion
	 *    marks the feedback invalid until somebody opens it.
	 */
	presetDefinitions() {
		const style = {
			text: '',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
			show_topbar: false,
		}
		// The name is carried as the button's own text, which Companion draws on a
		// layer over the picture. On the button it is cut short.
		const meter = (name, source, side, text) => ({
			type: 'simple',
			name,
			style: { ...style, text: text ?? '', size: '7', alignment: 'center:top' },
			steps: [],
			feedbacks: [
				{
					feedbackId: 'meter',
					options: {
						source,
						side: side ?? 'both',
						// Every option the form offers is filled in, including the ones a preset never
						// varies: an option left out arrives empty and Companion marks the field
						// invalid until somebody touches it.
						scale: FOLLOW_CONNECTION,
						// Compact, because the preset carries the input's name as the button's text.
						size: DEFAULT_SIZE,
						location: '$(this:page)/$(this:row)/$(this:column)',
					},
				},
			],
		})

		const presets = {}
		const order = []
		const sources = this.source.list()
		if (sources.length > 0) {
			presets[`meter_${MIX_ID}`] = meter(MIX_NAME, MIX_ID, 'post', MIX_NAME)
			order.push(`meter_${MIX_ID}`)
		}

		const sides = [
			['both', 'in and out'],
			['post', 'out'],
			['pre', 'in'],
		]
		for (const entry of sources) {
			if (entry.id === MIX_ID) continue
			const name = entry.name
			for (const [side, suffix] of sides) {
				const id = `meter_${entry.id}_${side}`
				presets[id] = meter(`${name} (${suffix})`, entry.id, side, shortName(name))
				order.push(id)
			}
		}

		if (order.length === 0) {
			presets.meter = meter('Audio level', '', 'both', '')
			order.push('meter')
		}

		const structure = [{ id: 'meters', name: 'Castika StreamLevel', definitions: order }]
		return [structure, presets]
	}

	/**
	 * Note where a button is, so that buttons wanting the same input can be
	 * recognized as neighbors. Companion does not hand a feedback its position, but
	 * it will expand the variables that name it.
	 */
	rememberButton(feedback) {
		const options = feedback.options ?? {}

		// The location field is declared with useVariables, so what arrives is already
		// expanded: "1/0/2", not the expression that produced it.
		let where = { page: 0, row: 0, column: 0 }
		const [page, row, column] = String(options.location ?? '')
			.split('/')
			.map((part) => Number(part.trim()))
		if ([page, row, column].every((value) => Number.isFinite(value))) {
			where = { page, row, column }
		} else {
			// A preset preview is drawn without standing anywhere, so its location comes
			// back unresolved. It is given a page of its own so previews never join.
			where = { page: -1, row: 0, column: this.lonelyColumn(feedback.id) }
		}

		this.buttons.set(feedback.id, {
			id: feedback.id,
			...where,
			options,
			size: feedback.image ?? { width: 72, height: 72 },
		})

		if (!this.redrawTimer || this.idleTimer) this.startWatching()
	}

	handleStatus(state, message) {
		// Whether the source is reachable, which the drawing asks: a button with
		// nothing to measure has to say which kind of absence it is showing.
		this.connected = state === 'connected'

		if (state === 'connected') {
			this.lastFailure = null
			this.updateStatus(InstanceStatus.Ok)
		} else if (state === 'connecting') {
			this.updateStatus(InstanceStatus.Connecting)
		} else {
			// Said in the log as well as on the connection, once per reason rather than
			// once per attempt: the retry runs every few seconds.
			if (message !== this.lastFailure) {
				this.lastFailure = message
				this.log('warn', message)
			}
			this.updateStatus(InstanceStatus.ConnectionFailure, message)
		}
	}

	/**
	 * The loudness of one channel as the button should draw it: the steadied value,
	 * or the reading on its own where the connection asks for that. It governs the
	 * line inside the bar and nothing else; the bar keeps its fall either way.
	 */
	loudnessOf(channel) {
		if (this.config?.loudness === 'instant') return channel.loudness
		return channel.smoothedLoudness ?? channel.loudness
	}

	/**
	 * The source's list, or a fact inside it, has moved: the dropdown and the presets
	 * are built again, and whatever was held for a source that has gone is let go of
	 * first.
	 */
	catalogChanged() {
		this.forgetMissing()
		this.publishDefinitions()
	}

	/**
	 * Forget what was being held about sources that are no longer listed: when each
	 * channel last clipped, and how high its mark stands.
	 *
	 * Called from the one place that is told the list moved, so a connection that
	 * dropped keeps everything it learned. The ballistic curves are let go of
	 * separately, in src/sources/obs.js. The mix is never in the list and is never
	 * forgotten.
	 */
	forgetMissing() {
		const present = new Set(this.source.list().map((entry) => entry.id))
		const keep = (key) => {
			const id = key.slice(0, key.indexOf(':'))
			return id === MIX_ID || present.has(id)
		}
		for (const key of [...this.clips.keys()]) {
			if (!keep(key)) this.clips.delete(key)
		}
		this.peaks.forget(keep)
	}

	/**
	 * Repaint every meter and hand each button its share. A meter is painted once at
	 * its full size and then cut up, so the halves of a wide meter cannot disagree.
	 */
	redraw() {
		if (this.buttons.size === 0) return

		const connected = this.connected === true
		const blinkOn = blinkPhase()
		const changed = []

		// Which meter a button belongs to is worked out here, so changing the
		// connection's scale moves every button that follows it at the next frame.
		const buttons = [...this.buttons.values()].map((button) => ({
			...button,
			key: meterKey({
				page: button.page,
				source: button.options.source,
				side: button.options.side,
				scale: this.scaleFor(button.options),
				size: this.sizeFor(button.options),
			}),
		}))

		for (const meter of group(buttons)) {
			const unit = this.buttons.get(meter.members[0].id)?.size ?? { width: 72, height: 72 }
			const spec = {
				...this.specFor(meter.options.source, connected),
				blinkOn,
				side: meter.options.side ?? 'both',
				palette: this.config?.palette,
				style: this.config?.style,
				scale: this.scaleFor(meter.options),
				size: this.sizeFor(meter.options),
			}
			const block = drawBlock(unit.width, unit.height, meter.rows, meter.cols, spec)

			for (const member of meter.members) {
				const share =
					meter.rows === 1 && meter.cols === 1
						? block
						: block.crop(member.col * unit.width, member.row * unit.height, unit.width, unit.height)
				const picture = share.toDataUrl()
				if (this.images.get(member.id) !== picture) {
					this.images.set(member.id, picture)
					changed.push(member.id)
				}
			}
		}

		if (changed.length > 0) this.checkFeedbacksById(...changed)
	}

	/**
	 * The scale one button is drawn on: the noise window where it asks for it, the
	 * connection's level scale otherwise. Resolved rather than raw wherever it is
	 * used, so that two buttons both following the connection join.
	 */
	scaleFor(options) {
		const chosen = options?.scale
		if (chosen && chosen !== FOLLOW_CONNECTION && SCALE_IDS.includes(chosen)) return chosen
		return connectionScale(this.config?.scale)
	}

	/**
	 * How much room one button's meter gives away at its ends. Resolved rather than
	 * raw for the reason the scale is: it decides which buttons join.
	 */
	sizeFor(options) {
		const chosen = options?.size
		return SIZE_IDS.includes(chosen) ? chosen : DEFAULT_SIZE
	}

	/** Everything the drawing needs to know about one source, right now. */
	specFor(id, connected) {
		if (id === MIX_ID) return this.mixSpec(connected)

		const input = this.source.get(id)

		// A source this connection has never heard of is a different fault from one
		// that is merely out of the scene, and the two must not be drawn alike. Only
		// while connected: with the far end away the list is whatever was last learned.
		if (connected && !input) return this.missetSpec()

		const levels = connected ? this.source.readings(id) : null
		const state = !connected ? State.NO_CONNECTION : State.NOT_LIVE

		if (!levels) {
			// Keep the number of bars the source last showed, so a meter does not change
			// shape the moment its scene leaves the air.
			const count = Math.max(1, input?.channels?.length ?? 2)
			return {
				channels: Array.from({ length: count }, () => ({ state, post: 0, loudness: 0, pre: 0 })),
				muted: !!input?.muted,
				fader: input ? faderPosition(input.volume) : null,
				wrongTrack: false,
				filters: input?.filters ?? [],
				live: false,
			}
		}

		const now = Date.now()
		return {
			channels: levels.map((channel, index) => {
				// What the channel is doing is read off the reading rather than off the falling
				// bar: a bar on its way down is a drawing convention.
				const held = this.clipHold(`${id}:out`, index, channel.post, now)
				return {
					state: classify({
						connected,
						channel,
						muted: !!input?.muted,
						volume: input?.volume ?? 1,
						clipping: held,
					}),
					// Held on its own: breaking up before the fader is a different fault from
					// breaking up after it.
					incomingClipping: this.clipHold(`${id}:in`, index, channel.pre, now),
					hold: this.peaks.highest(`${id}:out`, index, channel.post, now, PEAK_HOLD_MS),
					preHold: this.peaks.highest(`${id}:in`, index, channel.pre, now, INPUT_PEAK_HOLD_MS),
					post: channel.fallingPeak ?? channel.post,
					loudness: this.loudnessOf(channel),
					pre: channel.fallingInputPeak ?? channel.pre,
				}
			}),
			muted: !!input?.muted,
			fader: faderPosition(input?.volume ?? 1),
			wrongTrack: input?.reaches === false,
			filters: input?.filters ?? [],
			live: true,
		}
	}

	/**
	 * A button whose setting names an input this connection does not have. Nothing
	 * about it is known, so nothing about it is drawn: two bars only because a meter
	 * has to have a shape.
	 */
	missetSpec() {
		return {
			channels: [0, 0].map(() => ({ state: State.NOT_LIVE, post: 0, loudness: 0, pre: 0 })),
			muted: false,
			fader: null,
			wrongTrack: false,
			filters: [],
			live: false,
			misset: true,
		}
	}

	/**
	 * The sound leaving the machine, as well as it can be known. There is no meter
	 * for the final mix, so the members that reach what the stream sends are added
	 * together as a root of squares.
	 */
	mixSpec(connected) {
		// No list at all is the source saying nothing is arriving, which is not the
		// same as a live reading of silence.
		const members = connected ? this.source.mixMembers() : null
		if (!members) {
			const state = connected ? State.NOT_LIVE : State.NO_CONNECTION
			return {
				channels: [0, 0].map(() => ({ state, post: 0, loudness: 0, pre: 0 })),
				muted: false,
				fader: null,
				wrongTrack: false,
				bus: true,
				live: false,
			}
		}

		const sums = []
		for (const member of members) {
			member.readings.forEach((channel, index) => {
				const sum = sums[index] ?? (sums[index] = { loudness: 0, post: 0, pre: 0, heardPost: 0, heardPre: 0 })
				// The mix keeps no curve of its own. Each member is already steadied and
				// already falling, and scaling every member by one factor scales a root of
				// squares by that factor, so the mix falls at the OBS rate when sound stops.
				const loudness = this.loudnessOf(channel)
				sum.loudness += loudness * loudness
				sum.post += channel.fallingPeak * channel.fallingPeak
				sum.pre += channel.fallingInputPeak * channel.fallingInputPeak
				// The readings are summed as well, since the clip warning and the mark above
				// the bar are questions about the sound rather than about the bar.
				sum.heardPost += channel.post * channel.post
				sum.heardPre += channel.pre * channel.pre
			})
		}

		if (sums.length === 0) {
			return {
				channels: [0, 0].map(() => ({ state: State.NO_SIGNAL, post: 0, loudness: 0, pre: 0 })),
				muted: false,
				// A bus has no fader of its own, so the one drawn stands at unity. An empty
				// groove would read as a fader whose position could not be read.
				fader: 1,
				wrongTrack: false,
				bus: true,
				live: true,
			}
		}

		const now = Date.now()
		return {
			channels: sums.map((sum, index) => {
				const post = Math.min(1, Math.sqrt(sum.post))
				const pre = Math.min(1, Math.sqrt(sum.pre))
				const heardPost = Math.min(1, Math.sqrt(sum.heardPost))
				const heardPre = Math.min(1, Math.sqrt(sum.heardPre))
				const held = this.clipHold(`${MIX_ID}:out`, index, heardPost, now)
				return {
					state: held ? State.CLIPPING : State.NORMAL,
					incomingClipping: this.clipHold(`${MIX_ID}:in`, index, heardPre, now),
					hold: this.peaks.highest(`${MIX_ID}:out`, index, heardPost, now, PEAK_HOLD_MS),
					preHold: this.peaks.highest(`${MIX_ID}:in`, index, heardPre, now, INPUT_PEAK_HOLD_MS),
					post,
					loudness: Math.min(1, Math.sqrt(sum.loudness)),
					pre,
				}
			}),
			muted: false,
			fader: 1,
			wrongTrack: false,
			bus: true,
			live: true,
		}
	}

	/**
	 * Whether a channel counts as clipping at this moment. Once full scale is
	 * reached the answer stays yes for a second, since a peak lasts a few
	 * milliseconds and a glance takes longer. Held per channel, because it is a fact
	 * about the sound and not about where someone put a button.
	 */
	clipHold(id, index, peak, now) {
		const key = `${id}:${index}`
		if (peak >= CLIP_LEVEL) {
			this.clips.set(key, now)
			return true
		}
		const last = this.clips.get(key)
		if (last === undefined) return false
		if (now - last < CLIP_HOLD_MS) return true
		this.clips.delete(key)
		return false
	}
}

// The sides a button may watch; a saved value outside this list is one Companion
// will refuse.
const SIDES = ['both', 'post', 'pre']

/**
 * Bring a button placed by an earlier version up to date. A saved option arrives
 * wrapped, carrying either a plain value or an expression Companion works out
 * when the button is drawn, so one holding an expression is left alone.
 */
function upgradeMeterOptions(context, props) {
	const updatedFeedbacks = []

	for (const feedback of props.feedbacks ?? []) {
		if (feedback.feedbackId !== 'meter') continue
		const options = feedback.options ?? {}
		let changed = false

		// A band was once held clear above the meter, with a setting to decide it. Both
		// are gone, and an option that no longer exists is one Companion complains
		// about at every start.
		if (options.named !== undefined) {
			delete options.named
			changed = true
		}

		// Which side of the fader a button watches came later than the buttons
		// themselves, and Companion marks a missing value invalid.
		const side = options.side
		const wrapped = side !== null && typeof side === 'object'
		if (!(wrapped && side.isExpression) && !SIDES.includes(wrapped ? side.value : side)) {
			options.side = { isExpression: false, value: 'both' }
			changed = true
		}

		// Where the button sits is how neighbors showing the same input find each other.
		if (options.location === undefined) {
			options.location = { isExpression: false, value: '$(this:page)/$(this:row)/$(this:column)' }
			changed = true
		}

		feedback.options = options
		if (changed) updatedFeedbacks.push(feedback)
	}

	// Only what was touched is handed back.
	return { updatedConfig: null, updatedActions: [], updatedFeedbacks }
}

/**
 * Give a button that predates the scale option its answer: follow the connection,
 * which is what these buttons have been doing all along.
 *
 * A second script rather than another line in the first: a connection that has
 * run a script has recorded that it did and will never run it again.
 */
function upgradeButtonScale(context, props) {
	const updatedFeedbacks = []

	for (const feedback of props.feedbacks ?? []) {
		if (feedback.feedbackId !== 'meter') continue
		const options = feedback.options ?? {}

		const scale = options.scale
		const wrapped = scale !== null && typeof scale === 'object'
		if (!(wrapped && scale.isExpression) && !SCALE_IDS.includes(wrapped ? scale.value : scale)) {
			options.scale = { isExpression: false, value: FOLLOW_CONNECTION }
			feedback.options = options
			updatedFeedbacks.push(feedback)
		}
	}

	return { updatedConfig: null, updatedActions: [], updatedFeedbacks }
}

/**
 * Bring a button back off a level scale of its own. The dropdown offered the four
 * level scales for a while; they belong to the connection, and a button holding
 * one names a value its own form cannot show.
 *
 * A third script rather than a line in the second, for the reason the second was
 * not a line in the first. The answer is to follow the connection.
 */
function upgradeButtonOffLevelScale(context, props) {
	const updatedFeedbacks = []

	for (const feedback of props.feedbacks ?? []) {
		if (feedback.feedbackId !== 'meter') continue
		const options = feedback.options ?? {}

		const scale = options.scale
		const wrapped = scale !== null && typeof scale === 'object'
		if (!(wrapped && scale.isExpression) && !SCALE_IDS.includes(wrapped ? scale.value : scale)) {
			options.scale = { isExpression: false, value: FOLLOW_CONNECTION }
			feedback.options = options
			updatedFeedbacks.push(feedback)
		}
	}

	return { updatedConfig: null, updatedActions: [], updatedFeedbacks }
}

/**
 * Give a button that predates the meter size its answer: the compact size, which
 * is what every button has been drawn at all along.
 *
 * A fourth script, for the reason the second and third were not lines in the
 * first. The drawing does not wait for this, but the form does.
 */
function upgradeMeterSize(context, props) {
	const updatedFeedbacks = []

	for (const feedback of props.feedbacks ?? []) {
		if (feedback.feedbackId !== 'meter') continue
		const options = feedback.options ?? {}

		const size = options.size
		const wrapped = size !== null && typeof size === 'object'
		if (!(wrapped && size.isExpression) && !SIZE_IDS.includes(wrapped ? size.value : size)) {
			options.size = { isExpression: false, value: DEFAULT_SIZE }
			feedback.options = options
			updatedFeedbacks.push(feedback)
		}
	}

	return { updatedConfig: null, updatedActions: [], updatedFeedbacks }
}

/**
 * As much of an input's name as fits above a meter: its first word, and at most
 * eight characters of that. "Desktop Audio" becomes "Desktop".
 */
function shortName(name) {
	if (name === MIX_NAME) return name
	const first = String(name ?? '')
		.trim()
		.split(/[\s/|,·:]+/)[0]
	return first.length > 8 ? first.slice(0, 8) : first
}

// Companion imports the class itself, so what this file exports has to BE the
// class. The upgrade scripts travel on the class, and the entry file beside this
// one presents both of them to Companion.
module.exports = StreamLevelInstance
module.exports.UpgradeScripts = [
	upgradeMeterOptions,
	upgradeButtonScale,
	upgradeButtonOffLevelScale,
	upgradeMeterSize,
]
