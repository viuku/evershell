# 云同步

> 2026-10-28。所有者要“同步体验和 FinalShell 一样，可以同步快捷命令、服务器信息、最近连接、最近命令等”，定了：先部署 Cloudflare、只有一个同步密码、忘了只能重置（不做恢复码）、界面用设计稿的方案 A。产品层面的决定记在需求文档第 4 节，这里是实现方案。

## 问题

数据只在一台电脑上。FinalShell 登录后每 30 秒自动同步一次，同步连接、私钥、命令历史、快捷命令等，数据用同步密码在本机加密后上传；可它依赖官方服务器，停服数据就没了。EverShell 要做到同样的体验，同步服务放在用户自己的 Cloudflare 账号或 VPS 上。

## 界面（方案 A）

设计稿：https://claude.ai/artifact/NDmqP3LDsJnQrT4uELxsbh 。文案以设计稿为准（已按产品文案标准写好）。

- **入口**：左侧状态栏顶部「同步状态」那一行右边的状态文字是按钮；右上角菜单在「导出连接…」下面加「云同步…」。两处打开同一个窗口。
- **没开同步**：状态写「未开启」（空心灰圈），悬停提示「单击开启云同步」。窗口顶部分段「登录」「注册账号」：服务器地址、账号、同步密码；注册多「确认密码」「邀请码」（服务器 `GET /v1/info` 说不要邀请码时不显示）。下面一块灰底说明写同步哪些内容；注册时多一行橙色警告“同步密码无法找回…”；登录时有「忘记同步密码？」，点开一段说明。按钮「登录并开启同步」「注册并开启同步」。
- **开启中**：窗口换成步骤列表（登录：正在登录… / 正在下载云端数据… / 正在合并本机数据…；注册：正在注册… / 正在加密本机数据… / 正在上传本机数据…），完成后显示「云同步已开启」和一句结果（上传了多少、取回了多少、合并了几项重复的），按钮「完成」。
- **开了以后**：单击状态直接打开同步窗口：状态条（圆点、状态、明细、「立即同步」/「重试」）；账号、服务器、本机名称（可改）；同步内容的条数（7 格）；已登录的设备（本机标「本机」，别的设备能「移除」）；底部「修改同步密码…」「退出登录…」「完成」。
- **状态六种**：未开启、已同步、正在同步…、离线（实心灰点）、同步失败（橙点）、需重新登录（橙点）。悬停提示见设计稿。「需重新登录」单击弹出重新登录框（只填同步密码，账号固定；「退出同步」「取消」「登录」）。
- **修改同步密码**：只填新密码两遍，不要原密码（忘了密码也是在这里重设）。改完其他设备都要用新密码重新登录。
- **退出登录**：确认后本机数据保留，清掉同步状态和登录凭据，不再同步。
- **移除设备**：吊销那台设备的登录，它下次同步时变成「需重新登录」；它本机的数据删不掉，确认框照实写。
- **网页端**：M2 不支持同步（没有地方安全地放保险箱钥匙，M3 再定）。状态写「未开启」，单击弹出一句「网页版暂不支持云同步」。

## 同步什么

每样数据是一个“集合”，集合里每条是一条记录（`集合名 + 记录 id`）。

| 集合 | 记录 id | 内容（加密前） | 来自 | 删除 |
|---|---|---|---|---|
| `folder` | 文件夹 id | `FolderRecord` 全部字段（含回收站的 `deletedAt`） | `hostsStore` | 墓碑 |
| `server` | 服务器 id | `ServerRecord` 去掉 `lastConnectedAt`（每连一次就变，留在本机；应用远端记录时保留本机的值） | `hostsStore` | 墓碑 |
| `key` | 私钥 id | `KeyRecord` | `keysStore` | 墓碑 |
| `secret` | 保险箱条目 id（`<服务器 id>.password`、`<私钥 id>.privateKey` 等） | 机密原文，**只在 Rust 里加解密**，不经过前端 | 保险箱 | 墓碑 |
| `snippet` | 命令 id | `Snippet` | `snippetsStore` | 墓碑 |
| `known-host` | known_hosts 那一行的 SHA-256 前 16 个十六进制字符 | `{ "line": "..." }` | 保险箱条目 `known_hosts`（经 `KnownHostsStore`） | 墓碑 |
| `history` | 历史 id | `HistoryEntry` | `historyStore` | 不发墓碑，见下 |
| `recent` | 服务器 id | `{ "at": 毫秒 }` | `recentsStore` | 不发墓碑，见下 |
| `meta` | `snippet-groups` | 分类名数组（顺序即显示顺序） | `groupsStore` | 不删 |
| `meta` | `history-cleared`、`recents-cleared` | `{ "at": 毫秒 }`：这之前的都算清空了 | 「清空」按钮 | 不删 |

