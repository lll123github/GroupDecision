#!/usr/bin/env python3
"""Manage only this project's detached Rust server."""
import argparse
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
PID_FILE = ROOT / "data/server.pid"
BINARY = ROOT / "target/release/group-decision"

def running_pid():
    try:
        pid = int(PID_FILE.read_text().strip())
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        if str(BINARY).encode() not in cmd:
            return None
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None

def start():
    pid = running_pid()
    if pid:
        print(f"群策正在运行，PID={pid}")
        return
    if not BINARY.exists():
        raise SystemExit("请先运行 bash scripts/build.sh")
    (ROOT / "data").mkdir(exist_ok=True, mode=0o700)
    (ROOT / "logs").mkdir(exist_ok=True, mode=0o700)
    env = os.environ.copy()
    env["DTRP_ROOT"] = str(ROOT)
    env["TMPDIR"] = str(ROOT / ".tmp")
    env.setdefault("DTRP_BIND", "0.0.0.0:18760")
    with (ROOT / "logs/server.log").open("a") as log:
        proc = subprocess.Popen([str(BINARY)], cwd=ROOT, env=env, stdout=log,
                                stderr=subprocess.STDOUT, start_new_session=True)
    PID_FILE.write_text(str(proc.pid))
    check_host = env["DTRP_BIND"].rsplit(":", 1)[0]
    if check_host in ("0.0.0.0", "::"):
        check_host = "127.0.0.1"
    port = env["DTRP_BIND"].rsplit(":", 1)[1]
    for _ in range(60):
        if proc.poll() is not None:
            raise SystemExit("启动失败，请查看 logs/server.log")
        try:
            with urllib.request.urlopen(f"http://{check_host}:{port}/api/health", timeout=2) as r:
                data = json.load(r)
            if data["status"] == "ok":
                print(f"群策已启动，PID={proc.pid}，监听 {env['DTRP_BIND']}")
                return
        except OSError:
            time.sleep(0.3)
    raise SystemExit("服务启动超时，请查看 logs/server.log")

def stop():
    pid = running_pid()
    if not pid:
        print("群策当前没有运行")
        return
    os.kill(pid, signal.SIGINT)
    for _ in range(100):
        if not running_pid():
            PID_FILE.unlink(missing_ok=True)
            print("群策已停止")
            return
        time.sleep(0.1)
    raise SystemExit("服务仍在退出中，未强制终止；请检查日志")

def backup():
    dest = ROOT / "data/backups" / time.strftime("decisions-%Y%m%d-%H%M%S.sqlite3")
    dest.parent.mkdir(exist_ok=True, mode=0o700)
    with sqlite3.connect(ROOT / "data/decisions.sqlite3", timeout=15) as source:
        with sqlite3.connect(dest) as target:
            source.backup(target)
    os.chmod(dest, 0o600)
    print(f"备份已写入 {dest}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["start", "stop", "restart", "status", "backup"])
    arg = parser.parse_args().action
    if arg == "start":
        start()
    elif arg == "stop":
        stop()
    elif arg == "restart":
        stop()
        start()
    elif arg == "backup":
        backup()
    else:
        pid = running_pid()
        print(f"运行中，PID={pid}" if pid else "未运行")
