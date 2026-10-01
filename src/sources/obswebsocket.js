const { createHash } = require('node:crypto')

// obs-websocket 5 speaks in numbered opcodes. Only these seven are used here.
const OP_HELLO = 0
const OP_IDENTIFY = 1
const OP_IDENTIFIED = 2
const OP_REIDENTIFY = 3
const OP_EVENT = 5
const OP_REQUEST = 6
const OP_REQUEST_RESPONSE = 7

// Event subscription flags. The volume meters are a high volume event and are
// not part of any default set, so the flag has to be asked for explicitly.
const SUB_GENERAL = 1 << 0
const SUB_CONFIG = 1 << 1
const SUB_INPUTS = 1 << 3
const SUB_FILTERS = 1 << 5
const SUB_OUTPUTS = 1 << 6
const SUB_INPUT_VOLUME_METERS = 1 << 16

// What is asked for at all times: an input added, a filter switched, a track
// changed, a profile loaded.
const QUIET_SUBSCRIPTIONS = SUB_GENERAL | SUB_CONFIG | SUB_INPUTS | SUB_FILTERS | SUB_OUTPUTS

// The levels are asked for only while a button is showing a meter. A session can
// change its mind after the handshake by sending Reidentify, so this costs no
// reconnection.

const RECONNECT_DELAY_MS = 3000
const REQUEST_TIMEOUT_MS = 5000

// How long a connection is given to get from opening the socket to being
// identified. A socket that is neither open nor closed delivers no close event,
// so without this the module waits for ever.
const HANDSHAKE_TIMEOUT_MS = 10000

// obs-websocket closes with a numbered reason.
const CLOSE_REASONS = {
	4002: 'OBS did not understand the request. A version mismatch.',
	4003: 'OBS refused the connection as unsupported.',
	4008: 'OBS expected authentication first.',
	4009: 'OBS refused the password.',
	4010: 'OBS does not speak this protocol version.',
	4011: 'OBS closed the connection: too many requests at once.',
}

function describeClose(event, wasIdentified) {
	const known = CLOSE_REASONS[event.code]
	if (known) return known
	if (event.reason) return `OBS closed the connection: ${event.reason}`
	if (wasIdentified) return 'The connection to OBS dropped.'
	return 'No connection to OBS. Is the WebSocket server switched on?'
}

function sha256Base64(value) {
	return createHash('sha256').update(value).digest('base64')
}

// obs-websocket authentication: hash the password with the salt from Hello,
// then hash that result with the challenge from the same message.
function buildAuth(password, salt, challenge) {
	const secret = sha256Base64(password + salt)
	return sha256Base64(secret + challenge)
}

/**
 * One connection to obs-websocket, with reconnection.
 *
 *   onStatus(state, message)  'connecting' | 'connected' | 'failed'
 *   onLevels(inputs)          the raw inputs array, every 50 ms
 *   onEvent(type, data)       any other event that arrived
 */
class ObsConnection {
	constructor(handlers) {
		this.handlers = handlers
		this.socket = null
		this.pending = new Map()
		this.nextRequestId = 1
		this.reconnectTimer = null
		this.handshakeTimer = null
		this.wanted = false
		this.identified = false

		// Whether the levels are wanted, and whether this session has been told so. The
		// answer can change while there is no session to tell, and a reconnection starts
		// a session that knows nothing.
		this.wantLevels = false
		this.toldLevels = null
	}

	/** What this connection asks OBS to send it, as things stand. */
	get subscriptions() {
		return QUIET_SUBSCRIPTIONS | (this.wantLevels ? SUB_INPUT_VOLUME_METERS : 0)
	}

	/**
	 * Ask for the level events, or stop asking. Sends nothing unless the answer has
	 * changed, so this can be called as often as the caller likes.
	 */
	watchLevels(wanted) {
		this.wantLevels = !!wanted
		this.syncSubscriptions()
	}

	syncSubscriptions() {
		if (!this.identified || this.toldLevels === this.wantLevels) return
		if (this.send({ op: OP_REIDENTIFY, d: { eventSubscriptions: this.subscriptions } })) {
			// Recorded as told at the moment it is sent. Anything that ends the session
			// clears it again.
			this.toldLevels = this.wantLevels
		}
	}

	connect(config) {
		this.wanted = true
		this.config = config
		this.open()
	}

	close() {
		this.wanted = false
		this.clearReconnect()
		this.clearHandshake()
		this.failPending('connection closed')
		if (this.socket) {
			const socket = this.socket
			this.socket = null
			this.identified = false
			this.toldLevels = null
			try {
				socket.close()
			} catch {
				// Already gone. Nothing to do.
			}
		}
	}

	get isReady() {
		return this.identified
	}