不同步：保险箱条目 `known_hosts`（走 `known-host` 集合）和 `sync.` 开头的条目（同步自己的登录凭据）；窗口布局、外观、排序方式这些本机偏好；私钥库清单里的 `migratedServerKeys`（本机迁移标记）。

- **历史和最近连接**：本机只留最新 300 条 / 20 条，挤出去的不算删除，不发墓碑。「清空」写一条 `meta` 水位线（`history-cleared` / `recents-cleared`），各设备丢掉早于它的。服务器替 `history` 只留最新 1000 条（按时间戳），老的直接删。
- **分类清单**整份是一条记录，后写的赢。两台设备同时各加一个分类时会丢一个，但命令里引用到的分类照样显示（`listGroups` 会补上），丢的只是空分类。

## 怎么判断谁新：账本 + 混合逻辑时钟

**不改现有数据的存储格式。** 快捷命令、历史等现在删除是真删，没有墓碑。不在每份数据里加字段，而是同步这边自己记一本账：

- **账本**存在 `evershell.sync.v1` 里（见“本机存储”），每条记录记 `[时间戳, 内容摘要]`，删掉的摘要为 `null`。
- **本机改动的发现**：每份数据变化时（`PersistentStore` 的订阅），把当前内容逐条算摘要（稳定排序的 JSON 再做 cyrb53 或同类 53 位哈希）和账本比：新出现或摘要变了的记一个新时间戳、标为待上传；账本里有、现在没有的（且不是历史、最近连接）记墓碑、标为待上传。保险箱条目由 Rust 给每条的摘要，同样比：`HMAC-SHA256(K, id ‖ 0x00 ‖ 原文)` 的前 32 个十六进制字符，K 由保险箱钥匙经 HKDF 派生（info `evershell/sync/v1/digest`）。对原文算，重新加密（换 nonce）摘要不变；带钥匙算，摘要存在本机存储里也没法拿来离线猜密码。换了保险箱钥匙（`adoptKey`）后所有摘要变一次，登录流程里重新取一遍再建账本。应用远端机密后也重新取摘要写进账本，不能当成本机改动发回去。另外每轮同步前都比一遍，防止漏掉通知。
- **时间戳**用混合逻辑时钟（HLC），字符串，能直接按字典序比大小：`<15 位十进制毫秒>-<4 位十六进制计数>-<16 位十六进制设备 id>`，例如 `001793125352000-0000-3f9a1c2b7d4e5f60`。本机时钟落后时，收到更大的时间戳要把自己的时钟拨上去（标准 HLC 规则）。相同毫秒、相同计数时按设备 id 决胜，所以不会有平手。
- **合并规则**：每条记录后写的赢（时间戳大的赢），整条替换，不按字段合并。两台设备离线时改了同一台服务器的不同字段，后改的那次整条胜出。
- **应用远端记录**：先更新账本，再写进对应的数据（这样写入触发的“本机改动发现”看到摘要一致，不会当成新改动）。远端的比账本里的旧就忽略（防服务器回滚）。
- **墓碑永久保留**（数量小）。历史、最近连接不发墓碑，所以不会越积越多。

放弃的方案：给每份数据加 `updatedAt`、`deletedAt` 字段——要迁移所有人的数据、改一堆界面代码，换来的东西账本也能给；通用的 CRDT——都是小记录，字段级合并收益不大（调研附录 C 5.3）。

## 第一次同步和合并

