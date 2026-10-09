import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadAsset, isComplete, sizeOf } from '../download.js'

/** Deterministic payload so byte-for-byte comparison is meaningful. */
const PAYLOAD = new Uint8Array(1000)
for (let i = 0; i < PAYLOAD.length; i += 1) PAYLOAD[i] = i % 251

const FULL = PAYLOAD.byteLength
/** Bytes the "dropped" first response delivers before the connection dies. */
const DROP_AT = 500

let server: ReturnType<typeof Bun.serve>
let baseUrl = ''
let requests: Array<{ path: string; range: string | null }> = []

/**
 * The dropped attempt's body is a plain truncated 206, not an erroring stream.
 *
 * A real connection drop usually arrives as a stream error, but several
 * runtimes (Bun among them) end the body cleanly instead — so the truncated
 * body is the strictly harder case for the downloader: it cannot rely on a
 * throw, it must notice the short read itself and resume. Keeping the response
 * protocol-legal (206 + content-range) makes it a truncated transfer rather
 * than a malformed one.
 */

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const range = request.headers.get('range')
      requests.push({ path: url.pathname, range })

      if (url.pathname === '/drop' && range === null) {
        // First attempt: a truncated 206 — fewer bytes than the asset's size.
        return new Response(PAYLOAD.subarray(0, DROP_AT), {
          status: 206,
          headers: {
            'content-range': `bytes 0-${DROP_AT - 1}/${FULL}`,
            'content-length': String(DROP_AT),
          },
        })
      }

      if (range !== null) {
        // Honour a Range resume the way a real asset host does.
        const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
        return new Response(PAYLOAD.subarray(start), {
          status: 206,
          headers: {
            'content-range': `bytes ${start}-${FULL - 1}/${FULL}`,
            'content-length': String(FULL - start),
          },
        })
      }

      // /whole and an un-ranged /drop retry after the drop is over: complete file.
      return new Response(PAYLOAD, {
        status: 200,
        headers: { 'content-length': String(FULL) },
      })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  await server.stop(true)
})

describe('downloadAsset', () => {
  test('downloads a whole file and reports progress up to the total', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencc-dl-'))
    try {
      const dest = join(dir, 'whole.bin')
      const seen: number[] = []
      let lastTotal: number | undefined
      const result = await downloadAsset({
        url: `${baseUrl}/whole`,
        destination: dest,
        expectedBytes: FULL,
        onProgress: (written, total) => {
          seen.push(written)
          lastTotal = total
        },
      })
      expect(result.bytes).toBe(FULL)
      expect(result.skipped).toBe(false)
      const bytes = new Uint8Array(await readFile(dest))
      expect(bytes).toEqual(PAYLOAD)
      expect(lastTotal).toBe(FULL)
      expect(seen.at(-1)).toBe(FULL)
      expect(await isComplete(dest, FULL)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('resumes a dropped transfer with a Range request and completes the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencc-dl-'))
    const before = requests.filter((r) => r.path === '/drop').length
    try {
      const dest = join(dir, 'resumed.bin')
      const result = await downloadAsset({
        url: `${baseUrl}/drop`,
        destination: dest,
        expectedBytes: FULL,
      })
      expect(result.bytes).toBe(FULL)
      expect(result.attempts).toBe(2)
      const bytes = new Uint8Array(await readFile(dest))
      expect(bytes).toEqual(PAYLOAD)

      // Two requests reached the server: the dropped first one, then the Range
      // resume starting where the first left off.
      const hits = requests.filter((r) => r.path === '/drop')
      expect(hits.length - before).toBe(2)
      expect(hits.at(-1)?.range).toBe(`bytes=${DROP_AT}-`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips a destination that is already complete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencc-dl-'))
    try {
      const dest = join(dir, 'done.bin')
      await writeFile(dest, PAYLOAD)
      const result = await downloadAsset({
        url: `${baseUrl}/whole`,
        destination: dest,
        expectedBytes: FULL,
      })
      expect(result.skipped).toBe(true)
      expect(result.attempts).toBe(0)
      expect(result.bytes).toBe(FULL)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('sizeOf / isComplete', () => {
  test('a missing file is size 0 and only a matching length is complete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencc-dl-'))
    try {
      const path = join(dir, 'asset.bin')
      expect(await sizeOf(path)).toBe(0)
      await writeFile(path, PAYLOAD)
      expect(await sizeOf(path)).toBe(FULL)
      expect(await isComplete(path, FULL)).toBe(true)
      expect(await isComplete(path, FULL + 1)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
