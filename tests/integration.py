#!/usr/bin/env python3
"""End-to-end API checks against a separate process and temporary database."""
import concurrent.futures
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
REPORT = {"passed": [], "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}

def check(condition, name):
    if not condition:
        raise AssertionError(name)
    REPORT["passed"].append(name)
    print("PASS", name, flush=True)

class Client:
    def __init__(self, base):
        self.base = base
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))
    def request(self, path, data=None, expect=200, headers=None):
        hdr = {"Content-Type": "application/json"} if data is not None else {}
        hdr.update(headers or {})
        req = urllib.request.Request(self.base + "/api" + path, headers=hdr,
                                     data=None if data is None else json.dumps(data).encode())
        try:
            with self.opener.open(req, timeout=15) as r:
                status, value = r.status, json.load(r)
        except urllib.error.HTTPError as e:
            status, value = e.code, json.load(e)
        if status != expect:
            raise AssertionError(f"{path}: expected {expect}, got {status}: {value}")
        return value
    def action(self, action, expect=200, **data):
        return self.request("/action", {"action": action, **data}, expect)
    def detail(self, decision):
        return self.request("/decisions/" + decision)
    def state(self, group):
        return self.request("/state?group_id=" + group)

def run(base, process):
    lead, member, member2, outsider = [Client(base) for _ in range(4)]
    Client(base).request("/state", expect=401)
    check(True, "未登录访问被拒绝")
    suffix = secrets.token_hex(5)
    password = secrets.token_urlsafe(16)
    accounts = []
    for i, client in enumerate([lead, member, member2, outsider]):
        email = f"test-{suffix}-{i}@example.test"
        client.request("/register", {"name": ["组织者","组员甲","组员乙","外部成员"][i],
                                    "email": email, "password": password})
        accounts.append(email)
    check(True, "四个独立账号注册与会话隔离")
    lead.request("/logout", {})
    lead.request("/login", {"email": accounts[0], "password": "wrong-password"}, expect=401)
    lead.request("/login", {"email": accounts[0], "password": password})
    check(True, "密码校验与重新登录")
    g = lead.action("create_group", name="集成测试空间", with_examples=False)
    group = g["id"]
    member.action("join_group", invite_code=g["invite_code"].lower())
    member2.action("join_group", invite_code=g["invite_code"])
    check(len(lead.state(group)["members"]) == 3, "邀请码入组与成员同步")
    outsider.request("/state?group_id=" + group, expect=403)
    lead.action("create_group", name="另一个独立空间", with_examples=False)
    check(True, "跨空间访问隔离")
    csrf = {"Origin": "https://untrusted.example"}
    lead.request("/action", {"action": "create_group", "name": "forbidden"}, expect=403, headers=csrf)
    check(True, "跨来源写入被拒绝")
    settings = lead.state(group)["group"]["settings"]
    settings["auto_folder_threshold"] = 1
    lead.action("settings", group_id=group, name="集成测试空间", settings=settings)
    member.action("create_folder", group_id=group, name="不可创建", expect=403)
    member.action("create_decision", group_id=group, title="不可创建", expect=403)
    d = lead.action("create_decision", group_id=group, title="多项合并验证",
                    description="验证真实讨论、重新选择和子决策。", deadline=int(time.time())+3600,
                    importance=3, tags=["研发"], multi_select=False, settings={"remind_minutes":120},
                    options=[{"title": f"方案 {i}", "details": f"详细依据 {i}"} for i in range(1,5)])["id"]
    original = member.detail(d)
    options = [o["id"] for o in original["options"]]
    outsider.request("/decisions/" + d, expect=403)
    outsider.action("vote", decision_id=d, option_ids=[options[0]], version=1, expect=403)
    check(True, "组织者操作与决策内容权限检查")
    member.action("comment", decision_id=d, option_id=None, body="问题下的讨论")
    member.action("comment", decision_id=d, option_id=options[0], body="原选项的重要依据")
    member.action("vote", decision_id=d, option_ids=options[:2], version=1, expect=400)
    member.action("vote", decision_id=d, option_ids=[options[0]], version=1)
    lead.action("vote", decision_id=d, option_ids=[options[1]], version=1)
    check(len(member.detail(d)["comments"]) == 2, "问题讨论与独立选项讨论")
    new_option = member.action("add_option", decision_id=d, title="组员补充", details="新的判断依据")["id"]
    updated = lead.detail(d)
    check(updated["version"] == 2 and updated["needs_review"], "新选项增加版本并标记旧选择")
    lead.action("vote", decision_id=d, option_ids=[new_option], version=1, expect=409)
    lead.action("vote", decision_id=d, option_ids=[new_option], version=2)
    check(True, "旧版本投票冲突保护与实时重新决策")
    reminder = lead.action("remind", decision_id=d, audience="stale")
    check(reminder["sent"] == 2, "按未提交最新版本筛选提醒对象")
    member.action("remind", decision_id=d, audience="all", expect=403)
    child1 = member.action("merge", decision_id=d, title="合并三个方案",
                           merged_title="综合方案", merged_details="保留三者的优点",
                           source_ids=options[:3], deadline=int(time.time())+1800)["id"]
    child2 = member2.action("merge", decision_id=d, title="重叠提案",
                            merged_title="另一个综合方案", merged_details="用于冲突验证",
                            source_ids=options[1:4], deadline=int(time.time())+1700)["id"]
    state = lead.state(group)
    auto = [f for f in state["folders"] if f["parent_id"]==d and f["automatic"]]
    check(len(auto)==1 and all(x["folder_id"]==auto[0]["id"] for x in state["decisions"] if x["parent_id"]==d),
          "同类子决策超过阈值自动归入文件夹")
    member.action("rename_decision", decision_id=child1, title="可重命名的合并")
    settings["allow_rename_subdecision"] = False
    settings["reminder_permission"] = "members"
    lead.action("settings", group_id=group, name="集成测试空间", settings=settings)
    member.action("rename_decision", decision_id=child1, title="不可重命名", expect=403)
    lead.action("rename_decision", decision_id=child1, title="组织者重命名")
    lead.action("remind", decision_id=child1, audience="all", expect=403)
    member.action("remind", decision_id=child1, audience="all")
    check(True, "子决策命名权限和组员提醒权限即时生效")
    for child in [child1,child2]:
        detail=lead.detail(child)
        yes=next(o["id"] for o in detail["options"] if o["title"]=="同意合并")
        lead.action("vote", decision_id=child, option_ids=[yes], version=1)
        member.action("vote", decision_id=child, option_ids=[yes], version=1)
    first = lead.action("close_decision", decision_id=child1)
    check(first["outcome"]=="passed", "三个选项通过子决策合并")
    merged = member.detail(d)
    archived = [o for o in merged["options"] if o["archived"]]
    combined = next(o for o in merged["options"] if o["title"]=="综合方案")
    check(len(archived)==3 and set(combined["source_ids"])==set(options[:3])
          and any(c["body"]=="原选项的重要依据" for c in merged["comments"]),
          "合并保留原选项、来源及讨论")
    check(merged["needs_review"] and merged["version"]==3, "合并后原选择需要重新确认")
    conflict=lead.action("close_decision", decision_id=child2)
    check(conflict["outcome"]=="conflict"
          and len([o for o in lead.detail(d)["options"] if o["title"]=="另一个综合方案"])==0,
          "重叠合并冲突不重复执行")
    folder=lead.action("create_folder", group_id=group, name="主决策归档")["id"]
    d2=lead.action("create_decision", group_id=group, title="多选验证", description="",
                   deadline=int(time.time())+3600, importance=1, tags=[], multi_select=True,
                   options=[{"title":"甲","details":""},{"title":"乙","details":""}])["id"]
    choices=[o["id"] for o in member.detail(d2)["options"]]
    member.action("vote", decision_id=d2, option_ids=choices, version=1)
    lead.action("move_decisions", group_id=group, decision_ids=[d,d2], folder_id=folder)
    state=lead.state(group)
    check(all(x["folder_id"]==folder for x in state["decisions"] if x["id"] in [d,d2]),
          "多选投票与多项内容批量移动")
    lead.action("move_decisions", group_id=group, decision_ids=[child1], folder_id=folder, expect=400)
    check(True, "文件夹层级约束")
    settings["allow_add_options"]=False
    settings["allow_merge"]=False
    lead.action("settings", group_id=group, name="集成测试空间", settings=settings)
    member.action("add_option", decision_id=d, title="不允许", details="", expect=403)
    member.action("merge", decision_id=d, source_ids=[new_option,combined["id"]],
                  merged_title="不允许", deadline=int(time.time())+120, expect=403)
    check(True, "组织者关闭补充与合并权限")
    # No approval on a tie: open merge before disabling members is unnecessary; organizer retains rights.
    tie=lead.action("merge", decision_id=d, source_ids=[new_option,combined["id"]],
                    title="同票验证", merged_title="不应执行", merged_details="",
                    deadline=int(time.time())+120)["id"]
    opts=lead.detail(tie)["options"]
    yes=next(o["id"] for o in opts if o["title"]=="同意合并")
    no=next(o["id"] for o in opts if o["title"]=="保留原选项")
    lead.action("vote", decision_id=tie, option_ids=[yes], version=1)
    member.action("vote", decision_id=tie, option_ids=[no], version=1)
    check(lead.action("close_decision", decision_id=tie)["outcome"]=="rejected", "同票不执行合并")
    # The next mutation must be observable on an already-open authenticated SSE stream.
    req=urllib.request.Request(base+"/api/events")
    stream=member.opener.open(req, timeout=10)
    lead.action("comment", decision_id=d, body="实时事件验证", option_id=None)
    line=stream.readline().decode()
    stream.close()
    check("data: refresh" in line, "真实 SSE 事件推送")
    ending=lead.action("create_decision", group_id=group, title="自动截止与提醒",
                       description="", deadline=int(time.time())+40, importance=2, tags=[],
                       settings={"remind_minutes":1,"reminder_audience":"unvoted"},
                       options=[{"title":"同意","details":""},{"title":"不同意","details":""}])["id"]
    stop=time.time()+65
    notified=False
    while time.time()<stop:
        state=member.state(group)
        current=next(x for x in state["decisions"] if x["id"]==ending)
        automatic=[n for n in state["notifications"] if n["decision_id"]==ending and n["kind"]=="scheduled"]
        if automatic:
            notified=True
            check(len(automatic)==1, "自动提醒按版本去重") if "自动提醒按版本去重" not in REPORT["passed"] else None
        if current["status"]=="closed":
            check(notified and current["outcome"]=="completed", "后台提醒与截止自动结算")
            break
        time.sleep(2)
    else:
        raise AssertionError("定时任务未在预期窗口内完成")
    member.action("vote", decision_id=ending, option_ids=[choices[0]], version=1, expect=400)
    check(True, "结束后禁止投票")
    lead.action("read_notifications")
    check(lead.state(group)["unread_count"]==0, "通知已读状态持久化")
    lead.action("close_decision", decision_id=d)
    member.action("comment", decision_id=d, body="结束后继续复盘", option_id=None)
    check(any(c["body"]=="结束后继续复盘" for c in member.detail(d)["comments"]), "结束后保留讨论能力")
    lead.request("/logout", {})
    lead.request("/state", expect=401)
    check(True, "退出登录撤销会话")

