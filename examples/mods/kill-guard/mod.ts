/**
 * kill-guard — the three rules that were learned the expensive way.
 *
 *   1. `kill <number>` needs `ps -p <number>` in the same command. A PID read
 *      out of a `ps | grep` thirty seconds ago may already belong to something
 *      else — on 2026-09-30 it belonged to `systemd --user`, and killing it
 *      took the whole desktop session (and the agent) down for three hours.
 *   2. `pkill -f '<pattern>'` matches the shell that runs it, because the
 *      pattern is written in that shell's own command line. The fix is to
 *      bracket one character: `pkill -f '[/]opt/chrome/chrome'`.
 *   3. Some things are never killed by name, whatever the reason.
 *
 * This is a `tool.call` gate — the control position. Returning `{ deny }`
 * stops the call; it is a decision about whether the call runs, not a
 * replacement for the tool.
 */

const FORBIDDEN = [
  /^systemd(-[a-z0-9-]+)?$/i,
  /^gdm3?$/i,
  /^dbus-(daemon|broker)$/i,
  /^feishu[_-]bridge\.py$/i,
  /^matebot-bridge/i,
  /^sshd$/i,
]

/** Words that wrap another command rather than being the command. */
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'env', 'nohup', 'time', 'nice', 'setsid', 'xargs'])

const SEGMENT_SPLIT = /(?:&&|\|\||[;|&\n])/

function segments(command: string): string[] {
  // Split on shell operators, but not inside single quotes: a deny message
  // that itself contains `|` must not be read as a pipeline.
  const out: string[] = []
  let buf = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      buf += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      buf += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '&' || ch === '|') {
      out.push(buf)
      buf = ''
      // swallow the second character of && and ||
      while (i + 1 < command.length && (command[i + 1] === '&' || command[i + 1] === '|')) i++
      continue
    }
    buf += ch
  }
  out.push(buf)
  return out.map(s => s.trim()).filter(Boolean)
}

function unquote(token: string): string {
  return token.replace(/^['"]|['"]$/g, '')
}

function head(segment: string): { cmd: string; args: string[] } {
  const tokens = segment.split(/\s+/)
  let i = 0
  // Skip `VAR=value` assignments and wrappers in front of the real command.
  while (i < tokens.length) {
    const t = tokens[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || WRAPPERS.has(t)) {
      i++
      continue
    }
    break
  }
  const cmd = (tokens[i] ?? '').replace(/^.*\//, '')
  return { cmd, args: tokens.slice(i + 1) }
}

function isFlag(token: string): boolean {
  return token === '--' || /^-/.test(token)
}

function numericPids(args: string[]): string[] {
  const pids: string[] = []
  for (const raw of args) {
    const t = unquote(raw)
    if (isFlag(t)) continue
    if (/^\d+$/.test(t)) pids.push(t)
  }
  return pids
}

const BRACKET_HINT =
  "The bracket trick: write the first character of the path as a class — " +
  "`pkill -f '[/]opt/google/chrome/chrome'`. The regex still matches `/`, but " +
  "the shell's own command line contains `[/]`, so the shell does not match " +
  "itself. (2026-10-02: an unbracketed pattern killed the bash running it.)"

function check(segment: string, whole: string, options: any): string | null {
  const { cmd, args } = head(segment)
  const strictPkill = options?.strictPkill !== false
  const requirePsCheck = options?.requirePsCheck !== false

  if (cmd === 'killall5') {
    return 'killall5 signals every process on the machine. Refused unconditionally.'
  }

  if (cmd !== 'kill' && cmd !== 'pkill' && cmd !== 'killall') return null

  const patterns = args.filter(a => !isFlag(a)).map(unquote)
  for (const p of patterns) {
    if (FORBIDDEN.some(re => re.test(p))) {
      return (
        `"${p}" is on the never-kill list (systemd, systemd --user, gdm, dbus, ` +
        `sshd, feishu_bridge.py). On 2026-09-30 a bare \`kill\` of a PID that ` +
        `turned out to be systemd --user took the session and the agent down ` +
        `for three hours. If you need this process restarted, use ` +
        `\`systemctl --user restart <unit>\` or ask the person.`
      )
    }
  }

  if (cmd === 'kill') {
    const pids = numericPids(args)
    if (pids.includes('1')) {
      return 'PID 1 is init. Refused unconditionally.'
    }
    if (pids.length === 0) {
      // `kill %1` (job), `kill $VAR` (pidfile) — the PID is not knowable here,
      // so there is nothing to check and nothing to refuse.
      return null
    }
    if (requirePsCheck && !/\bps\s+-p\b|\bps\s+-o\s+pid\b/.test(whole)) {
      return (
        `Killing PID ${pids.join(', ')} without looking it up first. Add ` +
        `\`ps -p ${pids[0]} -o pid,ppid,cmd\` to the same command and read the ` +
        `output before killing, or kill by name with an exact \`pkill -f\` ` +
        `pattern. A PID copied from a \`ps | grep\` may already have been ` +
        `reused by another process — that is exactly how systemd --user was ` +
        `killed here.`
      )
    }
    return null
  }

  // pkill / killall
  const hasFullMatch = args.some(a => a === '-f' || a === '--full' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))
  const pattern = patterns.find(p => p !== '') ?? ''
  if (!pattern) {
    return `${cmd} with no pattern would signal everything it can match. Name the process exactly.`
  }
  if (hasFullMatch && strictPkill && !pattern.includes('[')) {
    return `\`${cmd} -f '${pattern}'\` has no self-exclusion; the shell running it contains that string too. ${BRACKET_HINT}`
  }
  return null
}

export function register(on: any, options: any, ctx: any) {
  on('tool.call', { tool_name: 'Bash' }, (_$: any, e: any, next: any) => {
    const command = String(e?.tool_input?.command ?? '')
    if (!command) return next(e)
    for (const segment of segments(command)) {
      const denial = check(segment, command, options)
      if (denial) {
        ctx.ui?.toast?.({ message: 'kill-guard refused a kill', tone: 'warn' })
        return { deny: denial }
      }
    }
    return next(e)
  })

  // Returns the rules rather than printing them: `opencc mods run` prints a
  // returned string, and a mod that calls `$.mods.run` gets the same text.
  on('command.invoke', { command: 'rules' }, () => {
    return [
      'kill-guard refuses:',
      '  1. `kill <number>` without `ps -p <number>` in the same command.',
      '  2. `pkill -f <pattern>` whose pattern is not bracket-escaped.',
      '  3. killing systemd / systemd --user / gdm / dbus-daemon / sshd / feishu_bridge.py / killall5.',
      '',
      BRACKET_HINT,
    ].join('\n')
  })
}