- **注册**（新账号）：本机全部记录发上去，没有合并。
- **登录**（账号里已有数据）：
  1. 用同步密码解开云端的保险箱钥匙。本机保险箱原来用的是另一把时，把本机所有条目用云端那把重新加密，钥匙串里换成云端那把（`adoptKey`）。
  2. 拉下全部记录，解密。
  3. **去重**（所有者定的“完全相同的重复项只留一份”），本机记录和云端记录完全相同就只留云端那条：
     - 文件夹：同名且父文件夹相同（父文件夹先去重，从根往下比）。
     - 服务器：除 id、创建 / 修改时间、`lastConnectedAt` 以外的同步字段全部相同（备注、认证方式、高级选项、端口转发都算；`parentId`、`keyId`、跳板机 `advanced.jumpServerId` 先按去重结果换算再比），有一项不同就两台都留。本机那台存了密码、云端那台没有时，用 `moveSecret` 把密码挪到云端那台名下。
     - 私钥：公钥指纹和名称都相同。服务器里指向本机那把的 `keyId` 改指云端那把。
     - 快捷命令：名称、命令、分类、回车方式都相同。
     - 本机被去掉的记录引用到它的地方（服务器的 `parentId`、`keyId`，最近连接的服务器 id）一起改，被去掉的记录不发墓碑。
  4. 同一个 id 两边都有（很少见）：本机记录用它的 `updatedAt`（历史、最近连接用 `at`）当毫秒、计数 0、本机设备 id 造一个时间戳，和云端的比；内容完全相同就直接用云端的时间戳。机密没有修改时间，云端的赢。分类清单两边取并集（云端的顺序在前）。
  5. 剩下的照常：远端赢的写进本机，本机的发上去。顺序是先挪机密、再写本机数据；写进本机以后哪一步失败，都把本机数据还原成合并前的样子，登录失败不留半截。
  6. 完成框里的数字来自这一步：上传了多少、取回了多少、合并了几项重复的。

## 加密和钥匙

照调研附录 C 1.3、5.4 的分层做法（Standard Notes 004 的思路）：

- **数据钥匙就是保险箱钥匙**（需求文档 3.5）：32 字节随机数，存系统钥匙串。同步记录不直接用它，而是用 HKDF-SHA256 派生一把记录钥匙（info `evershell/sync/v1/record`），和保险箱条目分开用途。
- **同步密码** → Argon2id（盐 16 字节随机；默认 64 MiB、3 轮、1 线程）→ 32 字节根钥匙 → HKDF-SHA256 拆成两把：
  - 包裹钥匙（info `evershell/sync/v1/kek`）：锁保险箱钥匙，**只在本机内存里**；
  - 登录凭据（info `evershell/sync/v1/auth`）：发给服务器登录用，服务器拿它解不开任何东西。
- **包裹**：XChaCha20-Poly1305，附加数据 `evershell/sync/v1/wrap` + `\0` + 账号名。
- **账号名**一律去掉首尾空白、转小写后再用（FinalShell 出过大小写不一致导致解不开的问题）。
- **每条记录**：XChaCha20-Poly1305，随机 24 字节 nonce，上传 `base64(nonce ‖ 密文 ‖ 标签)`。附加数据把这条记录的身份全部绑进去：`evershell/sync/v1/record\0<账号>\0<集合>\0<id>\0<时间戳>\0<1 或 0（是否墓碑）>`。墓碑也加密一个空内容，服务器伪造不了删除，也挪不了、改不了时间戳。
- **服务器给的 KDF 参数要在范围内**才用：内存 8 MiB～1 GiB、轮数 1～10、线程 1～4，算法只认 `argon2id`；不在范围内报错，免得被设成一个能把电脑内存吃光的数。
- 机密原文、根钥匙、包裹钥匙都不离开 Rust：前端只拿到登录凭据（本来就是给服务器的）和密文。机密的墓碑也走 `sealSecret`（Rust 对空内容加密，条目在不在都行），普通的 `seal` / `open` 不收 `secret` 集合。
- **保险箱被重建时不发删除**：登录时记下 `keyCheck()`（由保险箱钥匙和保险箱编号一起派生的校验值；编号是新建保险箱时随机生成的，存成保险箱里的一条保留条目 `sync.vault-id`，所以“钥匙没变、保险箱换了”也看得出来。不放成 `vault.json` 的新字段：老版本存东西时会丢掉不认识的字段，却会原样保留条目）。取校验值出错只算这一轮失败、稍后重试，不当成重建，每轮同步前比一遍。对不上或变成没有（保险箱打不开被换掉了、钥匙串丢了），说明本机机密是“丢了”而不是“删了”：停止同步，状态改成「需重新登录」（「本机保险箱已重建，请重新登录同步」）。重新登录后忘掉账本里 `secret`、`known-host` 两个集合的记录、从头拉一遍，云端的补回本机；这一遍里本机已经有的不被云端的旧值或墓碑覆盖（那是重建以后才存的），拉完的那次扫描再把它们发上去。另有一道兜底：账本里有若干条机密（或指纹记录）、一次扫描突然一条都没有了，同样当成保险箱重建处理，不发墓碑。
- 依赖：`argon2`、`hkdf`、`sha2`（RustCrypto，纯 Rust，能编成 WASM，GPL 兼容），放进 `crates/vault`。

