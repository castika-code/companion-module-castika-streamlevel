/**
 * The OBS adapter: the connection, the catalog of inputs, the routing, the
 * filters and which track the stream sends, handed on as the plain record
 * src/source.js describes. The protocol itself is in obswebsocket.js.
 */

const { ObsConnection } = require('./obswebsocket.js')
const { Loudness, Peak } = require('../ballistics.js')
const { Answers, MIX_ID, MIX_NAME } = require('../source.js')

// How often which track the stream sends is read again. OBS sends no event when
// a profile setting changes.
const TRACK_POLL_MS = 5000

// How long the whole feed may go silent before the meters give up on it. Wide
// enough for network latency and a slow answer.
const FEED_SILENCE_MS = 5000

// How long a filter event waits before the filters are read again, so a burst of
// events folds into one sweep.
const FILTER_SWEEP_MS = 200

/**
 * Whether a source reaches the track the stream sends. An input with no tracks
 * at all has no audio, so there is nothing to be wrong about.
 */
function feedsStream(tracks, streamTrack) {
	if (!tracks || Object.keys(tracks).length === 0) return true
	return !!tracks[String(streamTrack)]
}

/**
 * One OBS, as a source of levels. The surface it answers is defined in
 * src/source.js; `options` is the connection form, read for host, port, password
 * and scheme.
 */
class Source {
	constructor(options, handlers) {
		this.options = options
		this.handlers = handlers

		// Everything known about each input, keyed by its uuid, so renaming a source
		// in OBS does not break a button that points at it.
		this.inputs = new Map()

		// Which audio track the stream sends. Track 1 unless the profile says otherwise.
		this.streamTrack = 1

		this.connection = new ObsConnection({
			onStatus: (state, message) => this.handleStatus(state, message),
			onLevels: (inputs) => this.handleLevels(inputs),
			onEvent: (type, data) => this.handleEvent(type, data),
		})

		// Where the drawn loudness and the drawn peak of each channel stand. They
		// live with the frames because both move by elapsed time and are advanced by
		// a frame arriving.
		this.loudness = new Loudness()
		this.peakFall = new Peak()

		// Set while a filter sweep is waiting to run.
		this.filterTimer = null

		this.trackTimer = null
	}

	/**
	 * What this adapter answers, and how well; the vocabulary is in
	 * src/source.js. Three of them are ASSUMED rather than MEASURED: where the
	 * request for a mute, a fader or a track fails, the input is left carrying
	 * unmuted, unity and the stream's own track.
	 */
	get capabilities() {
		return {
			pre: Answers.MEASURED,
			muted: Answers.ASSUMED,
			fader: Answers.ASSUMED,
			routing: Answers.ASSUMED,
			live: Answers.MEASURED,
			mix: Answers.DERIVED,
			filters: Answers.MEASURED,
		}
	}

	start() {
		this.connection.connect(this.options)
		this.trackTimer = setInterval(() => this.readStreamTrack(), TRACK_POLL_MS)
	}

	stop() {
		if (this.trackTimer) {
			clearInterval(this.trackTimer)
			this.trackTimer = null
		}
		if (this.filterTimer) {
			clearTimeout(this.filterTimer)
			this.filterTimer = null
		}
		this.connection.close()
	}

	watchLevels(wanted) {
		this.connection.watchLevels(wanted)
	}

	/** The sources to offer, the mix first, then the inputs by name. */
	list() {
		const inputs = [...this.inputs.entries()]
			.map(([id, input]) => ({ id, name: input.name || id }))
			.sort((a, b) => a.name.localeCompare(b.name))
		if (inputs.length === 0) return []
		return [{ id: MIX_ID, name: MIX_NAME }, ...inputs]
	}

	/** Everything known about one source, or undefined if it is not one of ours. */
	get(id) {
		const input = this.inputs.get(id)
		if (!input) return undefined
		return {
			name: input.name,
			channels: input.channels,
			muted: !!input.muted,
			volume: input.volume,
			reaches: feedsStream(input.tracks, this.streamTrack),
			filters: input.filters,
			reporting: input.reporting,
		}
	}

	/**
	 * The current levels of an input, or null when it is not reporting. Null is a
	 * state of its own: the input is not live, which is not being quiet.
	 */
	readings(id) {
		if (!this.feedIsAlive()) return null
		const known = this.inputs.get(id)
		if (!known || !known.reporting) return null
		return known.channels
	}

	/**
	 * The inputs that make up the mix, each with its readings: exactly the inputs
	 * the last frame said were live and that feed the stream's track. Null rather
	 * than an empty list when nothing is arriving at all, since an empty list is a
	 * mix that is running and silent.
	 */
	mixMembers() {
		if (!this.feedIsAlive()) return null
		const members = []
		for (const [id, input] of this.inputs) {
			if (!feedsStream(input.tracks, this.streamTrack)) continue
			const readings = this.readings(id)
			if (!readings) continue
			members.push({ id, readings })
		}
		return members
	}

