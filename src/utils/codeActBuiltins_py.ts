/**
 * Python builtins generator for CodeAct sandbox.
 *
 * Bootstraps Python utility modules to ~/.claude/codeact/builtins_py/
 * so agent code can do:
 *
 *   from builtins_py.fs import read_file, write_file, mkdir, rm, exists
 *   from builtins_py.shell import exec, sh
 *   from builtins_py.fetch import fetch, fetch_json
 *   from builtins_py import path, os_info
 */

import { join } from 'path'
import { mkdir, writeFile, access } from 'fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { getCodeActBaseDir } from './codeActBuiltins.js'

function builtinsPyDir(): string {
  return join(getCodeActBaseDir(), 'builtins_py')
}

// ── Python builtin generators ──────────────────────────────────────

function pyInit(): string {
  return `# CodeAct Python builtins
from builtins_py import fs, shell, fetch
from builtins_py.path import *
from builtins_py.os_info import *
`
}

function pyFs(): string {
  return `# CodeAct builtin: filesystem utilities (Python)
import os
import shutil
from pathlib import Path
from typing import Optional


def read_file(path: str) -> str:
    """Read a file and return its contents as a string."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        raise IOError(f"read_file('{path}'): {e}")


def read_file_binary(path: str) -> bytes:
    """Read a file and return its contents as bytes."""
    try:
        with open(path, 'rb') as f:
            return f.read()
    except Exception as e:
        raise IOError(f"read_file_binary('{path}'): {e}")


def write_file(path: str, content: str) -> None:
    """Write string content to a file (overwrites if exists)."""
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
    except Exception as e:
        raise IOError(f"write_file('{path}'): {e}")


def mkdir_p(path: str, recursive: bool = True) -> None:
    """Create a directory. Alias: mkdir."""
    try:
        Path(path).mkdir(parents=recursive, exist_ok=True)
    except Exception as e:
        raise IOError(f"mkdir('{path}'): {e}")

# Alias
mkdir = mkdir_p


def rm(path: str, recursive: bool = True) -> None:
    """Remove a file or directory."""
    try:
        p = Path(path)
        if not p.exists():
            return
        if p.is_dir():
            shutil.rmtree(path)
        else:
            p.unlink()
    except Exception as e:
        raise IOError(f"rm('{path}'): {e}")


def exists(path: str) -> bool:
    """Check if a path exists."""
    return os.path.exists(path)


def readdir(path: str) -> list:
    """List directory contents."""
    try:
        return os.listdir(path)
    except Exception as e:
        raise IOError(f"readdir('{path}'): {e}")


def copy_file(src: str, dest: str) -> None:
    """Copy a file from src to dest."""
    try:
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
    except Exception as e:
        raise IOError(f"copy_file('{src}' -> '{dest}'): {e}")


def append_file(path: str, content: str) -> None:
    """Append string content to a file."""
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'a', encoding='utf-8') as f:
            f.write(content)
    except Exception as e:
        raise IOError(f"append_file('{path}'): {e}")


def stat(path: str) -> dict:
    """Get file/directory metadata."""
    try:
        s = os.stat(path)
        return {
            'size': s.st_size,
            'is_file': os.path.isfile(path),
            'is_directory': os.path.isdir(path),
            'mtime': s.st_mtime,
        }
    except Exception as e:
        raise IOError(f"stat('{path}'): {e}")
`
}

function pyShell(): string {
  return `# CodeAct builtin: shell command execution (Python)
import subprocess
import os
from typing import Optional


def exec(cmd: str, cwd: Optional[str] = None, timeout: Optional[int] = None,
         env: Optional[dict] = None) -> dict:
    """Execute a shell command and return {stdout, stderr, exitCode}."""
    try:
        merged_env = {**os.environ, **(env or {})}
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            cwd=cwd or os.environ.get('CODEACT_WORKSPACE', os.getcwd()),
            timeout=timeout,
            env=merged_env,
        )
        return {
            'stdout': result.stdout.strip(),
            'stderr': result.stderr.strip(),
            'exitCode': result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {'stdout': '', 'stderr': f'Command timed out: {cmd}', 'exitCode': -1}
    except Exception as e:
        return {'stdout': '', 'stderr': str(e), 'exitCode': -1}


def sh(cmd: str, cwd: Optional[str] = None, timeout: Optional[int] = None,
       env: Optional[dict] = None) -> str:
    """Execute a shell command and return stdout. Throws on failure."""
    r = exec(cmd, cwd=cwd, timeout=timeout, env=env)
    if r['exitCode'] != 0:
        raise RuntimeError(f"Command failed (exit {r['exitCode']}): {cmd}\\n{r['stderr']}")
    return r['stdout']
`
}