服务器能看到的元数据（威胁模型里写明）：账号名、设备名和平台、每条记录的集合名、id、时间戳（含设备 id 和修改时间）、密文大小、什么时候同步。服务器能做的坏事：扣下某些记录不给、整个删掉；做不到的：看内容、改内容、伪造删除、把旧版本冒充新版本（客户端账本拒收比已知旧的）。

## 同步服务

### 部署

一套 TypeScript + Hono 代码，两种跑法（需求文档第 7 节）：

- **Cloudflare**：Workers + D1（这次先部署这个）。不用 Durable Objects，也不用 KV（免费版每天只能写 1000 次）。
- **自建**：Node 22 以上自带的 `node:sqlite`，Docker 镜像，数据放挂载的 `/data/sync.db`。

代码在 `services/sync/`：`src/app.ts`（路由，不管存储）、`src/store.ts`（存储接口）、`src/store-d1.ts`、`src/store-sqlite.ts`、`src/worker.ts`、`src/node.ts`、`schema.sql`、`wrangler.jsonc`、`Dockerfile`、测试。部署和运维写在 [同步服务分册](../handbook/sync-service.md)。

配置（Workers 用 `wrangler secret put`，Docker 用环境变量）：`PEPPER`（必填，32 字节以上随机串）、`INVITE_CODE`（有就要邀请码，空串表示开放注册，不设表示关闭注册）、`QUOTA_MB`（每个账号的空间，默认 50）。

### 接口（v1）

全是 JSON，路径前缀 `/v1`。要登录的接口带 `Authorization: Bearer <令牌>`。出错返回 `{ "error": "<代码>", "message": "<给人看的中文>" }`，客户端按代码处理。所有响应带 CORS 头（`Access-Control-Allow-Origin: *`，允许 `authorization, content-type`，`OPTIONS` 直接回 204）。

| 接口 | 请求 | 返回 |
|---|---|---|
| `GET /info` | | `{ service: "evershell-sync", version: 1, registration: "invite" \| "open" \| "closed" }` |
| `POST /prelogin` | `{ account }` | `{ salt, kdf }`。账号不存在也返回：盐用 HMAC-SHA256(PEPPER, "salt:" + 账号) 前 16 字节，参数用默认值，免得被拿来试探哪些账号存在 |
| `POST /register` | `{ account, invite?, authKey, salt, kdf, wrappedKey, device: { id, name, platform } }` | 201 `{ token }`。错误：`account_exists` 409、`bad_invite` / `registration_closed` 403、`invalid` 400 |
| `POST /login` | `{ account, authKey, device }` | `{ token, wrappedKey }`。错误：`bad_credentials` 401、`too_many_attempts` 429（同一账号 15 分钟内失败 10 次） |
| `POST /logout` | | 204，吊销这个令牌 |
| `GET /account` | | `{ account, usage: { bytes, records }, quota: { bytes }, devices: [{ id, name, platform, lastSeenAt, current }] }` |
| `PATCH /device` | `{ name }` | 204，改本机名称 |
| `DELETE /devices/:id` | | 204，吊销那台设备的所有令牌；不能删自己（用 `/logout`） |
| `POST /password` | `{ authKey, salt, kdf, wrappedKey }` | 204；换掉登录凭据和包裹好的钥匙，吊销除当前令牌以外的所有令牌 |
| `POST /records` | `{ records: [{ collection, id, hlc, deleted, data }] }` | `{ seq, results: [{ status: "ok" \| "stale", hlc? }] }`；`stale` 表示服务器上已有更新的，带上服务器的时间戳。错误：`quota_exceeded` 413、`clock_skew` 400（时间戳比服务器时间快 10 分钟以上） |
| `GET /records?since=<seq>&limit=<n>` | | `{ records: [{ collection, id, hlc, deleted, data, seq }], seq, more }`；`limit` 默认 500、最多 1000 |

