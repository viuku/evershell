# 同步服务

> **管什么**：云同步服务端 `services/sync` 怎么部署（Cloudflare、自建 Docker）、怎么配置、怎么备份恢复、接口版本怎么演进、额度够不够。客户端的合并规则和加密方案在 [docs/specs/sync.md](../specs/sync.md)。
> **什么时候更新**：改了部署步骤、配置项、表结构、接口版本，或者 Cloudflare 的额度变了。
> **上次复核**：2026-10-28

## 是什么

一套 TypeScript + Hono 代码，两种跑法，接口完全一样：

| 跑法 | 入口 | 数据存哪 | 适合 |
|---|---|---|---|
| Cloudflare Workers | `services/sync/src/worker.ts` | D1（SQLite） | 不想维护服务器；所有者现在用这个 |
| 自建（Node 或 Docker） | `services/sync/src/node.ts` | `node:sqlite`，默认 `/data/sync.db` | 有自己的 VPS，不想受额度限制 |

服务器只存密文和少量元数据（[security.md](security.md#防谁)），所以备份文件丢了不会泄露服务器密码，但要当成敏感数据保管：里面有账号名、设备名和同步时间。

## 配置项

Workers 用 `wrangler secret put <名字>` 设；Node / Docker 用环境变量。

| 名字 | 必填 | 含义 |
|---|---|---|
| `PEPPER` | 是 | 至少 32 字节的随机串（`openssl rand -base64 32`），短了服务拒绝启动。登录凭据要和它一起算 HMAC 才存进库里。**设了就不能换**：换了所有账号都登不进去 |
| `INVITE_CODE` | 否 | 不设：关闭注册；设成空串：开放注册；设成别的：注册时要填这个邀请码。Workers 上 `wrangler secret put` 可能存不进空串，要开放注册就在 `wrangler.jsonc` 里写 `"vars": { "INVITE_CODE": "" }` |
| `QUOTA_MB` | 否 | 每个账号最多存多少，默认 50 |
| `PORT`、`DB_PATH` | 否 | 只有 Node 版用：端口（默认 8790）、数据库文件（默认 `/data/sync.db`） |

所有者自己用时：注册完自己的账号，可以把 `INVITE_CODE` 删掉关闭注册。

## 部署到 Cloudflare

要所有者的 Cloudflare 账号，`wrangler login` 会打开浏览器让所有者登录授权。**部署前先问所有者**（对外公开的东西）。

**这台电脑上已经登录着别的 Cloudflare 账号、又不能退出时**（所有者 2026-10-28 就是这样：别的项目要用原来的账号），用 wrangler 的登录档案（实验功能），只给 EverShell 这个文件夹换账号：

```sh
npx wrangler auth create evershell --scopes account:read user:read workers:write workers_scripts:write workers_tail:read d1:write
npx wrangler auth activate evershell ~/Developer/Evershell   # 绑在仓库根目录，worktree 和主文件夹都继承
npx wrangler whoami                                           # 在仓库里看到 Active profile: evershell 才对
```

- 授权链接只有 2 分钟有效。让所有者**先**在浏览器里登录要用的那个账号，再执行上面第一条；授权中途去登录或切换账号，Cloudflare 会报 `request_forbidden`（No CSRF value），要重来。
- `--scopes` 只要部署同步服务用到的几项，别用默认的一大串。
- 这台电脑上别的文件夹照常用原来的登录（`default` 档案），`npx wrangler auth list` 能看到谁绑在哪。

然后在 `services/sync` 里：

```sh
npm ci
npx wrangler login                             # 用了上面的登录档案就跳过这一步
npx wrangler d1 create evershell-sync          # 把打印出来的 database_id 填进 wrangler.jsonc
npx wrangler d1 migrations apply evershell-sync --remote
openssl rand -base64 32 | npx wrangler secret put PEPPER
npx wrangler secret put INVITE_CODE            # 输入邀请码
npm run deploy                                 # 打印出 https://evershell-sync.<子域>.workers.dev
```

- 命令行里没法交互，`wrangler secret put` 的值从管道或文件读：`npx wrangler secret put INVITE_CODE < 文件`。PEPPER 直接从 `openssl rand` 管道进去，谁都不用看到它。
- 部署完用一个临时账号把注册、推送、拉取、退出走一遍，再用 `wrangler d1 execute … --remote` 把临时账号删掉（见下面“删除账号”）。

每个账号默认 50 MB，要改就再 `npx wrangler secret put QUOTA_MB`。`wrangler.jsonc` 里关掉了 Cloudflare 的调用日志：它会记下请求头，可能带上登录令牌；代码自己的日志不记令牌、凭据和记录内容。

部署完用 `curl https://…/v1/info` 看一眼，再在 EverShell 里用这个地址注册。改了代码重新 `npm run deploy` 就行；改了表结构要先加一个新的迁移文件（`migrations/000N_….sql`），`migrations apply` 后再部署。

## 自建（Docker）

```sh
docker build -t evershell-sync services/sync
docker run -d --name evershell-sync -p 8790:8790 -v evershell-sync:/data \
  -e PEPPER=<随机串> -e INVITE_CODE=<邀请码> evershell-sync
```

客户端要求 https（本机 `127.0.0.1` / `localhost` 除外），所以前面要放一个反向代理加证书，比如 Caddy 一行 `sync.example.com { reverse_proxy 127.0.0.1:8790 }`。代理要把 `Authorization` 头和 CORS 头原样传过去。

## 本机开发和测试

- 单元测试：`scripts/check.sh sync`（内存数据库，不联网）。
- 本机跑 Node 版：`cd services/sync && npm run dev`，地址 `http://127.0.0.1:8790`，桌面端能直接连。本机用的 PEPPER、开放注册、数据库位置（`.data/sync.db`，不提交）都在 `services/sync/dev.env` 里，同名的环境变量优先（比如 `INVITE_CODE=abc npm run dev` 试邀请码）。
- 本机跑 Workers 版（模拟 D1）：`npm run dev:worker`，地址 `http://127.0.0.1:8791`，先在模拟的 D1 上建表，再读同一份 `dev.env`。

## 备份和恢复

- **Cloudflare**：D1 自带 30 天内任意时间点恢复（`npx wrangler d1 time-travel restore evershell-sync --timestamp=<时间>`）；另外可以定期 `npx wrangler d1 export evershell-sync --remote --output=backup.sql` 存一份。
- **自建**：`sqlite3 /data/sync.db ".backup backup.db"`，或者停服务后直接拷文件。
- **恢复以后**：服务器的序号会倒退，客户端发现后会自动从头拉一遍，不用手动处理（[sync.md](../specs/sync.md#同步引擎packagesuisrccoresync)）。恢复点之后各设备的改动还在各自本机，下次同步时会重新传上来。
- 就算同步服务整个没了，每台设备本机都有完整数据，换一个服务器重新注册就能接着用。这就是“不跑路”。

## 接口版本

- 路径带版本 `/v1`。只加字段、加接口算兼容，客户端忽略不认识的字段。
- 不兼容的改动开 `/v2`，`/v1` 保留到所有客户端都升级（所有者自用时一个版本周期就够；开放给别人用以后至少保留半年）。
- `GET /v1/info` 返回服务版本，客户端以后可以据此提示“请升级 EverShell”或“请升级同步服务”。
- 记录内容的格式（加密前的 JSON）由客户端决定，服务器不看；改它按 [data.md](data.md#格式版本和迁移) 的规则来，老客户端读到不认识的字段要原样保留。

## 额度

Cloudflare 免费版（2026-10-28 的数字，部署前去 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 价格](https://developers.cloudflare.com/d1/platform/pricing/) 再查一遍）：Workers 每天大约 10 万次请求（UTC 0 点，即北京时间 8 点清零）、每个请求 10 ms CPU；D1 免费 5 GB，每天读 500 万行、写 10 万行。

EverShell 的用量：每台设备每 30 秒拉一次，一天约 2880 次请求；本机有改动时多推几次。拉取走索引，没变化时读 0 行；写入只有改动和每 5 分钟一次的“最后在线”。所有者自己三五台设备，一天一万多次请求，离额度很远。

超额时当天剩下的请求都报错，客户端显示「离线」，本机数据不受影响，北京时间 8 点后自动恢复。开放给别人用以后再算账，那时考虑换成 Durable Objects 的 WebSocket 通知（[data.md](data.md#同步多久一次)），或者用付费版。

别用 KV 存同步记录：免费版每天只能写 1000 次。

## 删除账号

现在没有接口。所有者要删某个账号时，手动执行 SQL（Workers 用 `npx wrangler d1 execute evershell-sync --remote --command "…"`）：先删 `records`、`sessions` 里这个账号的行，再删 `accounts` 里那一行。开放给别人用之前要做成接口和界面。
