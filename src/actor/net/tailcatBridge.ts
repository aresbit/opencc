/**
 * `tailcat:` peers — actor links that never expose a raw TCP port.
 *
 * A peer table entry may name a tailcat address blob instead of a host:port:
 *
 *   {"tars-pc": "tailcat:<addrblob>:7781"}
 *
 * The blob is the server's public key plus its DERP/bootstrap information; the
 * port is the port on that host. actord cannot dial a tailcat target directly,
 * because a tailcat pipe is a child process rather than a socket address. So we
 * start a loopback listener here and spawn one `tailcat <blob> <port>` per
 * accepted connection, copying bytes in both directions. actord then dials
 * `ws://127.0.0.1:<port>` exactly as it would any other peer, and the traffic
 * crosses the network inside WireGuard instead of in the clear.
 *
 * Why this shape: the peer table stays the single place a route is described,
 * the TLS/WS protocol between actords is unchanged, and tailcat's own
 * NAT traversal and relay fallback come along for free. The cost is one child
 * process per connection, which is the same cost `ssh -o ProxyCommand` pays.
 */

import type { Subprocess } from 'bun'

const PREFIX = 'tailcat:'

export type TailcatTarget = {
  /** The `tc...` address blob printed by `tailcat --full-address`. */
  blob: string
  /** Port on the tailcat server to reach. */
  port: number
}

export type TailcatBridge = {
  /** Loopback WebSocket base, e.g. `ws://127.0.0.1:41273`. */
  url: string
  stop(): void
}

/**
 * Parse a peer value. Returns null for anything that is not a tailcat peer, so
 * ordinary `ws://` entries pass through untouched.
 *
 * Accepted forms: `tailcat:<blob>:<port>` and `tailcat://<blob>/<port>`.
 * A URL parser is deliberately avoided: the blob is base64url and
 * case-sensitive, and URL host parsing lowercases and percent-decodes it.
 */
export function parseTailcatPeer(value: string): TailcatTarget | null {
  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith(PREFIX)) return null
  const rest = trimmed.slice(PREFIX.length).replace(/^\/+/, '')
  const match = /^([A-Za-z0-9_-]{16,})[:/](\d{1,5})$/.exec(rest)
  if (!match) {
    throw new Error(
      `invalid tailcat peer "${value}": expected tailcat:<addrblob>:<port>`,
    )
  }
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid tailcat peer port in "${value}"`)
  }
  return { blob: match[1]!, port }
}

/** Where the tailcat binary lives. Overridable for tests and bundled hosts. */
function tailcatBinary(): string {
  return process.env.OPENCC_TAILCAT_BIN?.trim() || 'tailcat'
}

async function pump(
  stream: ReadableStream<Uint8Array> | null | undefined,
  write: (chunk: Uint8Array) => void,
): Promise<void> {
  if (!stream) return
  try {
    for await (const chunk of stream) write(chunk)
  } catch {
    // The socket or the child went away; teardown is handled by the caller.
  }
}

type SocketData = { proc?: Subprocess; closed?: boolean }

/**
 * Start a loopback listener that tunnels each connection through tailcat.
 *
 * The listener binds 127.0.0.1 on an ephemeral port, so it is reachable only
 * from this host and never widens the machine's exposed surface — the point of
 * choosing tailcat in the first place.
 */
export function startTailcatBridge(
  target: TailcatTarget,
  opts: { bin?: string; log?: (line: string) => void } = {},
): TailcatBridge {
  const bin = opts.bin ?? tailcatBinary()
  const log = opts.log ?? (() => {})
  const procs = new Set<Subprocess>()

  const server = Bun.listen<SocketData>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        let proc: Subprocess
        try {
          proc = Bun.spawn([bin, target.blob, String(target.port)], {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
          })
        } catch (error) {
          log(`spawn failed: ${String(error)}`)
          socket.end()
          return
        }
        socket.data = { proc }
        procs.add(proc)

        void pump(proc.stdout as ReadableStream<Uint8Array>, chunk => {
          if (!socket.data?.closed) socket.write(chunk)
        })
        void pump(proc.stderr as ReadableStream<Uint8Array>, chunk => {
          const text = new TextDecoder().decode(chunk).trim()
          if (text) log(text.split('\n')[0]!)
        })
        void proc.exited.then(() => {
          procs.delete(proc)
          if (!socket.data?.closed) {
            socket.data = { ...socket.data, closed: true }
            try {
              socket.end()
            } catch {
              // Already gone.
            }
          }
        })
      },
      data(socket, data) {
        const proc = socket.data?.proc
        if (!proc?.stdin) return
        try {
          proc.stdin.write(data)
          proc.stdin.flush()
        } catch {
          // Child died mid-write; its exit handler closes the socket.
        }
      },
      close(socket) {
        socket.data = { ...socket.data, closed: true }
        const proc = socket.data?.proc
        if (proc) {
          try {
            proc.stdin?.end()
          } catch {
            // Best effort.
          }
          proc.kill()
        }
      },
    },
  })

  log(`bridging ${server.port} -> tailcat:${target.port}`)
  return {
    url: `ws://127.0.0.1:${server.port}`,
    stop() {
      try {
        server.stop(true)
      } catch {
        // Already stopped.
      }
      for (const proc of procs) proc.kill()
      procs.clear()
    },
  }
}

/** Start bridges for every tailcat entry, leaving other peers untouched. */
export function resolvePeerBridges(
  peers: Record<string, string>,
  opts: { bin?: string; log?: (line: string) => void } = {},
): { peers: Record<string, string>; bridges: Array<TailcatBridge & { node: string }> } {
  const resolved: Record<string, string> = {}
  const bridges: Array<TailcatBridge & { node: string }> = []
  for (const [node, value] of Object.entries(peers)) {
    let target: TailcatTarget | null = null
    try {
      target = parseTailcatPeer(value)
    } catch (error) {
      opts.log?.(`peer ${node}: ${String(error)}; skipping`)
      continue
    }
    if (!target) {
      resolved[node] = value
      continue
    }
    const bridge = startTailcatBridge(target, opts)
    bridges.push({ ...bridge, node })
    resolved[node] = bridge.url
  }
  return { peers: resolved, bridges }
}
