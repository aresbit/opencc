import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseTailcatPeer, resolvePeerBridges, startTailcatBridge } from './tailcatBridge.js'

const BLOB = 'tcpGFwWCCai5LTK1TdYl-HX6D98V6wxTQOblyaByJ6qKM7IP7OdmFrWCANk7xoyza5D1YjdP'

describe('parseTailcatPeer', () => {
  test('accepts both forms and keeps the blob case', () => {
    expect(parseTailcatPeer(`tailcat:${BLOB}:7781`)).toEqual({ blob: BLOB, port: 7781 })
    expect(parseTailcatPeer(`tailcat://${BLOB}/22`)).toEqual({ blob: BLOB, port: 22 })
  })

  test('returns null for ordinary peers', () => {
    expect(parseTailcatPeer('ws://192.168.3.222:7781')).toBeNull()
    expect(parseTailcatPeer('ws://[2409::1]:7781')).toBeNull()
  })

  test('rejects malformed tailcat peers', () => {
    expect(() => parseTailcatPeer('tailcat:' + BLOB)).toThrow()
    expect(() => parseTailcatPeer(`tailcat:${BLOB}:0`)).toThrow()
    expect(() => parseTailcatPeer(`tailcat:${BLOB}:70000`)).toThrow()
  })
})

describe('resolvePeerBridges', () => {
  test('passes ws peers through and bridges tailcat peers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tailcat-'))
    const fake = join(dir, 'fake-tailcat')
    writeFileSync(fake, '#!/bin/sh\nexec cat\n')
    chmodSync(fake, 0o755)

    const { peers, bridges } = resolvePeerBridges(
      { 'plain-node': 'ws://127.0.0.1:9', 'tars-pc': `tailcat:${BLOB}:7781` },
      { bin: fake },
    )
    try {
      expect(peers['plain-node']).toBe('ws://127.0.0.1:9')
      expect(peers['tars-pc']).toStartWith('ws://127.0.0.1:')
      expect(bridges).toHaveLength(1)
      expect(bridges[0]!.node).toBe('tars-pc')
    } finally {
      for (const bridge of bridges) bridge.stop()
    }
  })
})

describe('startTailcatBridge', () => {
  test('forwards bytes both ways through the child process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tailcat-'))
    const fake = join(dir, 'fake-tailcat')
    // Ignores the blob/port arguments and echoes stdin, the shape a tailcat
    // client has from the caller's side: bytes in, bytes out.
    writeFileSync(fake, '#!/bin/sh\nexec cat\n')
    chmodSync(fake, 0o755)

    const bridge = startTailcatBridge({ blob: BLOB, port: 7781 }, { bin: fake })
    const port = Number(new URL(bridge.url).port)
    try {
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port }, () => socket.write('ping-through-bridge'))
        const timer = setTimeout(() => reject(new Error('bridge timed out')), 5_000)
        socket.on('data', data => {
          clearTimeout(timer)
          socket.destroy()
          resolve(String(data))
        })
        socket.on('error', error => {
          clearTimeout(timer)
          reject(error)
        })
      })
      expect(echoed).toBe('ping-through-bridge')
    } finally {
      bridge.stop()
    }
  })
})
