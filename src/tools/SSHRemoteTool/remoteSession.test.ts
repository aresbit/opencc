import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  closeSession,
  connectSession,
  execRemote,
  parseRemoteTarget,
  readRemote,
  resolveRemotePath,
  shellQuote,
  validatePasswordFile,
  type RemoteSession,
  writeRemote,
} from './remoteSession.js'

describe('SSH remote target parsing', () => {
  test('parses ssh URLs', () => {
    expect(parseRemoteTarget('ssh://dev@example.com:2222/srv/app')).toEqual({
      raw: 'ssh://dev@example.com:2222/srv/app',
      host: 'example.com',
      user: 'dev',
      port: 2222,
      workspace: '/srv/app',
    })
  })

  test('parses scp-style targets and SSH aliases', () => {
    expect(parseRemoteTarget('build-box:/home/dev/project')).toEqual({
      raw: 'build-box:/home/dev/project',
      host: 'build-box',
      user: undefined,
      workspace: '/home/dev/project',
    })
  })

  test('allows a bare SSH alias and resolves its login home on connect', () => {
    expect(parseRemoteTarget('build-box')).toEqual({
      raw: 'build-box',
      host: 'build-box',
      user: undefined,
      workspace: '',
    })
    expect(parseRemoteTarget('ssh://dev@example.com')).toEqual({
      raw: 'ssh://dev@example.com',
      host: 'example.com',
      user: 'dev',
      port: undefined,
      workspace: '',
    })
  })

  test('requires an absolute workspace', () => {
    expect(() => parseRemoteTarget('build-box:relative/path')).toThrow(
      'absolute POSIX path',
    )
  })
})

describe('SSH remote path confinement', () => {
  const session = {
    name: 'default',
    raw: 'box:/srv/app',
    host: 'box',
    workspace: '/srv/app',
    connectedAt: '',
    controlPath: '',
  } satisfies RemoteSession

  test('resolves workspace-relative paths', () => {
    expect(resolveRemotePath(session, 'src/main.ts')).toBe(
      '/srv/app/src/main.ts',
    )
  })

  test('rejects lexical workspace escapes', () => {
    expect(() => resolveRemotePath(session, '../secrets')).toThrow(
      'escapes the remote workspace',
    )
    expect(() => resolveRemotePath(session, '/etc/passwd')).toThrow(
      'escapes the remote workspace',
    )
  })
})

test('shellQuote preserves single quotes without interpolation', () => {
  expect(shellQuote("a'b $HOME")).toBe("'a'\"'\"'b $HOME'")
})

test('runs command and file operations through the SSH transport', async () => {
  const fixture = join(import.meta.dir, 'fixtures', 'fake-ssh.sh')
  const root = await mkdtemp(join(tmpdir(), 'opencc-ssh-remote-test-'))
  const previousBinary = process.env.OPENCC_SSH_REMOTE_BINARY
  process.env.OPENCC_SSH_REMOTE_BINARY = fixture
  try {
    const home = await connectSession('home', 'fake-host')
    expect(home.session.workspace.startsWith('/')).toBe(true)
    await closeSession('home')

    const { session } = await connectSession(
      'integration',
      `ssh://fake-host${root}`,
    )
    const command = await execRemote(session, 'printf remote-ok', '.', 5_000)
    expect(command.exitCode).toBe(0)
    expect(command.stdout).toBe('remote-ok')

    const write = await writeRemote(
      session,
      'src/example.txt',
      'hello from remote\n',
      'utf8',
      true,
    )
    expect(write.exitCode).toBe(0)
    expect(await readFile(join(root, 'src/example.txt'), 'utf8')).toBe(
      'hello from remote\n',
    )

    const read = await readRemote(session, 'src/example.txt', 1024)
    expect(read.exitCode).toBe(0)
    expect(read.stdout).toBe('hello from remote\n')
    await closeSession('integration')
  } finally {
    if (previousBinary === undefined)
      delete process.env.OPENCC_SSH_REMOTE_BINARY
    else process.env.OPENCC_SSH_REMOTE_BINARY = previousBinary
    await rm(root, { recursive: true, force: true })
  }
})

describe('SSH remote password authentication', () => {
  test('requires a 0600 password file', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'opencc-ssh-password-mode-'))
    const file = join(root, 'password')
    try {
      await writeFile(file, 'test-password\n', { mode: 0o600 })
      await chmod(file, 0o600)
      expect(await validatePasswordFile(file)).toBe(file)

      await chmod(file, 0o644)
      await expect(validatePasswordFile(file)).rejects.toThrow(
        'must not be accessible by group or others',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses SSH_ASKPASS instead of BatchMode when password_file is set', async () => {
    const fixture = join(
      import.meta.dir,
      'fixtures',
      'fake-ssh-password.sh',
    )
    const root = await mkdtemp(join(tmpdir(), 'opencc-ssh-password-test-'))
    const previousBinary = process.env.OPENCC_SSH_REMOTE_BINARY
    const previousRuntime = process.env.XDG_RUNTIME_DIR
    const previousTestPassword = process.env.OPENCC_TEST_PASSWORD
    process.env.OPENCC_SSH_REMOTE_BINARY = fixture
    process.env.XDG_RUNTIME_DIR = root
    process.env.OPENCC_TEST_PASSWORD = 'test-password'
    const passwordFile = join(root, 'password')
    try {
      await writeFile(passwordFile, 'test-password\n', { mode: 0o600 })
      await chmod(passwordFile, 0o600)

      const { session } = await connectSession('password', 'fake-host', undefined, {
        passwordFile,
      })
      expect(session.passwordFile).toBe(passwordFile)

      const command = await execRemote(session, 'printf password-ok', '.', 5_000)
      expect(command.exitCode).toBe(0)
      expect(command.stdout).toBe('password-ok')

      await closeSession('password')
    } finally {
      if (previousBinary === undefined)
        delete process.env.OPENCC_SSH_REMOTE_BINARY
      else process.env.OPENCC_SSH_REMOTE_BINARY = previousBinary
      if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = previousRuntime
      if (previousTestPassword === undefined)
        delete process.env.OPENCC_TEST_PASSWORD
      else process.env.OPENCC_TEST_PASSWORD = previousTestPassword
      await rm(root, { recursive: true, force: true })
    }
  })
})
