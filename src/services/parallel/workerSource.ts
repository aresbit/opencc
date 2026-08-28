/**
 * The worker's own source, as a string.
 *
 * Not a separate file on disk, because opencc builds to one bundled
 * `dist/cli.js` — a worker referenced by path resolves in development and is
 * simply absent from the shipped binary, which is the worst kind of difference
 * between the two. Embedded as a string it is part of whatever is running.
 *
 * The cost is that this code cannot import anything from opencc. That is
 * acceptable, and in fact clarifying: what belongs on another core is the
 * CPU-bound codec work — assembling request bytes, parsing responses — not
 * orchestration, not tool execution, and not anything that touches the
 * filesystem or the shell, all of which would need the shared state a worker
 * does not have.
 */
// biome-ignore lint/complexity/noUselessStringRaw: this template holds source
// code, not prose. There is no escape sequence in it *today*, which is exactly
// when dropping String.raw is a trap — the next edit that adds a "\n" to a
// string in the worker would be silently turned into a real newline.
export const WORKER_SOURCE = String.raw`
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Shared fragments, by name. Set once at startup and replaced only by an
// explicit message; the buffers themselves are never written to.
let fragments = new Map()

function viewOf(handle) {
  return new Uint8Array(handle.buffer, 0, handle.byteLength)
}

function concat(parts) {
  let total = 0
  for (const p of parts) total += p.byteLength
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

// Build a request body from shared fragments plus this agent's own delta.
// The shared part is copied from shared memory rather than re-serialised, so
// the work here is proportional to the delta, not to the whole context.
function assemble(payload) {
  const parts = []
  for (const piece of payload.pieces) {
    if (piece.fragment !== undefined) {
      const handle = fragments.get(piece.fragment)
      if (!handle) throw new Error('unknown shared fragment: ' + piece.fragment)
      parts.push(viewOf(handle))
    } else {
      parts.push(encoder.encode(piece.text))
    }
  }
  const bytes = concat(parts)
  return { transfer: bytes.buffer, byteLength: bytes.byteLength }
}

// Parse off the main thread. A large response body is milliseconds of blocking
// JSON.parse on the event loop, and with a fleet of agents those milliseconds
// queue behind each other.
function parse(payload) {
  const text = payload.text !== undefined
    ? payload.text
    : decoder.decode(new Uint8Array(payload.buffer, 0, payload.byteLength))
  return { value: JSON.parse(text) }
}

const jobs = { assemble, parse }

self.onmessage = event => {
  const msg = event.data
  if (msg.kind === 'fragments') {
    fragments = new Map(msg.fragments.map(f => [f.name, f]))
    postMessage({ id: msg.id, ok: true, result: { count: fragments.size } })
    return
  }
  const job = jobs[msg.kind]
  if (!job) {
    postMessage({ id: msg.id, ok: false, error: 'unknown job: ' + msg.kind })
    return
  }
  try {
    const out = job(msg.payload)
    if (out && out.transfer) {
      postMessage(
        { id: msg.id, ok: true, result: { buffer: out.transfer, byteLength: out.byteLength } },
        [out.transfer],
      )
    } else {
      postMessage({ id: msg.id, ok: true, result: out })
    }
  } catch (error) {
    postMessage({ id: msg.id, ok: false, error: String(error && error.message ? error.message : error) })
  }
}
`