	/** Whether the level events are arriving at all, asked of the feed rather than per input. */
	feedIsAlive() {
		return this.lastFrameAt !== undefined && Date.now() - this.lastFrameAt <= FEED_SILENCE_MS
	}

	handleStatus(state, message) {
		this.handlers.onStatus(state, message)
		if (state === 'connected') this.refreshCatalog()
	}

	/**
	 * Store one frame of levels.
	 *
	 * Each channel arrives as three multipliers: the loudness after the fader, the
	 * peak after the fader, and the peak before it. The third keeps moving while a
	 * source is muted or its fader is down.
	 *
	 * The drawn curves are advanced here, because frames arrive more often than
	 * the buttons are repainted. The readings are kept beside them.
	 */
	handleLevels(inputs) {
		const now = Date.now()
		const named = new Set()
		for (const entry of inputs) {
			const uuid = entry.inputUuid
			if (!uuid) continue
			named.add(uuid)

			// A frame may name an input before the catalog has reached it. What
			// blankInput fills in is assumed rather than read: unmuted, unity and no
			// tracks, which feedsStream reads as reaching the stream, so such an
			// input draws as open, at unity and on air until refreshCatalog answers
			// for it.
			const known = this.inputs.get(uuid) ?? this.blankInput(entry.inputName)
			known.name = entry.inputName ?? known.name
			known.channels = (entry.inputLevelsMul ?? []).map((channel, index) => {
				const loudness = channel[0] ?? 0
				const post = channel[1] ?? 0
				const pre = channel[2] ?? 0
				return {
					loudness,
					post,
					pre,
					smoothedLoudness: this.loudness.reading(`${uuid}:out`, index, loudness, now),
					fallingPeak: this.peakFall.reading(`${uuid}:out`, index, post, now),
					fallingInputPeak: this.peakFall.reading(`${uuid}:in`, index, pre, now),
				}
			})
			known.reporting = true
			this.inputs.set(uuid, known)
		}

		// A frame lists every input OBS is mixing, so anything missing from one that
		// arrived is not being mixed.
		for (const [uuid, input] of this.inputs) {
			if (!named.has(uuid)) input.reporting = false
		}

		this.lastFrameAt = now
	}

	blankInput(name) {
		return {
			name: name ?? '',
			channels: [],
			tracks: {},
			muted: false,
			volume: 1,
			filters: [],
			reporting: false,
		}
	}

	handleEvent(type, data) {
		switch (type) {
			case 'InputMuteStateChanged':
				this.patchInput(data.inputUuid, { muted: !!data.inputMuted })
				break

			case 'InputVolumeChanged':
				this.patchInput(data.inputUuid, { volume: data.inputVolumeMul ?? 1 })
				break

			case 'InputAudioTracksChanged':
				this.patchInput(data.inputUuid, { tracks: data.inputAudioTracks ?? {} })
				break

			case 'SourceFilterCreated':
			case 'SourceFilterRemoved':
			case 'SourceFilterEnableStateChanged':
			case 'SourceFilterListReindexed':
				// OBS identifies filters by source name, and a name no longer
				// identifies one source, since a profile may hold more than one
				// canvas. So every input we know is read again by its uuid.
				this.scheduleFilterSweep()
				break

			case 'InputCreated':
			case 'InputRemoved':
			case 'InputNameChanged':
			case 'CurrentProfileChanged':
				this.refreshCatalog()
				break

			default:
				break
		}
	}

	patchInput(uuid, fields) {
		if (!uuid) return
		const known = this.inputs.get(uuid) ?? this.blankInput('')
		this.inputs.set(uuid, { ...known, ...fields })
	}

	/**
	 * Read the things that do not arrive on their own: which inputs exist, how
	 * each one is routed, and which track the stream takes. The volume meter event
	 * carries only the inputs that are active right now.
	 */
	async refreshCatalog() {
		if (!this.connection.isReady) return
		// A long run of requests, so a second read starting while the first is still
		// going is refused rather than piling up.
		if (this.reading) return
		this.reading = true

		try {
			const { inputs = [] } = await this.connection.request('GetInputList')
			const present = new Set()
			for (const input of inputs) {
				const uuid = input.inputUuid
				if (!uuid) continue
				present.add(uuid)
				const known = this.inputs.get(uuid) ?? this.blankInput(input.inputName)
				known.name = input.inputName ?? known.name
				this.inputs.set(uuid, known)
				await this.readRouting(uuid)
			}

			// An input deleted in OBS is simply absent from the next list. This runs
			// only where a list actually arrived: a request that failed says nothing
			// about what exists.
			for (const uuid of [...this.inputs.keys()]) {
				if (!present.has(uuid)) this.inputs.delete(uuid)
			}
			this.forgetMissing(present)
		} catch (error) {
			this.handlers.onLog('debug', `could not read the input list: ${error.message}`)
		}

		await this.readStreamTrack()
		this.handlers.onChanged()
		this.reading = false
	}

