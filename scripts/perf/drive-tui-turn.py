#!/usr/bin/env python3
"""Drive the real TUI through one turn over a pty, sampling CPU and RSS.

The REPL event loop can only be measured with a live terminal: `--print` skips
Ink entirely, which is exactly how the 2026-09-07 actor-inbox spin was
localized (same prompt, 1.56s CPU headless versus 50s in the TUI). A pty gives
the TUI a real terminal without needing tmux.

Samples /proc/<pid>/stat once a second, stops after the turn goes quiet, then
exits cleanly so `--cpu-prof` flushes its profile.

    OPENCC_CLI=dist/cli.js PROF_NAME=run1 python3 scripts/perf/drive-tui-turn.py

Needs working credentials in the environment; it makes one real model call.
"""
import fcntl, os, pty, re, select, signal, struct, subprocess, sys, termios, time

ROWS, COLS = 22, 74
PROMPT = "依次运行 echo hello、date、uname -r 三条命令，然后一句话总结。"
CLI = os.environ.get("OPENCC_CLI", "/home/pc/.local/share/opencc/cli.js")

drop = {
    "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
}
env = {k: v for k, v in os.environ.items() if k not in drop}
env["TERM"] = "xterm-256color"

cmd = [
    "bun", "--cpu-prof", "--cpu-prof-md",
    os.environ.get("PROF_DIR", "--cpu-prof-dir=/tmp/prof"), "--cpu-prof-name=" + os.environ.get("PROF_NAME","tui") + "",
    CLI, "--dangerously-skip-permissions",
]

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave,
                        cwd=os.environ.get("OPENCC_TURN_CWD", "/tmp"), env=env, close_fds=True)
os.close(slave)
os.set_blocking(master, False)

buf = bytearray()


def pump(seconds: float) -> None:
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.2)
        if r:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            if not chunk:
                return
            buf.extend(chunk)


def cpu_rss():
    try:
        with open(f"/proc/{proc.pid}/stat") as f:
            parts = f.read().split()
        ticks = int(parts[13]) + int(parts[14])
        with open(f"/proc/{proc.pid}/status") as f:
            rss = next(int(l.split()[1]) // 1024 for l in f if l.startswith("VmRSS"))
        return ticks, rss
    except (OSError, StopIteration, ValueError):
        return None, None


print("等待 TUI 就绪...", flush=True)
pump(14)

print(f"发送提示词: {PROMPT}", flush=True)
os.write(master, PROMPT.encode())
time.sleep(1.0)
os.write(master, b"\r")

print("\n秒 | CPU% | RSS_MB | 备注", flush=True)
prev, _ = cpu_rss()
idle_run = 0
for i in range(1, 91):
    pump(1.0)
    cur, rss = cpu_rss()
    if cur is None:
        print("进程已退出")
        break
    d = cur - prev
    prev = cur
    bar = "#" * (d // 4)
    print(f"{i:2d} | {d:4d} | {rss:6d} | {bar}", flush=True)
    idle_run = idle_run + 1 if d < 8 else 0
    if idle_run >= 6 and i > 12:
        print("连续 6 秒低 CPU，判定回合结束", flush=True)
        break

print("\n退出以落盘 profile...", flush=True)
os.write(master, b"/exit\r")
pump(4)
if proc.poll() is None:
    os.write(master, b"\x03")
    pump(2)
if proc.poll() is None:
    os.write(master, b"\x04")
    pump(3)
if proc.poll() is None:
    proc.send_signal(signal.SIGINT)
    pump(3)
try:
    proc.wait(timeout=15)
except subprocess.TimeoutExpired:
    proc.terminate()
    proc.wait(timeout=10)

text = buf.decode("utf-8", "replace")
clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\r", "", text)
tail = [l for l in clean.splitlines() if l.strip()][-12:]
print("\n=== 屏幕尾部 ===")
print("\n".join(tail))
print(f"\n退出码: {proc.returncode}")
