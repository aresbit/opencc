import { afterEach, describe, expect, test } from 'bun:test'
import {
  bindAgent,
  clearMounts,
  createNs,
  isVisible,
  mount,
  resolve,
} from '../mountHook.js'

/**
 * Regression: every background agent was denied every tool, Read included.
 *
 * `subagent.start` gives each subagent a child of the root namespace. Root has
 * no mounts — nothing mounts the built-ins, because there is no MCP server to
 * mount for them — so the child inherited an empty mount table and
 * `isToolVisible` read "absent from this namespace's mounts" as "denied". The
 * agent could not even read a file, which is the opposite of the
 * `fail-open: agent uses root` intent stated where the namespace is created.
 *
 * The rule pinned here: a mount table can only withhold tools that some mount
 * actually provides. Built-ins are ambient and stay reachable.
 */
describe('namespace tool visibility', () => {
  afterEach(() => {
    clearMounts()
  })

  test('an empty child namespace still sees built-in tools', () => {
    // The exact shape a spawned subagent inherits: a child of root, no mounts.
    const ns = createNs('agent:worker-1')
    bindAgent('worker-1', ns.id)
    expect(resolve(ns.id)).toEqual([])

    expect(isVisible(ns.id, 'Read')).toBe(true)
    expect(isVisible(ns.id, 'Bash')).toBe(true)
    expect(isVisible(ns.id, 'Grep')).toBe(true)
  })

  test('a namespace still hides a tool another namespace mounts', () => {
    const withGmail = createNs('has-gmail')
    mount('/comms/gmail', 'gmail', 'Gmail', ['gmail_send', 'gmail_search'], {}, withGmail.id)
    const without = createNs('no-gmail')

    expect(isVisible(withGmail.id, 'gmail_send')).toBe(true)
    expect(isVisible(without.id, 'gmail_send')).toBe(false)
    // …while the built-in stays visible in the one without the mount.
    expect(isVisible(without.id, 'Read')).toBe(true)
  })

  test('mounting an MCP server does not shadow the built-ins', () => {
    const ns = createNs('agent:worker-2')
    mount('/comms/gmail', 'gmail', 'Gmail', ['gmail_send'], {}, ns.id)

    expect(isVisible(ns.id, 'gmail_send')).toBe(true)
    expect(isVisible(ns.id, 'Read')).toBe(true)
  })

  test('an unknown namespace is fail-open', () => {
    expect(isVisible('ns_does_not_exist', 'Read')).toBe(true)
  })

  test('a child inherits its parent mounts', () => {
    const parent = createNs('parent')
    mount('/comms/gmail', 'gmail', 'Gmail', ['gmail_send'], {}, parent.id)
    const child = createNs('child', parent.id)

    expect(isVisible(child.id, 'gmail_send')).toBe(true)
  })

  test('inherit:false keeps a mount out of the child, built-ins unaffected', () => {
    const parent = createNs('parent')
    mount('/comms/gmail', 'gmail', 'Gmail', ['gmail_send'], { inherit: false }, parent.id)
    const child = createNs('child', parent.id)

    expect(isVisible(child.id, 'gmail_send')).toBe(false)
    expect(isVisible(child.id, 'Read')).toBe(true)
  })
})