	open() {
		const host = this.config.host || '127.0.0.1'
		const port = this.config.port || 4455
		const scheme = this.config.scheme === 'wss' ? 'wss' : 'ws'
		const url = `${scheme}://${host}:${port}`

		this.handlers.onStatus('connecting', `connecting to ${url}`)

		let socket
		try {
			socket = new WebSocket(url)
		} catch (error) {
			this.fail(`cannot open ${url}: ${error.message}`)
			return
		}
		this.socket = socket

		// Give the handshake a deadline, or a socket that opens and then hears nothing
		// holds the connection in "connecting" for ever.
		this.clearHandshake()
		this.handshakeTimer = setTimeout(() => {
			this.handshakeTimer = null
			if (socket !== this.socket || this.identified) return
			this.dropSocket()
			this.fail(`OBS at ${url} accepted the connection and then said nothing.`)
		}, HANDSHAKE_TIMEOUT_MS)

		socket.addEventListener('message', (event) => this.receive(event.data))
		socket.addEventListener('error', () => {
			// The close event that follows carries the useful reporting.
		})
		socket.addEventListener('close', (event) => {
			if (socket !== this.socket) return
			const wasIdentified = this.identified
			this.identified = false
			this.toldLevels = null
			this.clearHandshake()
			this.failPending('connection lost')
			this.fail(describeClose(event, wasIdentified))
		})
	}

	/** Let go of the current socket without giving up on reconnecting. */
	dropSocket() {
		const socket = this.socket
		this.socket = null
		this.identified = false
		this.toldLevels = null
		this.failPending('connection lost')
		if (socket) {
			try {
				socket.close()
			} catch {
				// Already gone. Nothing to do.
			}
		}
	}

	fail(message) {
		this.handlers.onStatus('failed', message)
		this.scheduleReconnect()
	}

	scheduleReconnect() {
		if (!this.wanted || this.reconnectTimer) return
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			if (this.wanted) this.open()
		}, RECONNECT_DELAY_MS)
	}

	clearReconnect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
	}

	clearHandshake() {
		if (this.handshakeTimer) {
			clearTimeout(this.handshakeTimer)
			this.handshakeTimer = null
		}
	}

	send(message) {
		if (!this.socket || this.socket.readyState !== 1) return false
		this.socket.send(JSON.stringify(message))
		return true
	}

	/** Send a request and resolve with its responseData, or reject with its comment. */
	request(requestType, requestData = {}) {
		return new Promise((resolve, reject) => {
			if (!this.identified) {
				reject(new Error('not connected'))
				return
			}
			const requestId = String(this.nextRequestId++)
			const timer = setTimeout(() => {
				this.pending.delete(requestId)
				reject(new Error(`${requestType} timed out`))
			}, REQUEST_TIMEOUT_MS)
			this.pending.set(requestId, { resolve, reject, timer })
			this.send({ op: OP_REQUEST, d: { requestType, requestId, requestData } })
		})
	}

	failPending(reason) {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer)
			entry.reject(new Error(reason))
		}
		this.pending.clear()
	}

	receive(raw) {
		let message
		try {
			message = JSON.parse(raw)
		} catch {
			return
		}

		switch (message.op) {
			case OP_HELLO:
				this.identify(message.d)
				break
			case OP_IDENTIFIED: {
				// Identified answers Reidentify as well as Identify, which the protocol document
				// does not say plainly. Only the first one opens a session, and none of them may
				// reset what the session has already been told it is subscribed to.
				const opened = !this.identified
				this.identified = true
				this.clearHandshake()
				// In case the wish changed while the handshake was in flight.
				this.syncSubscriptions()
				if (opened) this.handlers.onStatus('connected', '')
				break
			}
			case OP_EVENT:
				this.dispatch(message.d)
				break
			case OP_REQUEST_RESPONSE:
				this.settle(message.d)
				break
			default:
				break
		}
	}

	identify(hello) {
		// Counted as told at the moment it is sent, the same rule Reidentify uses. If
		// the wish changes while the handshake is in flight, the check made on
		// Identified catches it.
		this.toldLevels = this.wantLevels
		const payload = {
			rpcVersion: 1,
			eventSubscriptions: this.subscriptions,
		}

		if (hello.authentication) {
			const password = this.config.password || ''
			if (!password) {
				this.close()
				this.wanted = true
				this.fail('OBS asks for a password. Put it in this connection.')
				return
			}
			payload.authentication = buildAuth(password, hello.authentication.salt, hello.authentication.challenge)
		}

		this.send({ op: OP_IDENTIFY, d: payload })
	}

	dispatch(data) {
		if (data.eventType === 'InputVolumeMeters') {
			this.handlers.onLevels(data.eventData?.inputs ?? [])
			return
		}
		this.handlers.onEvent(data.eventType, data.eventData ?? {})
	}

	settle(data) {
		const entry = this.pending.get(data.requestId)
		if (!entry) return
		this.pending.delete(data.requestId)
		clearTimeout(entry.timer)

		if (data.requestStatus?.result) {
			entry.resolve(data.responseData ?? {})
		} else {
			entry.reject(new Error(data.requestStatus?.comment || 'request failed'))
		}
	}
}

module.exports = { ObsConnection }
