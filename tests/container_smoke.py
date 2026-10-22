#!/usr/bin/env python3
"""Verify the shipped Compose configuration using an isolated project and data volume."""
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

from integration import Client

ROOT = Path(__file__).resolve().parent.parent
REPORT = {"passed": []}

def check(ok, message):
    if not ok:
        raise AssertionError(message)
    REPORT["passed"].append(message)
    print("PASS", message, flush=True)

def main():
    project = "groupdecision-smoke-" + secrets.token_hex(5)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = os.environ.copy()
    env.update(PORT=str(port), BIND_ADDRESS="127.0.0.1", SECURE_COOKIE="0")
    command = ["docker", "compose", "-f", str(ROOT / "compose.yaml"), "-p", project]
    def compose(*args, timeout=120):
        result = subprocess.run(command + list(args), cwd=ROOT, env=env,
                                capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result.stdout.strip()
    def client():
        c = Client(f"http://127.0.0.1:{port}")
        c.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                              urllib.request.HTTPCookieProcessor(c.cookies))
        return c
    (ROOT / ".tmp").mkdir(exist_ok=True)
    try:
        compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "90")
        container = compose("ps", "-q", "app")
        result = subprocess.run(["docker", "inspect", container], capture_output=True, text=True, check=True)
        info = json.loads(result.stdout)[0]
        check(info["State"]["Health"]["Status"] == "healthy", "Compose 启动与容器 HTTP 健康检查")
        check(info["Config"]["User"] == "10001:10001"
              and compose("exec", "-T", "app", "id", "-u") == "10001",
              "容器使用非 root 用户")
        check(info["HostConfig"]["ReadonlyRootfs"]
              and info["Config"]["StopSignal"] == "SIGINT",
              "只读根文件系统与正常停止信号")
        organizer, member = client(), client()
        suffix = secrets.token_hex(6)
        password = secrets.token_urlsafe(24)
        organizer.request("/register", {"name": "容器组织者", "email": f"docker-{suffix}@example.test",
                                        "password": password})
        member.request("/register", {"name": "容器组员", "email": f"member-{suffix}@example.test",
                                     "password": password})
        group = organizer.action("create_group", name="容器测试空间", with_examples=False)
        member.action("join_group", invite_code=group["invite_code"])
        decision = organizer.action("create_decision", group_id=group["id"],
                                     title="容器多项合并验证", description="验证容器内的真实数据写入。",
                                     deadline=int(time.time()) + 3600, importance=3, tags=["测试"],
                                     options=[{"title": f"方案 {i}", "details": f"依据 {i}"} for i in range(3)])["id"]
        options = member.detail(decision)["options"]
        ids = [option["id"] for option in options]
        member.action("vote", decision_id=decision, option_ids=[ids[0]], version=1)
        member.action("comment", decision_id=decision, option_id=ids[0], body="需要保留的来源讨论")
        member.action("comment", decision_id=decision, option_id=None, body="容器中的问题讨论")
        member.action("add_option", decision_id=decision, title="补充方案", details="实时更新验证")
        check(member.detail(decision)["needs_review"], "容器内账号、讨论与新选项版本更新")
        child = member.action("merge", decision_id=decision, title="容器合并子决策",
                               source_ids=ids, merged_title="综合方案", merged_details="合并三个来源。",
                               deadline=int(time.time()) + 1800)["id"]
        yes = next(o["id"] for o in organizer.detail(child)["options"] if o["title"] == "同意合并")
        organizer.action("vote", decision_id=child, option_ids=[yes], version=1)
        result = organizer.action("close_decision", decision_id=child)
        detail = member.detail(decision)
        merged = next(o for o in detail["options"] if o["title"] == "综合方案")
        check(result["outcome"] == "passed" and set(merged["source_ids"]) == set(ids)
              and len([o for o in detail["options"] if o["archived"]]) == 3,
              "容器内三项合并与来源保留")
        member.action("vote", decision_id=decision, option_ids=[merged["id"]], version=detail["version"])
        # Keep an SSE connection open while stopping: this catches hung container shutdowns.
        stream = member.opener.open(member.base + "/api/events", timeout=15)
        start = time.monotonic()
        compose("stop", "-t", "10", "app", timeout=25)
        duration = time.monotonic() - start
        result = subprocess.run(["docker", "inspect", "--format", "{{.State.ExitCode}}", container],
                                capture_output=True, text=True, check=True)
        check(result.stdout.strip() == "0" and duration < 10 and stream.readline() == b"",
              "有 SSE 连接时 Docker stop 正常退出")
        stream.close()
        with tempfile.TemporaryDirectory(prefix="container-backup-", dir=ROOT / ".tmp") as temp:
            backup = Path(temp) / "decisions.sqlite3"
            compose("cp", "app:/app/data/decisions.sqlite3", str(backup))
            with sqlite3.connect(f"file:{backup}?mode=ro", uri=True) as db:
                check(db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
                      and db.execute("SELECT count(*) FROM users").fetchone()[0] == 2,
                      "停止后的数据库备份可读取且完整")
        compose("up", "-d", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "90")
        detail = member.detail(decision)
        state = organizer.state(group["id"])
        check(len(state["members"]) == 2 and detail["my_vote"] is not None
              and any(c["body"] == "需要保留的来源讨论" for c in detail["comments"]),
              "容器重建后账号会话、选择与讨论持久化")
        check(any(o["title"] == "综合方案" for o in detail["options"])
              and detail["version"] == 3, "命名卷保留合并结果与版本")
        REPORT["ok"] = True
    except Exception:
        try:
            logs=compose("logs", "--no-color", "--tail", "40", "app")
            REPORT["container_logs"]=logs
            print(logs,flush=True)
        except Exception:
            pass
        raise
    finally:
        result = subprocess.run(command + ["down", "--volumes", "--remove-orphans"],
                                cwd=ROOT, env=env, capture_output=True, text=True, timeout=45)
        if result.returncode:
            print("容器测试清理失败：", result.stdout, result.stderr, flush=True)
        REPORT["project"] = project

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        REPORT["ok"] = False
        REPORT["error"] = str(error)
        raise
    finally:
        (ROOT / "tests/container-report.json").write_text(
            json.dumps(REPORT, ensure_ascii=False, indent=2))
    print(f"容器检查全部通过：{len(REPORT['passed'])} 项", flush=True)
