/**
 * Eval for the "extension not connected" diagnosis.
 *
 * The daemon reports only "no extension connected", and the previous wording
 * turned that into "install the browser extension first". On the machine that
 * hit it the extension was installed, registered, and running v1.11.5 — the
 * browser was simply detached — so the one instruction given was the one that
 * could not help. The message has to tell those two situations apart.
 *
 * Run:  bun run src/tools/KimiWebBridgeTool/bridge.eval.ts [--verbose]
 */

import { extensionNotConnectedMessage, type BridgeStatus } from './KimiWebBridgeTool.js'

type Case = { group: string; label: string; check: () => string | null }

const INSTALLED: BridgeStatus = {
  running: true,
  extensionConnected: false,
  extensionId: 'fldmhceldgbpfpkbgopacenieobmligc',
  extensionVersion: '1.11.5',
}

const NEVER_SEEN: BridgeStatus = {
  running: true,
  extensionConnected: false,
  extensionId: '',
  extensionVersion: '',
}

const CASES: Case[] = [
  {
    group: 'installed',
    label: 'a remembered extension is not told to reinstall',
    check: () => {
      const m = extensionNotConnectedMessage(INSTALLED)
      if (m.includes('chromewebstore')) return 'offered the store link to an installed user'
      return m.includes('不要重新安装') ? null : m.slice(0, 120)
    },
  },
  {
    group: 'installed',
    label: 'the likely cause is named first',
    check: () => {
      const m = extensionNotConnectedMessage(INSTALLED)
      return m.includes('浏览器没有打开') || m.includes('停用') ? null : m.slice(0, 120)
    },
  },
  {
    group: 'installed',
    label: 'the remembered id and version are quoted as evidence',
    check: () => {
      const m = extensionNotConnectedMessage(INSTALLED)
      if (!m.includes(INSTALLED.extensionId)) return 'id missing'
      return m.includes('1.11.5') ? null : 'version missing'
    },
  },
  {
    group: 'never-seen',
    label: 'an unknown extension does get the install link',
    check: () => {
      const m = extensionNotConnectedMessage(NEVER_SEEN)
      return m.includes('chromewebstore') ? null : m.slice(0, 120)
    },
  },
  {
    group: 'never-seen',
    label: 'the already-installed case is still covered',
    check: () => {
      const m = extensionNotConnectedMessage(NEVER_SEEN)
      return m.includes('若已安装') ? null : m.slice(0, 120)
    },
  },
  {
    group: 'never-seen',
    label: 'a null status is handled like an unknown extension',
    check: () => {
      const m = extensionNotConnectedMessage(null)
      return m.includes('chromewebstore') ? null : m.slice(0, 120)
    },
  },
  {
    group: 'shared',
    label: 'both messages say the daemon itself is up',
    check: () => {
      for (const s of [INSTALLED, NEVER_SEEN, null]) {
        if (!extensionNotConnectedMessage(s).includes('守护进程在运行')) return 'missing daemon state'
      }
      return null
    },
  },
]

function run(verbose: boolean): number {
  const byGroup = new Map<string, { pass: number; total: number }>()
  let passed = 0
  for (const c of CASES) {
    let err: string | null
    try {
      err = c.check()
    } catch (e) {
      err = `threw: ${e instanceof Error ? e.message : String(e)}`
    }
    if (err !== null && typeof err !== 'string') err = `check returned ${String(err)} instead of null`
    const stat = byGroup.get(c.group) ?? { pass: 0, total: 0 }
    stat.total++
    if (!err) {
      stat.pass++
      passed++
    }
    byGroup.set(c.group, stat)
    if (verbose || err) console.log(`${err ? 'FAIL' : 'PASS'}  [${c.group}] ${c.label}${err ? `\n   ${err}` : ''}`)
  }
  const breakdown = [...byGroup.entries()].map(([k, v]) => `${k} ${v.pass}/${v.total}`).join(', ')
  const score = passed / CASES.length
  console.log(`\nCURRENT: ${passed}/${CASES.length} = ${score.toFixed(4)}  (${breakdown})`)
  return score
}

const score = run(process.argv.includes('--verbose'))
process.exitCode = score === 1 ? 0 : 1
