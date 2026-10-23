# 数据与迁移

> **管什么**：EverShell 在用户电脑上存了哪些数据、存在哪、什么格式；格式改了怎么迁移；导入导出；以后的同步冲突。
> **什么时候更新**：加了新的存储项、改了任何存储格式、改了导出格式；M2 开工前写“同步冲突”一节。
> **上次复核**：2026-10-18

“数据永远带得走”是产品的核心承诺（[product.md](product.md#产品原则)），所以存储格式是对用户的承诺，不能随手改。依据见调研 [附录 C 第 5 节](../research/2026-10-appendix-c-ssh-client-concerns.md)。

## 本机存了什么

桌面端和网页端的界面数据都经 `packages/ui/src/core/storage.ts` 存在 WebView 的本地存储里（守则 5）。全部清单用 `grep -rn "'evershell\." packages/ui/src apps/web/src` 现查，下表是 2026-10-18 的样子：

| 数据 | 存储键或位置 | 格式版本 | 同步用的字段 |
|---|---|---|---|
| 连接和文件夹 | `evershell.hosts.v1` | 数据里 `version: 1` | 有 id、updatedAt、deletedAt（墓碑） |
| 快捷命令 | `evershell.snippets.v1` | 键名里的 v1 | 有 id、updatedAt，**没有墓碑** |
| 历史命令 | `evershell.history.v1` | 键名里的 v1 | 没有 |
| 最近连接 | `evershell.recents.v1` | 键名里的 v1 | 没有（只是本机记录，可以不同步） |
| 终端外观 | `evershell.terminal-appearance.v1`、背景图 `evershell.terminal-bg-image` | 键名里的 v1 | 没有 |
| 界面状态 | `evershell.appearance-mode`、`evershell.sidebar-open`、`evershell.bottom-height`、`evershell.bottom-open`、`evershell.files.follow`、`evershell.manager.*` | 无 | 本机偏好，不同步 |
| 主机密钥记录 | 桌面端：保险箱条目 `known_hosts`；网页端：`evershell.knownHosts`（`packages/ui/src/core/known-hosts.ts`） | OpenSSH known_hosts 文本格式 | M2 设计 |
| 网页端的中转设置 | `evershell.relay`（`apps/web/src/relay-bar.tsx`） | 无 | 不同步 |
| 网页版 `?mock` 的假保险箱 | `evershell.mock-secrets` | 无 | 只用于预览 |
| 保险箱（桌面端） | 应用数据目录下的 `vault.json`（Mac 上是 `~/Library/Application Support/dev.evershell.desktop/`）；打不开时旧文件改名为 `vault-unreadable-<时间>.json` | 文件头 `version: 1` | M2 设计 |
| 保险箱钥匙 | 系统钥匙串：服务名 `dev.evershell.desktop`，账户 `vault-key` | | 不同步（同步时用主密码另锁一份） |

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

现在连接和文件夹已经齐了；快捷命令缺墓碑，历史命令都没有，下次改到它们时补上（属于格式变化，按上面的规则迁移）。

## 导入导出

- **导入**：来源和规则见需求文档 3.4，代码在 `packages/ui/src/core/importers/`。只导入白名单字段，导入的“会执行的东西”要用户确认（[security.md](security.md#红线)）。
- **导出**：格式名 `evershell-connections`，版本 1，不含密码和私钥（`packages/ui/src/core/importers/export.ts`）。读到更高版本时提示并忽略不认识的字段。
- **要做**：把导出格式写成一份公开的说明文档（字段含义、版本、以后的加密方式），这是“不跑路”承诺的一部分。写在 `docs/` 下，和导出格式一起改。
- **以后**：加密导出（含密码），方案见 [security.md](security.md#加密选型)。

## 同步冲突（M2 开工前写）

占位。调研的建议（附录 C 5.3、5.5），设计时作为起点：

- 逐条记录“最后写入的胜出”，时间用混合逻辑时钟（HLC），相同时用设备编号决胜；墓碑永久保留，否则删掉的连接会“复活”。
- 不上通用的 CRDT：连接、快捷命令都是小记录，按字段合并收益不大。
- 服务器只存“账号、记录编号、时间戳、密文”，按时间戳增量拉取。
- 两台单机用过的设备合并时，要有冲突预览，至少处理“两边都有同名连接”。
