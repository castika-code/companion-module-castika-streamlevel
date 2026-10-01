const { deflateSync } = require('node:zlib')

// A PNG writer: a small rectangle of pixels and one deflate call.

const CRC_TABLE = (() => {
	const table = new Int32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		}
		table[n] = c
	}
	return table
})()

function crc32(buffer) {
	let c = 0xffffffff
	for (let i = 0; i < buffer.length; i++) {
		c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
	}
	return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length, 0)
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(body), 0)
	return Buffer.concat([length, body, crc])
}

/**
 * Encode 8 bit RGB pixels as a PNG.
 *
 * `pixels` holds width * height * 3 bytes, row by row from the top.
 */
function encodePng(width, height, pixels) {
	const stride = width * 3
	const raw = Buffer.alloc((stride + 1) * height)
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0 // filter type 0: the row is stored as it is
		pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
	}

	const header = Buffer.alloc(13)
	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	header[8] = 8 // bits per channel
	header[9] = 2 // color type 2: RGB
	header[10] = 0 // deflate
	header[11] = 0 // adaptive filtering
	header[12] = 0 // no interlace

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw, { level: 6 })),
		chunk('IEND', Buffer.alloc(0)),
	])
}

/** A blank surface to draw on, with the few primitives the meters need. */
class Canvas {
	constructor(width, height) {
		this.width = width
		this.height = height
		this.pixels = Buffer.alloc(width * height * 3)
	}

	fill(color) {
		this.rect(0, 0, this.width, this.height, color)
	}

	rect(x, y, w, h, color) {
		const x0 = Math.max(0, Math.round(x))
		const y0 = Math.max(0, Math.round(y))
		const x1 = Math.min(this.width, Math.round(x + w))
		const y1 = Math.min(this.height, Math.round(y + h))
		for (let py = y0; py < y1; py++) {
			let offset = (py * this.width + x0) * 3
			for (let px = x0; px < x1; px++) {
				this.pixels[offset++] = color[0]
				this.pixels[offset++] = color[1]
				this.pixels[offset++] = color[2]
			}
		}
	}

	outline(x, y, w, h, color, thickness = 1) {
		this.rect(x, y, w, thickness, color)
		this.rect(x, y + h - thickness, w, thickness, color)
		this.rect(x, y, thickness, h, color)
		this.rect(x + w - thickness, y, thickness, h, color)
	}

	/** A copy of one rectangle of this canvas. */
	crop(x, y, width, height) {
		const out = new Canvas(width, height)
		for (let row = 0; row < height; row++) {
			const from = ((y + row) * this.width + x) * 3
			this.pixels.copy(out.pixels, row * width * 3, from, from + width * 3)
		}
		return out
	}

	toPng() {
		return encodePng(this.width, this.height, this.pixels)
	}

	toDataUrl() {
		return `data:image/png;base64,${this.toPng().toString('base64')}`
	}
}

module.exports = { encodePng, Canvas }