`unauthorized`（401）表示令牌没了（退出、被移除、改了密码），客户端转成「需重新登录」。

**限制**：`collection` 是 `[a-z][a-z-]{0,31}`；`id` 1～200 个可见 ASCII 字符；`hlc` 符合上面的格式；`data` 是 base64，每条最多 64 KiB；每次最多 500 条；请求体最多 4 MiB；超过账号空间返回 `quota_exceeded`。

### 存储

```sql
CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, verifier TEXT NOT NULL,
  salt TEXT NOT NULL, kdf TEXT NOT NULL, wrapped_key TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0,
  used_bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL, device_id TEXT NOT NULL,
  device_name TEXT NOT NULL, platform TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
CREATE TABLE records (account_id INTEGER NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
  hlc TEXT NOT NULL, deleted INTEGER NOT NULL, data TEXT NOT NULL, size INTEGER NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (account_id, collection, id));
CREATE INDEX records_seq ON records (account_id, seq);
CREATE TABLE login_failures (account TEXT NOT NULL, at INTEGER NOT NULL);
```

- **登录凭据不存原样**：存 HMAC-SHA256(PEPPER, 登录凭据)，比较用常数时间。不再做慢哈希：登录凭据本身是 Argon2id 派生出来的 256 位随机值，没法爆破；要爆破只能从同步密码下手，那和直接爆破包裹好的钥匙代价一样。Cloudflare 免费版每个请求只有 10 ms CPU，也做不了慢哈希。
- **令牌**：32 字节随机数（base64url）给客户端，库里只存 SHA-256。`last_seen_at` 超过 5 分钟才更新一次，省 D1 的写入额度。
- **写入**：一次推送在一个事务（D1 用 batch）里做：先把账号的 `seq` 加上条数，再逐条 `INSERT ... ON CONFLICT DO UPDATE ... WHERE excluded.hlc > records.hlc`，每条拿一个新 `seq`；没写进去的回 `stale`。同时更新 `used_bytes`。`history` 超过 1000 条时删掉最老的。
- **拉取**：`WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?`，走索引，没变化时只读到 0 行。

### 额度（Cloudflare 免费版，2026-10-28 的数字，以官网为准）

