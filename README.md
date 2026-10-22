# 群策 · GroupDecision

一个多人协作的群体决策网页应用。组织者创建空间、发起问题并设定规则；组员通过各自的浏览器讨论、补充选项、投票与提出合并。

后端为 Rust / Axum，前端为原生 HTML、CSS、JavaScript，数据保存在 SQLite 中。前后端由同一个服务提供，无需单独运行前端开发服务器。

## 功能

- 今日决策、等待我参与、全部决策、子决策和已结束列表。
- 默认按截止时间紧迫性排序，也可按重要性、组织者定义的标签顺序排序。
- 问题讨论、各选项的详情和独立评论。
- 单选或多选；截止前可以修改自己的选择。
- 默认允许组员增加选项；选项版本更新后，旧选择标记为需要重新确认。
- 同时选择两个或更多选项提出合并，自动建立独立的合并子决策。
- 合并表决结束时，同意票严格多于保留票、且至少有一票同意，才执行合并。同票、无人投票或源选项冲突时保留原选项。
- 合并保留原选项、来源与讨论记录，并提醒成员重新确认。
- 组织者控制成员补充选项、提出合并、重命名子决策和手动提醒的权限。
- 按全体、尚未参与、未提交最新版本选择等条件发送提醒；支持子决策发起时和截止前提醒。
- 同一母决策下，同类型子决策超过阈值时自动创建文件夹；也可手动建文件夹并批量移动同层级决策。
- 站内通知、SSE 实时同步、断线重连及轮询兜底。
- 独立账号、邀请码入组、空间权限隔离及响应式桌面和手机界面。

## 从源码运行

以下方式适用于 Linux。需要 Python 3、Node.js，以及 Rust 工具链。Node.js 仅用于前端语法检查，正式服务运行不依赖 Node.js。

```bash
git clone https://github.com/lll123github/GroupDecision.git
cd GroupDecision
bash scripts/install-rust.sh
bash scripts/build.sh
python3 scripts/manage.py start
```

打开 `http://localhost:18760`。注册账号后创建空间，再把邀请码分享给其他成员。没有预设管理员账号或默认密码。

安装脚本将 Rust 工具链放在项目内的 `.toolchain/`，不修改系统 PATH 或 shell 配置。Cargo 使用锁文件和项目内镜像配置。源码构建并发限制为两个任务。

```bash
python3 scripts/manage.py status
python3 scripts/manage.py backup
python3 scripts/manage.py restart
python3 scripts/manage.py stop
```

## 配置和数据

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| DTRP_ROOT | 当前目录 | 应用根目录，manage.py 自动设置 |
| DTRP_BIND | 0.0.0.0:18760 | HTTP 监听地址 |
| DTRP_DATABASE | data/decisions.sqlite3 | SQLite 数据库文件 |
| DTRP_SECURE_COOKIE | 0 | HTTPS 部署时设为 1 |

环境变量名称保留早期接口兼容；本项目为独立软件，不依赖其他项目。

源码运行的数据位于 `data/decisions.sqlite3`，日志位于 `logs/server.log`，备份位于 `data/backups/`。这些文件以及本地工具链、缓存和测试截图均不加入 Git。

SQLite 采用 DELETE journal、FULL 同步和数据库进程锁。同一数据库只运行一个服务实例；多实例部署应先迁移到服务型数据库。

## 验证

```bash
python3 tests/integration.py
node --check static/app.js
```

集成测试使用独立进程、临时数据库和随机端口，不写入正式空间数据。已完成 28 项接口检查与 11 项桌面、手机浏览器检查，覆盖权限、讨论、新选项、旧版本冲突、多项合并、合并冲突、提醒、文件夹和截止结算。

浏览器测试源码位于 `tests/browser.cjs`，需要额外准备 Playwright 与 Chromium；不属于正式服务的运行依赖。

## 当前边界

- 当前仅网页端，无原生手机应用。
- 通知为站内通知；没有邮件、短信或 Web Push。关闭网页后，通知仍保存在服务器，重新进入网页可查看。
- 直接 HTTP 适合本地测试和受控内网。公网部署请使用 HTTPS，并设置 Secure Cookie。
- 暂不包含密码重置、组织者转让、附件上传与第三方账号登录。
