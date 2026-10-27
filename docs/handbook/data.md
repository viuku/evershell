# 数据与迁移

> **管什么**：EverShell 在用户电脑上存了哪些数据、存在哪、什么格式；格式改了怎么迁移；导入导出；以后的同步冲突和同步频率。
> **什么时候更新**：加了新的存储项、改了任何存储格式、改了导出格式、改了同步的合并规则或频率。
> **上次复核**：2026-10-18

“数据永远带得走”是产品的核心承诺（[product.md](product.md#产品原则)），所以存储格式是对用户的承诺，不能随手改。依据见调研 [附录 C 第 5 节](../research/2026-10-appendix-c-ssh-client-concerns.md)。

## 本机存了什么

桌面端和网页端的界面数据都经 `packages/ui/src/core/storage.ts` 存在 WebView 的本地存储里（守则 5）。全部清单用 `grep -rn "'evershell\." packages/ui/src apps/web/src` 现查，下表是 2026-10-23 的样子：

| 数据 | 存储键或位置 | 格式版本 | 云同步（集合名见 [sync.md](../specs/sync.md#同步什么)） |
|---|---|---|---|
| 连接和文件夹 | `evershell.hosts.v1`；服务器的 `keyId` 指向私钥库里的私钥。搬私钥进私钥库之前的原样备份在 `evershell.hosts.v1.before-key-library` | 数据里 `version: 1` | 按条同步（`folder`、`server`）；`deletedAt` 是回收站，照常同步；`lastConnectedAt` 留在本机 |
| 私钥库清单 | `evershell.keys.v1`：名称、类型、长度、公钥指纹，不含机密（`packages/ui/src/core/key-library.ts`，规格 [key-library.md](../specs/key-library.md)） | 数据里 `version: 1` | 按条同步（`key`），`migratedServerKeys` 不同步 |
| 快捷命令 | `evershell.snippets.v1`（`group` 是分类名；不自动回车的带 `noEnter: true`，没有这项就是自动回车，规格 [command-import.md](../specs/command-import.md)） | 键名里的 v1 | 按条同步（`snippet`），删除由同步账本记墓碑 |
| 快捷命令的分类 | `evershell.snippet-groups.v1`：分类名的数组，顺序即显示顺序（规格 [command-groups.md](../specs/command-groups.md)） | 键名里的 v1 | 整份一条（`meta` / `snippet-groups`），后写的赢 |
| 历史命令 | `evershell.history.v1` | 键名里的 v1 | 按条同步（`history`）；挤出 300 条的不算删除，「清空」写水位线 |
| 最近连接 | `evershell.recents.v1` | 键名里的 v1 | 按服务器 id 同步（`recent`），清空同上 |
| 终端外观 | `evershell.terminal-appearance.v1`、背景图 `evershell.terminal-bg-image` | 键名里的 v1 | 本机偏好，不同步 |
| 界面状态 | `evershell.appearance-mode`、`evershell.sidebar-open`、`evershell.bottom-height`、`evershell.bottom-open`、`evershell.files.follow`、`evershell.manager.*`；命令页的编辑器宽度 `evershell.cmd-editor-width`、两个“发送到” `evershell.cmd-send-target` / `evershell.cmd-editor-target`、“发送后清空” `evershell.cmd-editor-clear`（`packages/ui/src/core/commands-panel.ts`；命令编辑器里的文字只在内存里） | 无 | 本机偏好，不同步 |
| 主机密钥记录 | 桌面端：保险箱条目 `known_hosts`；网页端：`evershell.knownHosts`（`packages/ui/src/core/known-hosts.ts`） | OpenSSH known_hosts 文本格式 | 按行同步（`known-host`） |
| 网页端的中转设置 | `evershell.relay`（`apps/web/src/relay-bar.tsx`） | 无 | 不同步 |
| 网页版 `?mock` 的假保险箱 | `evershell.mock-secrets` | 无 | 只用于预览 |
| 保险箱（桌面端） | 条目：服务器密码 `<服务器 id>.password`；私钥库的私钥 `<私钥 id>.privateKey`、口令 `<私钥 id>.passphrase`；`known_hosts`；同步的登录令牌 `sync.session`、保险箱编号 `sync.vault-id`。文件在应用数据目录下的 `vault.json`（Mac 上是 `~/Library/Application Support/dev.evershell.desktop/`）；`sync.vault-id` 是随机的保险箱编号（2026-10-28 加，同步用来认出保险箱被重建过；放成条目而不是新字段，因为老版本会丢掉不认识的字段）；打不开时旧文件改名为 `vault-unreadable-<时间>.json`；同步换钥匙时中途的文件是 `vault-adopting.json` | 文件头 `version: 1` | 按条同步（`secret`，只在 Rust 里加解密）；`known_hosts` 走上面那行，`sync.` 开头的不同步 |
| 保险箱钥匙 | 系统钥匙串：服务名 `dev.evershell.desktop`，账户 `vault-key` | | 它就是同步的数据钥匙；用同步密码另锁一份存在同步服务器上 |
| 云同步的状态 | `evershell.sync.v1`：服务器、账号、设备 id 和名称、游标、时钟、账本、待上传、「清空」水位线（`packages/ui/src/core/sync/state.ts`），只有主窗口写；没开同步时没有这个键 | 数据里 `version: 1` | 本机状态，不同步 |

桌面端的主窗口、编辑窗口、连接管理器各有一份内存里的数据，共用上面这些存储：一个窗口写了，`core/storage.ts` 会通知其他窗口换成新内容（Tauri 事件 `store-sync`；浏览器多开页签靠自带的 storage 事件），不然另一个窗口下次写会拿旧数据盖掉。两个窗口几乎同时改同一个键时后写的赢（[docs/specs/manager-window.md](../specs/manager-window.md)）。

调试版和正式版的应用标识相同，所以上面这些两边共用（[pitfalls.md](pitfalls.md#调试版和正式版共用所有者的真实数据)）。

## 格式版本和迁移

所有持久化的格式都要有版本号，改格式时守三条规则：

1. **读到比自己新的版本：只读或拒绝，绝不覆盖写回。** 防止老版本软件把新数据毁掉。保险箱已经这样做（读到更高版本直接拒绝）。
2. **读到旧版本：按迁移链一级一级升上来，升级前先备份原数据。**
3. **每个版本留一份样例做测试**，迁移代码有单元测试（[quality.md](quality.md#什么必须有测试)）。

改格式属于“AI 必须先问”的事（[process.md](process.md#谁拍板)），并且要先写规格。

## 记录的字段约定

云同步的“谁新谁旧”和“删了什么”记在同步自己的账本里（`evershell.sync.v1`，[规格](../specs/sync.md#怎么判断谁新账本--混合逻辑时钟)），所以数据本身不需要墓碑和修改时间字段，删除照旧可以真删。只有一条硬要求：

- **每条要同步的记录有稳定的 `id`**，用 `core/storage.ts` 的 `newId`。id 一旦发出去就不能改，改了在别的设备上就是“删了一条、多了一条”。

连接和文件夹的 `deletedAt` 是回收站（界面上能恢复），不是同步用的墓碑。新加一种要同步的数据时，在 `packages/ui/src/core/sync/` 里加一个集合适配器，并在 [sync.md](../specs/sync.md#同步什么) 的表里加一行。

## 导入导出

- **导入**：来源和规则见需求文档 3.4，代码在 `packages/ui/src/core/importers/`。只导入白名单字段，导入的“会执行的东西”要用户确认（[security.md](security.md#红线)）。
- **一键导入**：桌面端去各软件默认存配置的位置读文件，位置表在 `apps/desktop/src-tauri/src/local_import.rs`，前端不能传路径；读到的文件交给同一套解析器。规格见 [docs/specs/one-click-import.md](../specs/one-click-import.md)。
- **导出**：格式名 `evershell-connections`，版本 1，不含密码和私钥（`packages/ui/src/core/importers/export.ts`）。读到更高版本时提示并忽略不认识的字段。
- **要做**：把导出格式写成一份公开的说明文档（字段含义、版本、以后的加密方式），这是“不跑路”承诺的一部分。写在 `docs/` 下，和导出格式一起改。
- **以后**：加密导出（含密码），方案见 [security.md](security.md#加密选型)。

## 同步冲突

2026-10-28 定，全文在 [sync.md](../specs/sync.md#怎么判断谁新账本--混合逻辑时钟)：

- 每条记录整条“后写的赢”，时间戳用混合逻辑时钟（HLC），相同时按设备 id 决胜；不按字段合并，不上通用 CRDT。
- 墓碑永久保留；历史命令、最近连接挤出去的不算删除，「清空」用水位线。
- 服务器只存“账号、集合、记录 id、时间戳、密文”，按服务器给的递增序号增量拉取。
- 两台单机用过的设备，后开同步的那台自动合并，完全相同的重复项只留一份（所有者定，没有冲突预览）。

## 同步多久一次

2026-10-28 定（照 FinalShell 的每 30 秒）：本机一改 1.5 秒后推一次；每 30 秒拉一次；窗口回到前台、网络恢复时立刻一轮。不用 Durable Objects 推送，部署只要 Workers + D1。

额度怎么算、超额怎么办写在 [同步服务分册](sync-service.md#额度)。2026-10-23 算过的“每 3 秒拉一次不够用、改成 WebSocket 通知”的分析：每 30 秒一次时一台设备一天约 2880 次请求，所有者自己几台设备用免费版足够；开放给别人用、请求量上来以后，再考虑换成 Durable Objects 的 WebSocket 通知（空闲不计时长，服务器发出的消息不计费），协议上加一个“有新数据”的通知就行，增量拉取不用改。