	/**
	 * Forget the curves being held for sources OBS no longer has.
	 *
	 * Called from the one place that prunes the catalog, inside the successful
	 * read, so a connection that dropped keeps everything it learned. The clip and
	 * hold stores are let go of separately, in src/main.js.
	 *
	 * The mix is never in the list and is never forgotten.
	 */
	forgetMissing(present) {
		const keep = (key) => {
			const uuid = key.slice(0, key.indexOf(':'))
			return uuid === MIX_ID || present.has(uuid)
		}
		this.loudness.forget(keep)
		this.peakFall.forget(keep)
	}

	/**
	 * Which filters a source carries, and which of them are switched on. Only that
	 * much is knowable: whether a compressor is compressing is not published, and
	 * filters run before the meter.
	 */
	async readFilters(uuid) {
		if (!uuid || !this.connection.isReady) return
		try {
			const result = await this.connection.request('GetSourceFilterList', { sourceUuid: uuid })
			this.patchInput(uuid, { filters: (result.filters ?? []).map((filter) => !!filter.filterEnabled) })
		} catch (error) {
			// A source that cannot hold filters simply has none, so this is not a
			// warning.
			this.handlers.onLog('debug', `could not read the filters of ${uuid}: ${error.message}`)
		}
	}

	/**
	 * Read the filters of every input, shortly. Anything already waiting is left to
	 * run, since the sweep reads everything either way.
	 */
	scheduleFilterSweep() {
		if (this.filterTimer) return
		this.filterTimer = setTimeout(() => {
			this.filterTimer = null
			this.sweepFilters()
		}, FILTER_SWEEP_MS)
	}

	async sweepFilters() {
		if (!this.connection.isReady) return
		for (const uuid of [...this.inputs.keys()]) {
			await this.readFilters(uuid)
		}
	}

	/**
	 * The three facts about an input that do not arrive as levels: its tracks, its
	 * mute and its fader.
	 *
	 * WHERE ONE OF THESE READS FAILS, WHAT IS SHOWN IS NOT MEASURED. The input
	 * keeps what blankInput put there: no tracks, which feedsStream reads as
	 * reaching the stream, unmuted, and the fader at unity. So the button draws an
	 * open source at full fader that is on air. An input carrying no audio answers
	 * none of the three, which is why the failures are quiet.
	 */
	async readRouting(uuid) {
		try {
			const tracks = await this.connection.request('GetInputAudioTracks', { inputUuid: uuid })
			this.patchInput(uuid, { tracks: tracks.inputAudioTracks ?? {} })
		} catch {
			// An input without audio has no tracks, which is drawn as reaching the
			// stream.
		}
		try {
			const mute = await this.connection.request('GetInputMute', { inputUuid: uuid })
			this.patchInput(uuid, { muted: !!mute.inputMuted })
		} catch {
			// Same, and the input stays drawn as unmuted.
		}
		try {
			const volume = await this.connection.request('GetInputVolume', { inputUuid: uuid })
			this.patchInput(uuid, { volume: volume.inputVolumeMul ?? 1 })
		} catch {
			// Same, and the knob stays drawn at unity.
		}
		await this.readFilters(uuid)
	}

	/**
	 * Which track the stream sends: track 1 in simple output mode, and whatever
	 * the profile holds in advanced mode.
	 *
	 * WHERE THE ANSWER CANNOT BE READ, TRACK 1 IS ASSUMED, both when none of the
	 * parameter names answers and when the request fails outright. On a profile
	 * sending another track, every input routed to track 1 is then drawn as
	 * reaching the stream when nothing on it does, and nothing on the button says
	 * so.
	 */
	async readStreamTrack() {
		if (!this.connection.isReady) return

		try {
			const mode = await this.connection.request('GetProfileParameter', {
				parameterCategory: 'Output',
				parameterName: 'Mode',
			})
			if ((mode.parameterValue ?? mode.defaultParameterValue) !== 'Advanced') {
				this.streamTrack = 1
				return
			}

			// The name of this parameter has not always been the same.
			for (const parameterName of ['TrackIndex', 'StreamTrack', 'AudioTrack']) {
				const track = await this.connection.request('GetProfileParameter', {
					parameterCategory: 'AdvOut',
					parameterName,
				})
				const value = Number(track.parameterValue ?? track.defaultParameterValue)
				if (value >= 1 && value <= 6) {
					this.streamTrack = value
					return
				}
			}
			// None of the names answered with a track number. Assumed, as above.
			this.streamTrack = 1
		} catch (error) {
			// The request failed, so nothing is known about the track. Assumed, as
			// above, and said in the log.
			this.streamTrack = 1
			this.handlers.onLog('debug', `could not read the stream track: ${error.message}`)
		}
	}
}

module.exports = { Source }
