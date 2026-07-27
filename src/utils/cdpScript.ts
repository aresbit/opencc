import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { getClaudeConfigHomeDir } from './envUtils.js'

const CDP_SCRIPT_RELATIVE_PATH = 'scripts/cdp.mjs'

function unique(paths: string[]): string[] {
  return [...new Set(paths)]
}

export function getCDPScriptCandidates(moduleUrl = import.meta.url): string[] {
  const moduleDir = dirname(fileURLToPath(moduleUrl))
  const configuredPath = process.env.OPENCC_CDP_SCRIPT

  return unique([
    ...(configuredPath ? [resolve(configuredPath)] : []),
    resolve(process.cwd(), CDP_SCRIPT_RELATIVE_PATH),
    join(moduleDir, CDP_SCRIPT_RELATIVE_PATH),
    resolve(moduleDir, '../../', CDP_SCRIPT_RELATIVE_PATH),
    join(getClaudeConfigHomeDir(), 'skills/chrome-cdp', CDP_SCRIPT_RELATIVE_PATH),
  ])
}

export function findCDPScriptPath(moduleUrl = import.meta.url): string | null {
  for (const candidate of getCDPScriptCandidates(moduleUrl)) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

