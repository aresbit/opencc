/**
 * C/C++ builtins generator for CodeAct sandbox.
 *
 * Bootstraps header files to ~/.claude/codeact/builtins_c/
 * Agent C/C++ code can use: #include "builtins_c/fs.h"
 *
 * C/C++ execution is two-phase: compile (gcc/g++) then run binary.
 * See codeActCompile.ts for the compilation logic.
 */

import { join } from 'path'
import { mkdir, writeFile, access } from 'fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { getCodeActBaseDir } from './codeActBuiltins.js'

function builtinsCDir(): string {
  return join(getCodeActBaseDir(), 'builtins_c')
}

// ── C header generators ────────────────────────────────────────────

function cFsHeader(): string {
  return `/* CodeAct builtin: filesystem utilities (C) */
#ifndef CODEACT_FS_H
#define CODEACT_FS_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <libgen.h>

/* Read entire file into a malloc'd string. Caller must free(). */
static char* read_file(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) {
        fprintf(stderr, "read_file('%s'): %s\\n", path, strerror(errno));
        return NULL;
    }
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc(size + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t n = fread(buf, 1, size, f);
    buf[n] = '\\0';
    fclose(f);
    return buf;
}

/* Write string content to a file. Returns 0 on success, -1 on error. */
static int write_file(const char *path, const char *content) {
    FILE *f = fopen(path, "w");
    if (!f) {
        fprintf(stderr, "write_file('%s'): %s\\n", path, strerror(errno));
        return -1;
    }
    fprintf(f, "%s", content);
    fclose(f);
    return 0;
}

/* Check if a path exists. Returns 1 if exists, 0 otherwise. */
static int file_exists(const char *path) {
    struct stat st;
    return stat(path, &st) == 0 ? 1 : 0;
}

/* Get file size. Returns -1 on error. */
static long file_size(const char *path) {
    struct stat st;
    if (stat(path, &st) != 0) return -1;
    return st.st_size;
}

/* Create directory recursively */
static int mkdir_p(const char *path) {
    char tmp[4096];
    snprintf(tmp, sizeof(tmp), "%s", path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\\0';
            mkdir(tmp, 0755);
            *p = '/';
        }
    }
    return mkdir(tmp, 0755);
}

#endif /* CODEACT_FS_H */
`
}

function cShellHeader(): string {
  return `/* CodeAct builtin: shell execution (C) */
#ifndef CODEACT_SHELL_H
#define CODEACT_SHELL_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Execute a shell command and capture output.
   Returns a malloc'd string (stdout + stderr combined).
   Caller must free().
   Exit code is stored in *exit_code if not NULL. */
static char* shell_exec(const char *cmd, int *exit_code) {
    char buffer[4096];
    char *result = NULL;
    size_t result_size = 0;

    FILE *fp = popen(cmd, "r");
    if (!fp) {
        fprintf(stderr, "shell_exec(): failed to run command\\n");
        if (exit_code) *exit_code = -1;
        return NULL;
    }

    while (fgets(buffer, sizeof(buffer), fp) != NULL) {
        size_t len = strlen(buffer);
        char *new_result = realloc(result, result_size + len + 1);
        if (!new_result) {
            free(result);
            pclose(fp);
            if (exit_code) *exit_code = -1;
            return NULL;
        }
        result = new_result;
        memcpy(result + result_size, buffer, len + 1);
        result_size += len;
    }

    int rc = pclose(fp);
    if (exit_code) *exit_code = WEXITSTATUS(rc);

    return result;
}

#endif /* CODEACT_SHELL_H */
`
}

function cMakefile(): string {
  return `# Auto-generated Makefile for CodeAct C/C++ sandbox
CC = gcc
CXX = g++
CFLAGS = -Wall -Wextra -O2 -I.
CXXFLAGS = -Wall -Wextra -O2 -I.
LDFLAGS =

.PHONY: all clean

all: agent

agent: agent.c
\t$(CC) $(CFLAGS) -o agent agent.c $(LDFLAGS)

agent_cpp: agent.cpp
\t$(CXX) $(CXXFLAGS) -o agent agent.cpp $(LDFLAGS)

clean:
\trm -f agent
`
}

// ── Bootstrap ──────────────────────────────────────────────────────

const C_BUILTINS: Record<string, string> = {
  'fs.h': cFsHeader(),
  'shell.h': cShellHeader(),
  'Makefile': cMakefile(),
}

export async function ensureCodeActBuiltinsC(): Promise<string> {
  const dir = builtinsCDir()
  await mkdir(dir, { recursive: true })

  for (const [name, content] of Object.entries(C_BUILTINS)) {
    try {
      await access(join(dir, name))
    } catch {
      await writeFile(join(dir, name), content, 'utf-8')
    }
  }
  return dir
}

export function ensureCodeActBuiltinsCSync(): string {
  const dir = builtinsCDir()
  mkdirSync(dir, { recursive: true })

  for (const [name, content] of Object.entries(C_BUILTINS)) {
    const p = join(dir, name)
    if (!existsSync(p)) {
      writeFileSync(p, content, 'utf-8')
    }
  }
  return dir
}
