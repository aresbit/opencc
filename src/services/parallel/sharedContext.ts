/**
 * One context, read by every core without copying it.
 *
 * The reason a thousand subagents cannot simply be spread across worker threads
 * is that JavaScript objects do not cross a thread boundary — they are
 * structured-cloned. Dispatching N agents that share a system prompt, a tool
 * set and a parent conversation would clone that prefix N times, and the clone
 * is the same order of magnitude as the work being moved off the main thread.
 * The parallelism would pay for itself and no more.
 *
 * A SharedArrayBuffer does cross the boundary, by reference. What it cannot
 * hold is objects — only bytes. So the shared part of a context is encoded once
 * into the exact UTF-8 JSON bytes that will go on the wire, and every worker
 * maps those bytes and concatenates them with its own agent's delta. The prefix
 * is serialised once for the whole fleet instead of once per agent per turn,
 * and the workers never deserialise it at all.
 *
 * Fragments are immutable by construction. Nothing locks, because nothing
 * writes after publication: a changed system prompt publishes a new fragment
 * and the old one is released when its last reader is done. That is what makes
 * lock-free sharing safe here rather than merely fast.
 */

/** A published, immutable, pre-encoded JSON fragment living in shared memory. */
export interface SharedFragment {
  readonly name: string
  readonly version: number
  /** Shared with every worker by reference, never copied. */
  readonly buffer: SharedArrayBuffer
  /** Bytes actually used; the buffer itself may be larger. */
  readonly byteLength: number
}

/** What crosses to a worker: a handle, not the data. */
export interface SharedFragmentHandle {
  name: string
  version: number
  buffer: SharedArrayBuffer
  byteLength: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

let versionCounter = 0

/**
 * Encode a value into shared memory as the JSON bytes it will be sent as.
 *
 * Encoded rather than stored as an object on purpose: the worker's job is to
 * assemble a request body, and a fragment that is already the right bytes turns
 * that job into a memcpy. Storing the object instead would mean each worker
 * re-serialising the same prefix, which is the cost being eliminated.
 */
export function publishFragment(name: string, value: unknown): SharedFragment {
  const json = JSON.stringify(value)
  if (json === undefined) {
    throw new Error(
      `publishFragment("${name}") received a value JSON.stringify cannot represent`,
    )
  }
  return publishRaw(name, json)
}

/** Publish text that is already JSON. */
export function publishRaw(name: string, json: string): SharedFragment {
  // Measure before allocating: UTF-8 length is not string length, and a buffer
  // sized from the string would truncate on any non-ASCII content — which for a
  // system prompt or a tool description is not a corner case.
  const byteLength = encoder.encode(json).byteLength
  const buffer = new SharedArrayBuffer(byteLength)
  const written = encoder.encodeInto(json, new Uint8Array(buffer))
  if (written.written !== byteLength) {
    throw new Error(
      `publishFragment("${name}") encoded ${written.written} of ${byteLength} bytes`,
    )
  }
  versionCounter += 1
  return { name, version: versionCounter, buffer, byteLength }
}

/** The handle to hand a worker. Carries no copy of the data. */
export function toHandle(fragment: SharedFragment): SharedFragmentHandle {
  return {
    name: fragment.name,
    version: fragment.version,
    buffer: fragment.buffer,
    byteLength: fragment.byteLength,
  }
}

/** A zero-copy view of a fragment's bytes. */
export function viewOf(handle: SharedFragmentHandle): Uint8Array {
  return new Uint8Array(handle.buffer, 0, handle.byteLength)
}

/**
 * Read a fragment back as text.
 *
 * Costs a copy, so it is for inspection and tests rather than the hot path —
 * assembling a request should concatenate `viewOf` bytes and never decode.
 */
export function readText(handle: SharedFragmentHandle): string {
  return decoder.decode(viewOf(handle))
}

/** Read a fragment back as the value it was published from. */
export function readValue<T = unknown>(handle: SharedFragmentHandle): T {
  return JSON.parse(readText(handle)) as T
}

/**
 * Join byte segments into one buffer.
 *
 * The assembly step: shared fragments contribute their bytes by reference and
 * only the per-agent delta is encoded per call, so the cost is proportional to
 * the delta rather than to the whole context.
 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/** Encode a per-agent delta for concatenation with shared fragments. */
export function encodeDelta(text: string): Uint8Array {
  return encoder.encode(text)
}

/**
 * A registry of the fragments a fleet shares, so a pool can hand every worker
 * the same set and swap one without disturbing the others.
 */
export class SharedContext {
  #fragments = new Map<string, SharedFragment>()

  publish(name: string, value: unknown): SharedFragment {
    const fragment = publishFragment(name, value)
    this.#fragments.set(name, fragment)
    return fragment
  }

  publishText(name: string, json: string): SharedFragment {
    const fragment = publishRaw(name, json)
    this.#fragments.set(name, fragment)
    return fragment
  }

  get(name: string): SharedFragment | undefined {
    return this.#fragments.get(name)
  }

  /** Drop a fragment. In-flight readers keep working — they hold the buffer. */
  release(name: string): boolean {
    return this.#fragments.delete(name)
  }

  handles(): SharedFragmentHandle[] {
    return [...this.#fragments.values()].map(toHandle)
  }

  /** Total shared bytes — the amount paid once instead of once per agent. */
  get byteLength(): number {
    let total = 0
    for (const fragment of this.#fragments.values()) total += fragment.byteLength
    return total
  }

  get size(): number {
    return this.#fragments.size
  }
}