每台设备每 30 秒拉一次，一天约 2880 次请求，加上推送也就三千多次；免费版每天 10 万次，所有者自己三五台设备够用。D1 每次拉取只读几行，写入只有改动和隔 5 分钟一次的“最后在线”。额度用完时当天剩下的请求报错，客户端当成「离线」处理（本机数据不受影响）。开放给别人用时再算账，那时可以换 Durable Objects 推送通知（[data.md](../handbook/data.md#同步多久一次) 有当时的分析）。

## 客户端

### 平台接口（`packages/ui/src/types.ts`）

加密要用保险箱钥匙，钥匙在 Rust 里，所以加解密都走平台接口。HTTP 直接用 `fetch`（桌面端、网页端、以后的手机端都一样），不走平台接口。

```ts
export interface KdfParams { alg: 'argon2id'; mKib: number; t: number; p: number }
export interface RecordAad { account: string; collection: string; id: string; hlc: string; deleted: boolean }

/** 云同步要的平台能力，见 docs/specs/sync.md。网页端没有（M2 不支持同步） */
export interface SyncPlatform {
  /** 本机默认名称，如“MacBook Pro” */
  deviceName(): Promise<string>;
  /** 用同步密码派生登录凭据；不给盐时新生成盐、用默认参数（注册、改密码）。包裹钥匙留在平台内存里给下面两个方法用 */
  derive(password: string, account: string, salt?: string, kdf?: KdfParams): Promise<{ salt: string; kdf: KdfParams; authKey: string }>;
  /** 用刚派生的包裹钥匙锁本机的保险箱钥匙（没有就先生成） */
  wrapKey(): Promise<string>;
  /** 解开云端的保险箱钥匙并换成它；本机条目用新钥匙重新加密 */
  adoptKey(wrapped: string): Promise<void>;
  seal(items: { aad: RecordAad; plain: string }[]): Promise<string[]>;
  /** 认证失败的那条返回 null */
  open(items: { aad: RecordAad; data: string }[]): Promise<(string | null)[]>;
  /** 保险箱每条的摘要（不含 known_hosts 和 sync. 开头的） */
  secretDigests(): Promise<Record<string, string>>;
  /** 加密保险箱里的这条；不存在返回 null */
  sealSecret(id: string, aad: RecordAad): Promise<string | null>;
  /** 解密后写进保险箱（墓碑就删掉这条）；认证失败返回 false */
  openSecret(id: string, aad: RecordAad, data: string): Promise<boolean>;
  /** 第一次登录去重时把本机的一条机密挪到云端那条记录的 id 下：to 已有就只删 from */
  moveSecret(from: string, to: string): Promise<void>;
  /** 保险箱钥匙的校验值（由钥匙派生）；还没有钥匙时为 null */
  keyCheck(): Promise<string | null>;
  /** 有值时这个平台暂时不同步，值是给用户看的原因（桌面端调试版） */
  readonly disabledReason?: string;
  /** 预览用的假服务器；正式平台不给，用全局 fetch */
  fetch?: typeof fetch;
}
```

`SshBackend` 加 `readonly sync?: SyncPlatform`。桌面端在 `apps/desktop/src/tauri-backend.ts` 里接 Rust 命令；预览用的假后端（`packages/ui/src/mock`）给一个不加密的假实现（base64 包一层）和一个内存里的假同步服务器，`?mock` 里能把流程点一遍；网页端不给。

### 桌面端 Rust（`apps/desktop/src-tauri/src/sync.rs`）

命令和上面一一对应：`sync_device_name`、`sync_derive`、`sync_wrap_key`、`sync_adopt_key`、`sync_seal`、`sync_open`、`sync_secret_digests`、`sync_seal_secret`、`sync_open_secret`、`sync_move_secret`、`sync_key_check`，都是 `async fn`（架构分册的运行时约定），登记到 `lib.rs`。

- **调试版不同步**：`tauri dev` 和 `scripts/mac-preview.sh` 编的调试版和所有者的正式版共用本机数据（[pitfalls.md](../handbook/pitfalls.md#调试版和正式版共用所有者的真实数据)），两个同时同步会互相覆盖。前端看 `import.meta.env.DEV` 或 Tauri CLI 给的 `TAURI_ENV_DEBUG`，调试版的 `SyncPlatform.disabledReason` 有值，引擎不启动，点「同步状态」只弹原因。

- 派生出的包裹钥匙放在一个托管状态里（`Zeroizing`，只留最近一次），`sync_adopt_key` 用完就清掉，`sync_wrap_key` 用完不清（注册失败重试用）。没有就报“请重新输入同步密码”。
- `Secrets` 加几个方法：`digests()`（算法见上面“本机改动的发现”）、`seal_entry(id, aad)`、`open_entry(id, aad, data)`、`move_entry(from, to)`、`key_check()`、`adopt_key(new_key)`。`adopt_key` 分两步提交，任何一步被打断都不丢数据：新钥匙加密的保险箱先写成同目录的 `vault-adopting.json` → 换钥匙串 → 改名盖过 `vault.json`；打开时钥匙串里的钥匙打不开 `vault.json`、却能打开 `vault-adopting.json`，就补上改名，其他情况下多余的 `vault-adopting.json` 直接删掉。
- 加密算法本身在 `crates/vault/src/sync.rs`（能编成 WASM，以后网页端用）：`KdfParams`（含范围检查）、`normalize_account`、`derive`、`wrap_key` / `unwrap_key`、`RecordKey::from_vault_key`、`seal_record` / `open_record`、`RecordAad`。机密类型不派生 `Debug`。
- **CSP**：`tauri.conf.json` 的 `connect-src` 加 `https: http://127.0.0.1:* http://localhost:*`，同步服务器要 https（本机测试除外）。脚本仍然只许 `'self'`，所以放开连接地址不会让外来脚本跑起来。

### 同步引擎（`packages/ui/src/core/sync/`）

数据都在前端的存储里，合并逻辑放在前端的 `core/`，三个平台共用；加密在 Rust。这是跨平台守则第 2 条（协议和数据逻辑写进 Rust 内核）的例外，原因写进架构分册。

- `hlc.ts`：时钟。
- `digest.ts`：稳定 JSON 和摘要。
- `collections.ts`：每个集合一个适配器：读出 `Map<id, 内容>`、写入一条、删除一条；去重和改引用。
- `ledger.ts`：账本、本机改动的发现、待上传队列。
- `client.ts`：接口的封装（上面的表），错误代码转成 `SyncError`。
- `engine.ts`：一轮同步（先推后拉：推待上传的；拉 `since=游标` 直到 `more=false`；应用；更新游标），调度，状态。
- `account.ts`：注册、登录（含第一次合并）、退出、改密码、移除设备、重新登录。
- `status.ts`：给界面的状态 `Store`：`{ state: 'off' | 'syncing' | 'ok' | 'offline' | 'error' | 'relogin', lastSyncAt, message, counts }`。

**调度**：开着同步时，每 30 秒一轮；本机有改动 1.5 秒后推一次（防抖）；窗口回到前台、网络恢复（`online` 事件）时立刻一轮；`navigator.onLine` 为 false 时不跑。出错退避 30 秒、1 分钟、2 分钟、5 分钟封顶，成功后恢复 30 秒。同一时间只跑一轮。

**只在主窗口跑**：连接管理器、编辑窗口改的数据经 `store-sync` 事件到主窗口，主窗口的数据一变就会被发现；别的窗口不跑引擎。

**服务器恢复过备份**：拉取返回的 `seq`（服务器当前最大序号）比本机游标小，说明服务器倒回去了。游标归零、从 0 重新拉一遍；账本照常按时间戳判断，旧版本会被拒收。

**错误怎么归类**：`fetch` 抛错（断网、DNS、TLS）或额度用完（429、Cloudflare 的 1027 页面）→ 离线；401 → 需重新登录；其他 4xx / 5xx、解密失败 → 同步失败，`message` 写原因。解密失败的记录跳过、不应用，游标照常往前走，状态显示「同步失败」（原因写“部分数据无法解密”）。钥匙对的时候不会发生，出现了就是数据坏了或被篡改，重试也没用。

**改密码**：`derive`（新盐）→ `wrapKey` → `POST /password`。本机令牌还能用，其他设备收到 401 变成「需重新登录」。

**重新登录**：`prelogin` → `derive` → `login` → `adoptKey`（同一把钥匙时什么都不做）→ 接着同步。

### 界面用的接口

界面只用 `packages/ui/src/core/sync/index.ts` 导出的东西：状态 `syncStatus`、`startSync`（主窗口启动时调一次）、`serverInfo`、`register` / `login`（带进度回调，返回 `EnableResult`）、`relogin`、`logout`、`changePassword`、`syncNow`、`listDevices`、`removeDevice`、`renameDevice`、`validateEnableForm`、`describeEnableResult`、`syncSupported`，出错抛 `SyncError`（`message` 直接给用户看，照产品文案标准写）。签名以那个文件为准，引擎实现时不改签名。

### 本机存储

- `evershell.sync.v1`（新，经 `core/storage.ts`，只有主窗口写）：

```json
{
  "version": 1,
  "server": "https://sync.example.com",
  "account": "ops",
  "deviceId": "3f9a1c2b7d4e5f60",
  "deviceName": "MacBook Pro",
  "cursor": 1834,
  "clock": { "ms": 1793125352000, "c": 0 },
  "ledger": { "server": { "srv_m2x9k3ab12cd": ["001793125352000-0000-3f9a1c2b7d4e5f60", "1h2k3l4m5n6o"] } },
  "pending": ["server/srv_m2x9k3ab12cd"],
  "marks": { "history-cleared": 0, "recents-cleared": 0 },
  "lastSyncAt": 1793125360000
}
```

  `marks` 是「清空」水位线（见“同步什么”）。没开同步时没有这个键。退出登录时删掉它。
- 「清空」怎么发现：`clearHistory` / `clearRecents` 没改，引擎看到历史或最近连接从有变成空（而且不是在应用远端记录）时写水位线；挤出去的不会把列表清空，不会误判。
- 默认的 3 条快捷命令：开着同步时如果还没写进本机存储，先写下来，免得每次启动 id 都变、被当成删了又新建。
- 保险箱条目 `sync.session`：登录令牌。退出登录时删掉。
- 保险箱条目 `sync.vault-id`：随机的保险箱编号，`keyCheck` 要用；没有的保险箱在第一次 `keyCheck` 时补上。前端读写不了它，也不同步。
- 时钟：同步状态里另存见过的远端最大时间戳。本机时钟要往回拨（启动时快了一分钟以上、服务器报时间太快）时，最多拨到“现在”和这个最大值中较大的那个，保证本机的新改动总比已经拉到的记录新。
- 格式规则照 [data.md](../handbook/data.md#格式版本和迁移)：读到更高的 `version` 时不同步、不写回，状态显示「同步失败」并提示升级。

## 对其他平台的影响

- **网页端**：M2 不支持。加密代码在 `crates/vault`，能编成 WASM；M3 定网页端怎么放保险箱钥匙（每次输同步密码，或不存）以后，给网页端实现 `SyncPlatform` 就行，引擎、界面、服务器都不用改。CORS 已经放开。
- **Windows**：钥匙串换成凭据管理器（`keyring` 已经支持），其余一样。
- **手机**：界面和引擎直接复用；切后台时停掉定时器，回前台补一轮。

## 怎么测

- `crates/vault`：派生用固定参数（小内存）和固定盐得到固定结果；包裹 / 解包；记录加解密；附加数据任何一项不同都解不开；KDF 参数越界报错。
- 桌面端 Rust：`adopt_key` 后旧条目都能用新钥匙读出、钥匙串换了新钥匙；写文件失败时什么都不变；摘要不含 `known_hosts` 和 `sync.`；`seal_entry` / `open_entry` 往返。
- 同步服务（vitest，`node:sqlite` 内存库，直接调 Hono 的 `app.request`）：注册、登录、`prelogin` 对不存在的账号返回稳定的假盐；邀请码三种配置；登录失败限流；推送的“后写的赢”和 `stale`；拉取分页；令牌吊销（退出、移除设备、改密码）；空间限制；时钟太快被拒；CORS 预检；`history` 只留 1000 条。D1 那一套用 `wrangler dev --local` 手动跑一遍。
- 同步引擎（vitest）：HLC；发现新增、修改、删除；历史挤出去不发墓碑；水位线；第一次合并的去重和改引用；同 id 冲突；两个模拟客户端连同一个内存里的服务器（Hono 的 `app.request` 当 `fetch`）来回改、删、离线后再合并，最后两边一致；服务器回滚旧版本被拒收；401、断网、5xx 的状态。
- 界面：`?mock` 深色、浅色各看一遍开启、面板、修改密码、退出、移除设备。
- 端到端：本机起 `services/sync` 的 Node 版，桌面端（同一时刻只能开一个）连上去开同步，第二台设备用测试代码模拟，两边来回改。最后所有者在自己的 Cloudflare 上部署，在 Mac 上开同步试用。