if __name__=="__main__":
    (ROOT/".tmp").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="integration-",dir=ROOT/".tmp") as temp:
        temp=Path(temp)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1",0))
            port=sock.getsockname()[1]
        base=f"http://127.0.0.1:{port}"
        env=os.environ.copy()
        env.update(DTRP_ROOT=str(ROOT),DTRP_BIND=f"127.0.0.1:{port}",DTRP_DATABASE=str(temp/"test.sqlite3"))
        with (temp/"server.log").open("w") as log:
            process=subprocess.Popen([str(ROOT/"target/release/group-decision")],cwd=ROOT,env=env,
                                     stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            for _ in range(80):
                if process.poll() is not None:
                    raise RuntimeError((temp/"server.log").read_text())
                try:
                    with urllib.request.urlopen(base+"/api/health",timeout=1) as r:
                        if r.status==200:
                            break
                except OSError:
                    time.sleep(.25)
            run(base,process)
            REPORT["ok"]=True
        except Exception as exc:
            REPORT["ok"]=False
            REPORT["error"]=str(exc)
            print("FAILED",exc,flush=True)
            print((temp/"server.log").read_text(),flush=True)
            raise
        finally:
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            REPORT["finished_at"]=time.strftime("%Y-%m-%dT%H:%M:%S%z")
            (ROOT/"tests/report.json").write_text(json.dumps(REPORT,ensure_ascii=False,indent=2))
    print(f"全部通过：{len(REPORT['passed'])} 项检查",flush=True)
