# 数据与迁移

> **管什么**：EverShell 在用户电脑上存了哪些数据、存在哪、什么格式；格式改了怎么迁移；导入导出；以后的同步冲突和同步频率。
> **什么时候更新**：加了新的存储项、改了任何存储格式、改了导出格式；M2 开工前写“同步冲突”“同步多久一次”两节。
> **上次复核**：2026-10-18

“数据永远带得走”是产品的核心承诺（[product.md](product.md#产品原则)），所以存储格式是对用户的承诺，不能随手改。依据见调研 [附录 C 第 5 节](../research/2026-10-appendix-c-ssh-client-concerns.md)。

## 本机存了什么

桌面端和网页端的界面数据都经 `packages/ui/src/core/storage.ts` 存在 WebView 的本地存储里（守则 5）。全部清单用 `grep -rn "'evershell\." packages/ui/src apps/web/src` 现查，下表是 2026-10-23 的样子：

| 数据 | 存储键或位置 | 格式版本 | 同步用的字段 |
|---|---|---|---|
| 连接和文件夹 | `evershell.hosts.v1`；服务器的 `keyId` 指向私钥库里的私钥。搬私钥进私钥库之前的原样备份在 `evershell.hosts.v1.before-key-library` | 数据里 `version: 1` | 有 id、updatedAt、deletedAt（墓碑） |
| 私钥库清单 | `evershell.keys.v1`：名称、类型、长度、公钥指纹，不含机密（`packages/ui/src/core/key-library.ts`，规格 [key-library.md](../specs/key-library.md)） | 数据里 `version: 1` | 有 id、updatedAt、deletedAt（墓碑） |
| 快捷命令 | `evershell.snippets.v1`（`group` 是分类名） | 键名里的 v1 | 有 id、updatedAt，**没有墓碑** |
| 快捷命令的分类 | `evershell.snippet-groups.v1`：分类名的数组，顺序即显示顺序（规格 [command-groups.md](../specs/command-groups.md)） | 键名里的 v1 | 没有，M2 定 |
| 历史命令 | `evershell.history.v1` | 键名里的 v1 | 没有 |
| 最近连接 | `evershell.recents.v1` | 键名里的 v1 | 没有（只是本机记录，可以不同步） |
| 终端外观 | `evershell.terminal-appearance.v1`、背景图 `evershell.terminal-bg-image` | 键名里的 v1 | 没有 |
| 界面状态 | `evershell.appearance-mode`、`evershell.sidebar-open`、`evershell.bottom-height`、`evershell.bottom-open`、`evershell.files.follow`、`evershell.manager.*`；命令页的编辑器宽度 `evershell.cmd-editor-width`、两个“发送到” `evershell.cmd-send-target` / `evershell.cmd-editor-target`、“发送后清空” `evershell.cmd-editor-clear`（`packages/ui/src/core/commands-panel.ts`；命令编辑器里的文字只在内存里） | 无 | 本机偏好，不同步 |
| 主机密钥记录 | 桌面端：保险箱条目 `known_hosts`；网页端：`evershell.knownHosts`（`packages/ui/src/core/known-hosts.ts`） | OpenSSH known_hosts 文本格式 | M2 设计 |
| 网页端的中转设置 | `evershell.relay`（`apps/web/src/relay-bar.tsx`） | 无 | 不同步 |
| 网页版 `?mock` 的假保险箱 | `evershell.mock-secrets` | 无 | 只用于预览 |
| 保险箱（桌面端） | 条目：服务器密码 `<服务器 id>.password`；私钥库的私钥 `<私钥 id>.privateKey`、口令 `<私钥 id>.passphrase`；`known_hosts`。文件在应用数据目录下的 `vault.json`（Mac 上是 `~/Library/Application Support/dev.evershell.desktop/`）；打不开时旧文件改名为 `vault-unreadable-<时间>.json` | 文件头 `version: 1` | M2 设计 |
| 保险箱钥匙 | 系统钥匙串：服务名 `dev.evershell.desktop`，账户 `vault-key` | | 不同步（同步时用主密码另锁一份） |

桌面端的主窗口、编辑窗口、连接管理器各有一份内存里的数据，共用上面这些存储：一个窗口写了，`core/storage.ts` 会通知其他窗口换成新内容（Tauri 事件 `store-sync`；浏览器多开页签靠自带的 storage 事件），不然另一个窗口下次写会拿旧数据盖掉。两个窗口几乎同时改同一个键时后写的赢（[docs/specs/manager-window.md](../specs/manager-window.md)）。

调试版和正式版的应用标识相同，所以上面这些两边共用（[pitfalls.md](pitfalls.md#调试版和正式版共用所有者的真实数据)）。

## 格式版本和迁移

所有持久化的格式都要有版本号，改格式时守三条规则：

1. **读到比自己新的版本：只读或拒绝，绝不覆盖写回。** 防止老版本软件把新数据毁掉。保险箱已经这样做（读到更高版本直接拒绝）。
2. **读到旧版本：按迁移链一级一级升上来，升级前先备份原数据。**
3. **每个版本留一份样例做测试**，迁移代码有单元测试（[quality.md](quality.md#什么必须有测试)）。

改格式属于“AI 必须先问”的事（[process.md](process.md#谁拍板)），并且要先写规格。

## 记录的字段约定

要同步的数据，每条记录现在就带上这三个字段，等 M2 再加就要迁移所有人的数据：

- `id`：唯一编号，用 `core/storage.ts` 的 `newId`。
- `updatedAt`：最后修改时间。M2 可能换成混合逻辑时钟（见下面“同步冲突”），字段先占着。
- `deletedAt`：删除不真删，记下删除时间当墓碑，界面上隐藏。

现在连接和文件夹已经齐了；快捷命令缺墓碑，历史命令都没有，下次改到它们时补上（属于格式变化，按上面的规则迁移）。快捷命令的分类清单只是名字数组，三个字段都没有，M2 设计同步时一起定（[规格](../specs/command-groups.md#导出和以后的同步)）。

## 导入导出

- **导入**：来源和规则见需求文档 3.4，代码在 `packages/ui/src/core/importers/`。只导入白名单字段，导入的“会执行的东西”要用户确认（[security.md](security.md#红线)）。
- **一键导入**：桌面端去各软件默认存配置的位置读文件，位置表在 `apps/desktop/src-tauri/src/local_import.rs`，前端不能传路径；读到的文件交给同一套解析器。规格见 [docs/specs/one-click-import.md](../specs/one-click-import.md)。
- **导出**：格式名 `evershell-connections`，版本 1，不含密码和私钥（`packages/ui/src/core/importers/export.ts`）。读到更高版本时提示并忽略不认识的字段。
- **要做**：把导出格式写成一份公开的说明文档（字段含义、版本、以后的加密方式），这是“不跑路”承诺的一部分。写在 `docs/` 下，和导出格式一起改。
- **以后**：加密导出（含密码），方案见 [security.md](security.md#加密选型)。

## 同步冲突（M2 开工前写）

占位。调研的建议（附录 C 5.3、5.5），设计时作为起点：

- 逐条记录“最后写入的胜出”，时间用混合逻辑时钟（HLC），相同时用设备编号决胜；墓碑永久保留，否则删掉的连接会“复活”。
- 不上通用的 CRDT：连接、快捷命令都是小记录，按字段合并收益不大。
- 服务器只存“账号、记录编号、时间戳、密文”，按时间戳增量拉取。
- 两台单机用过的设备合并时，要有冲突预览，至少处理“两边都有同名连接”。

## 同步多久一次（M2 开工前定）

占位。2026-10-23 所有者问“FinalShell 好像每几秒同步一次，Cloudflare 免费版够不够”，当时算过一遍，设计时作为起点：

- **不定时轮询。** 免费版 Workers 每天大约 10 万次请求（UTC 0 点清零，即北京时间 8 点）。每 3 秒拉一次，一台设备全天约 2.88 万次：所有者自己两三台设备勉强够；网页版的中转放在同一个账号也从这里扣；开放给别人用（[需求第 4 节](../requirements.md#4-云同步)的多账号）就远远不够。而且绝大多数请求拉回来都是“没变化”。
- **改成“有变化才通知”：**
  - 本机改了立刻推一次。
  - 每台设备和服务器保持一条 WebSocket。别的设备推送后，服务器发一句“有新数据”，设备再按时间戳增量拉。Cloudflare 上可以用 Durable Objects 的 WebSocket Hibernation：空闲时不计时长，服务器发出的消息不计费，收到的消息 20 条算 1 次请求。自建 Docker 版用同一套协议。
  - 启动、断网重连、窗口回到前台时补拉一次，另外每隔几分钟兜底拉一次，防止连接悄悄断了没发现。
  - 这样每台设备每天大约几百次请求，改完到另一台看到一般在一两秒以内。
  - 需求里写的是 Workers + D1 / R2，用 Durable Objects 算新加一种服务，设计时要先问所有者。
- **其他额度不紧**：D1 免费 5 GB，每天读 500 万行、写 10 万行（读按扫描的行数算，增量拉取的查询要走索引）；Durable Objects 免费版每天 10 万次请求，只能用 SQLite 后端。**别用 KV 存同步记录**：免费版每天只能写 1000 次。
- **超额的后果**：当天剩下的请求都报错，到 UTC 0 点恢复。因为离线优先，本机数据不受影响；客户端要把“额度用完”当成普通的暂时连不上，不能当成数据出错。
- 额度数字会变，M2 开工时去 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 价格](https://developers.cloudflare.com/d1/platform/pricing/)、[Durable Objects 价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[KV 价格](https://developers.cloudflare.com/kv/platform/pricing/) 再查一遍。同步服务分册写出来后，额度这部分搬过去，这里只留链接。
