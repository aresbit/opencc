import { access, mkdir } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

export async function fileExists(path: string): Promise<boolean> {
  return access(path, fsConstants.F_OK).then(
    () => true,
    () => false,
  )
}

export function stateDir(): string {
  return join(getClaudeConfigHomeDir(), 'apire')
}

export async function ensureStateDir(): Promise<void> {
  await mkdir(stateDir(), { recursive: true })
}

export async function writeWorkspaceFile(
  workspaceId: string,
  file: string,
  content: string,
): Promise<void> {
  await ensureStateDir()
  const dir = join(stateDir(), workspaceId)
  await mkdir(dir, { recursive: true })
  await Bun.write(join(dir, file), content)
}

export async function readWorkspaceFile<T>(
  workspaceId: string,
  file: string,
): Promise<T | null> {
  const path = join(stateDir(), workspaceId, file)
  if (!(await fileExists(path))) return null
  try {
    return JSON.parse(await Bun.file(path).text()) as T
  } catch {
    return null
  }
}

export function workspaceDir(workspaceId: string): string {
  return join(stateDir(), workspaceId)
}
