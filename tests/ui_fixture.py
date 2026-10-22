#!/usr/bin/env python3
"""Create an isolated browser QA fixture; password comes from stdin, never a file."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import urllib.request
from integration import Client

ROOT=Path(__file__).resolve().parent.parent
config=json.loads(sys.stdin.readline())
password=config["password"]
db=ROOT/".tmp"/("ui-qa-"+secrets.token_hex(6)+".sqlite3")
with socket.socket() as sock:
    sock.bind(("0.0.0.0",0))
    port=sock.getsockname()[1]
env=os.environ.copy()
env.update(DTRP_ROOT=str(ROOT),DTRP_BIND=f"0.0.0.0:{port}",DTRP_DATABASE=str(db),TMPDIR=str(ROOT/".tmp"))
with (ROOT/"logs/ui-qa.log").open("w") as log:
    process=subprocess.Popen([str(ROOT/"target/release/group-decision")],cwd=ROOT,env=env,
                             stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
base=f"http://127.0.0.1:{port}"
for _ in range(80):
    if process.poll() is not None:
        raise RuntimeError((ROOT/"logs/ui-qa.log").read_text())
    try:
        with urllib.request.urlopen(base+"/api/health",timeout=1) as r:
            if r.status==200:break
    except OSError:
        time.sleep(.25)
lead=Client(base)
lead.request("/register",{"name":"林知","email":"ui-organizer@example.test","password":password})
group=lead.action("create_group",name="灵感共创小组",with_examples=True)
member=Client(base)
member.request("/register",{"name":"陈悦","email":"ui-member@example.test","password":password})
member.action("join_group",invite_code=group["invite_code"])
state=lead.state(group["id"])
d=next(x for x in state["decisions"] if "新版本" in x["title"])
detail=member.detail(d["id"])
member.action("vote",decision_id=d["id"],version=1,option_ids=[detail["options"][0]["id"]])
member.action("comment",decision_id=d["id"],option_id=None,body="建议优先考虑新成员的体验，首次参与的门槛越低，越容易听到更多人的声音。")
member.action("comment",decision_id=d["id"],option_id=detail["options"][0]["id"],body="可以先从三个关键步骤入手，减少首次使用时的困惑。")
folder=lead.action("create_folder",group_id=group["id"],name="团队日常")
other=next(x for x in state["decisions"] if "共创日" in x["title"])
lead.action("move_decisions",group_id=group["id"],decision_ids=[other["id"]],folder_id=folder["id"])
print("QA_RESULT "+json.dumps({"pid":process.pid,"port":port,"database":str(db),
      "email":"ui-organizer@example.test","group_id":group["id"],"decision_id":d["id"]},ensure_ascii=False),flush=True)
