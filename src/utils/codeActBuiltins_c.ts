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
import { mkdir, writeFile, readFile, access } from 'fs/promises'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
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

function cppFunctionalHeader(): string {
  return `/* CodeAct builtin: functional control and data composition (C++23) */
#ifndef CODEACT_FUNCTIONAL_HPP
#define CODEACT_FUNCTIONAL_HPP

#include <algorithm>
#include <concepts>
#include <exception>
#include <expected>
#include <functional>
#include <iterator>
#include <ranges>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace codeact {

template<class T, class E = std::string>
using Result = std::expected<T, E>;

template<class T, class E, class F>
auto map_result(std::expected<T, E> result, F&& function)
    -> std::expected<std::invoke_result_t<F, T>, E> {
    using U = std::invoke_result_t<F, T>;
    if (!result) return std::unexpected(std::move(result.error()));
    if constexpr (std::is_void_v<U>) {
        std::invoke(std::forward<F>(function), std::move(*result));
        return {};
    } else {
        return std::expected<U, E>(std::invoke(std::forward<F>(function), std::move(*result)));
    }
}

template<class T, class E, class F>
auto bind_result(std::expected<T, E> result, F&& function)
    -> std::invoke_result_t<F, T> {
    using R = std::invoke_result_t<F, T>;
    if (!result) return R(std::unexpected(std::move(result.error())));
    return std::invoke(std::forward<F>(function), std::move(*result));
}

template<class F>
auto attempt(F&& function)
    -> std::expected<std::invoke_result_t<F>, std::string> {
    using T = std::invoke_result_t<F>;
    try {
        if constexpr (std::is_void_v<T>) {
            std::invoke(std::forward<F>(function));
            return {};
        } else {
            return std::expected<T, std::string>(std::invoke(std::forward<F>(function)));
        }
    } catch (const std::exception& error) {
        return std::unexpected(std::string(error.what()));
    } catch (...) {
        return std::unexpected(std::string("unknown exception"));
    }
}

template<class T>
auto pipe(T&& value) -> std::decay_t<T> {
    return std::forward<T>(value);
}

template<class T, class F, class... Fs>
auto pipe(T&& value, F&& function, Fs&&... rest) {
    return pipe(
        std::invoke(std::forward<F>(function), std::forward<T>(value)),
        std::forward<Fs>(rest)...
    );
}

template<std::ranges::input_range Range>
auto to_vector(Range&& range) {
    using Value = std::ranges::range_value_t<Range>;
    std::vector<Value> output;
    if constexpr (std::ranges::sized_range<Range>) {
        output.reserve(static_cast<std::size_t>(std::ranges::size(range)));
    }
    std::ranges::copy(range, std::back_inserter(output));
    return output;
}

template<std::ranges::input_range Range, class Accumulator, class F>
auto fold(Range&& range, Accumulator initial, F&& function) -> Accumulator {
    for (auto&& value : range) {
        initial = std::invoke(
            function,
            std::move(initial),
            std::forward<decltype(value)>(value)
        );
    }
    return initial;
}

template<class... Functions>
struct overloaded : Functions... {
    using Functions::operator()...;
};
template<class... Functions>
overloaded(Functions...) -> overloaded<Functions...>;

template<class F>
class scope_exit {
public:
    explicit scope_exit(F function)
        : function_(std::move(function)), active_(true) {}
    scope_exit(const scope_exit&) = delete;
    scope_exit& operator=(const scope_exit&) = delete;
    scope_exit(scope_exit&& other) noexcept(std::is_nothrow_move_constructible_v<F>)
        : function_(std::move(other.function_)), active_(std::exchange(other.active_, false)) {}
    ~scope_exit() noexcept(noexcept(std::declval<F&>()())) {
        if (active_) function_();
    }
    void release() noexcept { active_ = false; }

private:
    F function_;
    bool active_;
};

template<class F>
scope_exit(F) -> scope_exit<F>;

template<class T>
class Bounce {
public:
    using Next = std::function<Bounce<T>()>;

    static Bounce done(T value) { return Bounce(std::move(value)); }
    static Bounce call(Next next) { return Bounce(std::move(next)); }

    bool is_done() const noexcept { return std::holds_alternative<T>(state_); }
    T take_value() { return std::move(std::get<T>(state_)); }
    Bounce resume() { return std::get<Next>(state_)(); }

private:
    explicit Bounce(T value) : state_(std::move(value)) {}
    explicit Bounce(Next next) : state_(std::move(next)) {}
    std::variant<T, Next> state_;
};

template<class T>
T trampoline(Bounce<T> bounce) {
    while (!bounce.is_done()) bounce = bounce.resume();
    return bounce.take_value();
}

template<class F>
class fix_point {
public:
    explicit fix_point(F function) : function_(std::move(function)) {}

    template<class... Args>
    decltype(auto) operator()(Args&&... args) const {
        return function_(*this, std::forward<Args>(args)...);
    }

private:
    F function_;
};

template<class F>
auto fix(F&& function) {
    return fix_point<std::decay_t<F>>(std::forward<F>(function));
}

} // namespace codeact

#endif /* CODEACT_FUNCTIONAL_HPP */
`
}

function cMakefile(): string {
  return `# Auto-generated Makefile for CodeAct C/C++ sandbox
CC = gcc
CXX = g++
CFLAGS = -Wall -Wextra -O2 -I.
CXXFLAGS = -Wall -Wextra -Wpedantic -O2 -std=c++23 -I.
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
  'functional.hpp': cppFunctionalHeader(),
  'Makefile': cMakefile(),
}

// Rewrite the shared cache when generated headers or compiler defaults change.
const C_BUILTINS_VERSION = '2'

function versionPath(dir: string): string {
  return join(dir, '.version')
}

async function isFresh(dir: string): Promise<boolean> {
  try {
    if ((await readFile(versionPath(dir), 'utf-8')).trim() !== C_BUILTINS_VERSION) {
      return false
    }
  } catch {
    return false
  }
  for (const name of Object.keys(C_BUILTINS)) {
    try {
      await access(join(dir, name))
    } catch {
      return false
    }
  }
  return true
}

export async function ensureCodeActBuiltinsC(): Promise<string> {
  const dir = builtinsCDir()
  await mkdir(dir, { recursive: true })

  if (await isFresh(dir)) return dir

  await Promise.all(
    Object.entries(C_BUILTINS).map(([name, content]) =>
      writeFile(join(dir, name), content, 'utf-8'),
    ),
  )
  await writeFile(versionPath(dir), C_BUILTINS_VERSION, 'utf-8')
  return dir
}

export function ensureCodeActBuiltinsCSync(): string {
  const dir = builtinsCDir()
  mkdirSync(dir, { recursive: true })

  let stale = true
  try {
    stale = readFileSync(versionPath(dir), 'utf-8').trim() !== C_BUILTINS_VERSION
  } catch { /* missing version => stale */ }

  for (const [name, content] of Object.entries(C_BUILTINS)) {
    const p = join(dir, name)
    if (stale || !existsSync(p)) {
      writeFileSync(p, content, 'utf-8')
    }
  }
  if (stale) {
    writeFileSync(versionPath(dir), C_BUILTINS_VERSION, 'utf-8')
  }
  return dir
}
