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

## Docker 本地部署（推荐）

需要已安装并启动 Docker，并提供 Docker Compose。Windows、macOS 可使用 Docker Desktop；Linux 可使用 Docker Engine 和 Compose 插件。不需要在宿主机安装 Rust、Node.js 或 Python。

```bash
git clone https://github.com/lll123github/GroupDecision.git
cd GroupDecision
docker compose up -d --build --wait
```

打开 `http://localhost:18760`。首次启动会从源码编译，耗时取决于网络和机器性能。注册账号、创建空间后，邀请其他账号加入即可测试。

```bash
docker compose ps
docker compose logs -f app
docker compose stop
docker compose start
```

### 端口与访问范围

默认仅绑定本机 `127.0.0.1:18760`。需要修改时，将 `.env.example` 复制为 `.env` 并编辑：

```dotenv
PORT=18760
BIND_ADDRESS=127.0.0.1
SECURE_COOKIE=0
```

改为 `BIND_ADDRESS=0.0.0.0` 后，同一网络中的其他设备可通过宿主机 IP 和端口访问，适合多个账号或手机参与测试。通过 HTTPS 反向代理运行时，把 `SECURE_COOKIE` 设为 `1`；本地直接 HTTP 保持为 `0`。修改后重新运行 `docker compose up -d --wait`。

### 数据持久化与更新

SQLite 数据库保存在 Docker 命名卷 `groupdecision_groupdecision-data` 中，挂载到容器 `/app/data`。停止、删除或重建容器会保留此卷。

```bash
# 下载更新并重建，保留账号、决策、讨论与通知
git pull --ff-only
docker compose up -d --build --wait

# 停止并移除容器，保留数据库卷
docker compose down
```

`docker compose down -v` 会删除数据卷并清空账号与决策，仅在明确希望重置本地测试环境时使用。

备份前先停止服务，保证复制的是一致的数据库文件。以下命令适用于 Bash，镜像中不需要额外安装备份工具：

```bash
mkdir -p backups
docker compose stop app
docker compose cp app:/app/data/decisions.sqlite3 ./backups/decisions.sqlite3
docker compose start app
```

请在 `docker compose down` 之前执行上述备份，因为 `compose cp` 需要已有的服务容器。备份的数据库包含账号与团队数据，请自行妥善保管。

### 构建网络

基础镜像默认使用 Docker 官方 Rust 与 Debian 镜像，Cargo 依赖默认使用 rsproxy。可在 `.env` 中覆盖 `RUST_IMAGE`、`RUNTIME_IMAGE` 和 `CARGO_REGISTRY_MIRROR`。将 `CARGO_REGISTRY_MIRROR=` 留空可使用 crates.io。镜像标签与平台需要支持当前机器架构。

容器使用非 root 用户运行前后端，带 HTTP 健康检查，接收 SIGINT 正常停止，并使用只读根文件系统。无需额外部署 Nginx、前端服务器或外部数据库。

### 本地协作测试

1. 在普通浏览器窗口注册账号 A，创建空间，并选择添加示例决策。
2. 在另一浏览器或无痕窗口注册账号 B，输入 A 分享的邀请码。两个普通标签页会共享登录状态，请使用独立浏览器会话。
3. A 发起决策，B 选择选项、发表讨论和补充选项；A 的页面应实时显示变化和重新确认提示。
4. 在决策详情点击“提议合并”，勾选两个或更多选项并提出合并子决策；成员投票后，由 A 提前结束表决，检查合并结果、原选项与来源讨论。
5. 测试自动提醒时，可把截止时间设在几分钟后，并设置截止前 1 分钟提醒。
6. 停止或重建容器后重新登录，确认账号、空间、选择和讨论仍在。

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

完成源码构建后，可运行：

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

容器镜像构建完成后，可选用宿主机 Python 3 运行容器冒烟测试：

```bash
docker compose build
python3 tests/container_smoke.py
```

该测试使用随机端口、独立 Compose 项目和独立数据卷，检查后删除测试容器与测试卷，不影响日常部署的数据。
