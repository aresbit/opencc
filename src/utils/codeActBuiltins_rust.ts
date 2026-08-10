/** CodeAct Rust helper module generator. */

import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { getCodeActBaseDir } from './codeActBuiltins.js'

const VERSION = '1'

function source(): string {
  return `use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

pub fn workspace() -> PathBuf {
    std::env::var_os("CODEACT_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().expect("current directory"))
}

pub fn read_file(path: impl AsRef<Path>) -> io::Result<String> {
    fs::read_to_string(path)
}

pub fn write_file(path: impl AsRef<Path>, content: &str) -> io::Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)
}

/// Execute a program with an argv vector. No shell parsing or eval occurs.
pub fn run(program: &str, args: &[&str]) -> io::Result<Output> {
    Command::new(program).args(args).current_dir(workspace()).output()
}

pub fn stdout_utf8(output: &Output) -> io::Result<String> {
    String::from_utf8(output.stdout.clone())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}
`
}

export function ensureCodeActBuiltinsRustSync(): string {
  const dir = join(getCodeActBaseDir(), 'builtins_rs')
  mkdirSync(dir, { recursive: true })
  const versionPath = join(dir, '.version')
  const stale = !existsSync(join(dir, 'codeact.rs')) ||
    !existsSync(versionPath) ||
    readFileSync(versionPath, 'utf-8').trim() !== VERSION
  if (stale) {
    writeFileSync(join(dir, 'codeact.rs'), source(), 'utf-8')
    writeFileSync(versionPath, VERSION, 'utf-8')
  }
  return dir
}
