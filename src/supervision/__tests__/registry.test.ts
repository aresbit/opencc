import { beforeEach, describe, expect, test } from 'bun:test'
import {
  clearSupervision,
  ensureSupervisor,
  registerChild,
  reportChildExit,
  resetChildBudget,
  setSupervisionEnabled,
  unregisterChild,
} from '../registry.js'

describe('supervision registry', () => {
  beforeEach(() => {
    clearSupervision()
  })

  test('an unregistered team is ignored rather than throwing', () => {
    expect(reportChildExit('nobody', 'w', 'crashed').action).toBe('ignore')
  })

  test('a registered child is supervised', () => {
    registerChild('team', { id: 'w' })
    expect(reportChildExit('team', 'w', 'crashed').action).toBe('restart')
  })

  test('an unregistered child stops being supervised', () => {
    registerChild('team', { id: 'w' })
    unregisterChild('team', 'w')
    expect(reportChildExit('team', 'w', 'crashed').action).toBe('ignore')
  })

  test('disabling supervision stops all decisions', () => {
    registerChild('team', { id: 'w' })
    setSupervisionEnabled(false)
    expect(reportChildExit('team', 'w', 'crashed').action).toBe('ignore')
    setSupervisionEnabled(true)
    expect(reportChildExit('team', 'w', 'crashed').action).toBe('restart')
  })

  test('same-named children in different teams stay independent', () => {
    // The handler map is keyed by team+id; a single-key map would have let
    // one team's failure restart the other team's child.
    const fired: string[] = []
    ensureSupervisor('a', { strategy: 'rest_for_one' })
    ensureSupervisor('b', { strategy: 'rest_for_one' })
    registerChild('a', { id: 'lead' })
    registerChild('a', { id: 'w', dependsOn: ['lead'] }, () => fired.push('a/w'))
    registerChild('b', { id: 'w', dependsOn: ['lead'] }, () => fired.push('b/w'))

    reportChildExit('a', 'lead', 'crashed')
    expect(fired).toEqual(['a/w'])
  })

  describe('rest_for_one peer restarts', () => {
    beforeEach(() => {
      clearSupervision()
      ensureSupervisor('team', { strategy: 'rest_for_one' })
    })

    test('a downstream peer is told to restart', () => {
      const restarted: string[] = []
      registerChild('team', { id: 'builder' })
      registerChild('team', { id: 'api', dependsOn: ['builder'] }, reason =>
        restarted.push(reason),
      )

      const decision = reportChildExit('team', 'builder', 'crashed')
      expect(decision.restart).toEqual(['builder', 'api'])
      expect(restarted).toHaveLength(1)
      expect(restarted[0]).toContain('builder')
    })

    test('the reporting child is not restarted via its peer handler', () => {
      // It restarts inline in its own loop, because only it can clear its
      // own conversation. Firing the handler too would restart it twice.
      let selfCalls = 0
      registerChild('team', { id: 'builder' }, () => selfCalls++)
      reportChildExit('team', 'builder', 'crashed')
      expect(selfCalls).toBe(0)
    })

    test('peers are left alone when the decision is escalate', () => {
      const restarted: string[] = []
      registerChild('team', { id: 'builder' })
      registerChild('team', { id: 'api', dependsOn: ['builder'] }, reason =>
        restarted.push(reason),
      )

      expect(reportChildExit('team', 'builder', 'auth_failed').action).toBe(
        'escalate',
      )
      expect(restarted).toHaveLength(0)
    })
  })

  test('a deliberate respawn restores the budget', () => {
    ensureSupervisor('team', { maxRestarts: 1, periodMs: 60_000 })
    registerChild('team', { id: 'w' })
    expect(reportChildExit('team', 'w', 'crashed').action).toBe('restart')
    expect(reportChildExit('team', 'w', 'crashed').action).toBe('escalate')
    resetChildBudget('team', 'w')
    expect(reportChildExit('team', 'w', 'crashed').action).toBe('restart')
  })
})