function pyFetch(): string {
  return `# CodeAct builtin: network requests (Python)
import json as _json
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from typing import Optional


def fetch(url: str, method: str = 'GET', headers: Optional[dict] = None,
          body: Optional[str] = None, timeout: Optional[int] = 30) -> dict:
    """Make an HTTP request and return {status, headers, text}."""
    try:
        req = Request(url, method=method)
        if headers:
            for k, v in headers.items():
                req.add_header(k, v)
        if body is not None:
            req.data = body.encode('utf-8')
        with urlopen(req, timeout=timeout) as resp:
            return {
                'status': resp.status,
                'headers': dict(resp.headers),
                'text': resp.read().decode('utf-8'),
            }
    except HTTPError as e:
        return {'status': e.code, 'headers': dict(e.headers), 'text': e.read().decode('utf-8', errors='replace')}
    except URLError as e:
        raise IOError(f"fetch('{url}'): {e.reason}")
    except Exception as e:
        raise IOError(f"fetch('{url}'): {e}")


def fetch_json(url: str, method: str = 'GET', headers: Optional[dict] = None,
               body: Optional[object] = None, timeout: Optional[int] = 30):
    """Make an HTTP request and parse the response as JSON."""
    body_str = _json.dumps(body) if body is not None else None
    if headers is None:
        headers = {}
    headers.setdefault('Content-Type', 'application/json')
    r = fetch(url, method=method, headers=headers, body=body_str, timeout=timeout)
    if r['status'] < 200 or r['status'] >= 300:
        raise IOError(f"fetch_json('{url}'): HTTP {r['status']}\\n{r['text'][:1000]}")
    return _json.loads(r['text'])
`
}

function pyPath(): string {
  return `# CodeAct builtin: path manipulation (Python)
import os.path as _os_path
from pathlib import Path as _Path

# os.path functions
join = _os_path.join
dirname = _os_path.dirname
basename = _os_path.basename
splitext = _os_path.splitext
abspath = _os_path.abspath
relpath = _os_path.relpath
normpath = _os_path.normpath
isabs = _os_path.isabs
sep = _os_path.sep

def Path(*args) -> _Path:
    """Create a Path object for object-oriented path manipulation."""
    return _Path(join(*args))
`
}

function pyOsInfo(): string {
  return `# CodeAct builtin: OS / environment info (Python)
import os as _os
import platform as _platform

# OS info
homedir = _os.path.expanduser('~')
tmpdir = _os.environ.get('TMPDIR', '/tmp')
def platform_name() -> str:
    """Return the OS platform name (linux, darwin, windows)."""
    return _platform.system().lower()
arch = _platform.machine()
cwd = _os.getcwd
chdir = _os.chdir

# Environment
env = dict(_os.environ)

# System info
def cpus():
    return _os.cpu_count()

def hostname():
    return _platform.node()
`
}

// ── Bootstrap ──────────────────────────────────────────────────────

const PY_BUILTINS: Record<string, string> = {
  '__init__.py': pyInit(),
  'fs.py': pyFs(),
  'shell.py': pyShell(),
  'fetch.py': pyFetch(),
  'path.py': pyPath(),
  'os_info.py': pyOsInfo(),
}

async function isFresh(dir: string): Promise<boolean> {
  for (const name of Object.keys(PY_BUILTINS)) {
    try {
      await access(join(dir, name))
    } catch {
      return false
    }
  }
  return true
}

export async function ensureCodeActBuiltinsPython(): Promise<string> {
  const dir = builtinsPyDir()
  await mkdir(dir, { recursive: true })

  if (await isFresh(dir)) return dir

  await Promise.all(
    Object.entries(PY_BUILTINS).map(([name, content]) =>
      writeFile(join(dir, name), content, 'utf-8'),
    ),
  )
  return dir
}

export function ensureCodeActBuiltinsPythonSync(): string {
  const dir = builtinsPyDir()
  mkdirSync(dir, { recursive: true })

  for (const [name, content] of Object.entries(PY_BUILTINS)) {
    const p = join(dir, name)
    if (!existsSync(p)) {
      writeFileSync(p, content, 'utf-8')
    }
  }
  return dir
}
