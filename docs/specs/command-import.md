# 快捷命令导入和「不自动回车」

> 2026-10-25。所有者要的：快捷命令加「不自动回车」；FinalShell 和其他常用 SSH 工具的快捷命令能一键导入，和导入连接一样。设计稿：https://claude.ai/artifact/FB653rR7AssV7KPGsUhXgm ，所有者选了方案 A（命令页里单独导入）。已做。

## 问题

- EverShell 的快捷命令点一下就回车执行。FinalShell 每条命令可以设成发送后不回车，用来放要补参数的命令（`kill -9 `、`docker exec -it `）。原样导进来，这些命令一点就执行了。
- 只能导连接，快捷命令要一条条手抄。所有者的 FinalShell 里有 17 个分类、127 条命令，其中 10 条不回车、17 条多行（2026-10-25 只数了结构，没看内容）。

## 不自动回车

- **格式**：命令记录（`evershell.snippets.v1`）加一个可选字段 `noEnter: true`。没有这个字段或为 `false` 就是自动回车，老数据不用迁移，键名不变。
- **发送**：换行照旧统一成回车、去掉首尾空行（`core/commands-panel.ts` 的 `toTerminalInput`）；不自动回车时末尾不补回车。多行命令前面几行照样执行，只有最后一行留在提示符后面等用户按回车。
- **历史命令**：不自动回车的不记进历史，因为没有执行。
- **保存**：换行统一成 `\n`，只去掉开头和末尾多出来的空行。空格按用户输入的原样保存，不加也不删，和回不回车无关：输入的末尾有空格就存空格，没有就不加（所有者 2026-10-26 定；`snippets-store.ts` 的 `tidyCommand`）。导入的命令同样原样保存。以前自动回车的命令会去掉首尾空格，已经存下的数据不动。
- **提示**：「已把「杀进程」放进当前会话，没按回车」；发到全部会话时「已放进 3 个会话，没按回车」。
- **界面**：编辑命令弹窗「命令」下面一个勾选框和一句说明；命令按钮名字后面一个划掉的回车键，悬停提示在命令下面多一行「不自动回车」。
- **降级**：老版本不认识 `noEnter`，这些命令在老版本里点了会直接回车。降级很少见，不另做处理。
- **墓碑**：快捷命令还是没有 `deletedAt`，和分类清单一起留到 M2 设计同步时处理（[command-groups.md](command-groups.md#导出和以后的同步)）。这次只加一个可选字段，不顺带改删除方式：那要升键名版本、写迁移。

## 导入流程

和导入连接一样：选来源 → 选文件 → 预览 → 完成。桌面端打开时先去各软件的默认位置找，找到的来源标「找到 N 条命令」，点「一键导入」直接到预览。

- **入口**：命令页分类那一行右边的「导入…」，命令区的右键菜单里也有「导入快捷命令…」。窗口是 `components/panels/CommandImportDialog.tsx`，样式和导入连接共用 `manager.css` 的 `.imp__*`。
- **默认勾选**：和已有的重复的、有做不到的写法的不勾，其余全勾；切换「放到」时按新的放法重新算一遍。
- **完成后**：命令页切到导入的第一条命令所在的分类。

### 中间结构

各来源的解析器都是纯函数，输出同一种结构，放在 `packages/ui/src/core/importers/commands/`：

```ts
interface ImportedCommand {
  id: string;        // 本次导入里的临时编号
  group: string;     // 分类名；来源的分类能嵌套时拼成「上级 / 下级」，没有分类的给「默认分类」
  name: string;      // 空的用命令第一行代替（和新建命令一样，defaultSnippetName）
  cmd: string;       // 换行统一成 \n
  noEnter: boolean;
  unsupported?: string;  // 有来源专用、EverShell 做不到的写法时写原因，预览里默认不勾
}

interface CommandImportResult {
  source: CommandSource;
  groups: string[];          // 来源里的分类顺序，空分类也在
  commands: ImportedCommand[];
  issues: ImportIssue[];     // 和导入连接共用
  warnings: string[];
}
```

只读白名单字段：名称、命令、分类、顺序、是否回车。来源里的变量、等待、发送到哪个会话这类字段不导入；命令里带来源专用的转义（见下面各来源）时，在预览里提醒，不替用户改写命令。

### 合并

- **分类**，二选一，默认第一个：
  - 保留原来的分类：同名的并进已有分类，没有的按来源顺序加在后面。
  - 都放进一个新分类「从 FinalShell 导入」：已有同名分类就放进去。
- **重复**：放到的分类里已经有内容完全一样的命令（换行统一后比较，空格也算在内），预览里标「已有」，默认跳过，可以改成「保留两份」。名字一样、内容不同的不算重复，两条都留。
- **新记录**：新 `id`，`updatedAt` 为导入时间，`noEnter` 照来源。
- 导入的命令点一下就会发到服务器执行，所以预览里每条都显示完整命令，默认全选，用户看过再点「导入」（[security.md](../handbook/security.md#红线) 第 4 条）。

### 一键导入

- 后端新加 `import_find_local_commands`，位置表和连接的分开写在 `apps/desktop/src-tauri/src/local_import.rs`，前端照旧不能传路径。前端接口 `SshBackend.findLocalCommands?()`，网页端不提供。
- 读文件的上限、跳过隐藏文件和链接的规矩和连接一样（[one-click-import.md](one-click-import.md)）。
- **大配置文件只交出命令那一块**：FinalShell 的 `config.json` 里还存着它自己的密码和私钥列表。后端读出来先解析，只把 `quick_commands` 这一项交给前端，别的不出后端。手动选这个文件时整个文件在界面里读，解析器同样只看这一项，其余什么都不存。

## 各来源

### FinalShell

- **位置**：Mac `~/Library/FinalShell/config.json`；Windows `%LOCALAPPDATA%\finalshell\config.json`（和 `conn` 在同一个目录）。
- **格式**：JSON，顶层 `quick_commands` 是分类数组，每个分类 `{id, name, order, delete_time, commands: [...]}`；每条命令 `{id, name, command, append_cr, order, parent_id, delete_time, param_history, …}`。依据是所有者机器上的 FinalShell 4.6.5（只看了字段名和数量）。
- **对应**：分类和命令按 `order` 排；`delete_time` 大于 0 的跳过（所有者的数据里没有，按字段名推测是已删除）；`append_cr` 为 `false` 的是不自动回车；多行命令用 `\n` 分隔；`param_history` 不导入（所有者的数据里都是空的）。

### SecureCRT（按钮栏）

- **位置**：Mac `~/Library/Application Support/VanDyke/SecureCRT/Config/ButtonBarV5.ini`；Windows `%APPDATA%\VanDyke\Config\ButtonBarV5.ini`，改过配置位置的以「全局选项 → 配置路径」为准。所有按钮栏都在这一个文件里；8.7 起叫 V5，更早版本的文件名不同，不读。
- **格式**：只有 VanDyke 官方的一个样例，没有真实文件对照。每个按钮栏一行 `Z:"<按钮栏名>"=<按钮数，十六进制>`，下面每个按钮一行，以空格开头，逗号分隔：`SEND,<文字>,<按钮名>,,,0,4,`。后面几个字段官方没解释。
- **对应**：按钮栏 → 分类，按钮名 → 名称。只导入功能是 `SEND`（发送文字）的按钮，菜单命令、运行脚本这类跳过、记成问题。文字里的 `\r`、`\n` 是换行，`\t` 是制表符，`\\` 是反斜杠；末尾是回车的自动回车（去掉这个回车），否则不自动回车。
- **拿不准的地方**：官方没说文字里的逗号怎么写，从右往左拆（假定按钮名里没有逗号，剩下的都算文字）；官方样例的反斜杠看不出原文是一个还是两个，两种都认。有用户的真实文件后再校对一遍。
- **做不到的写法**：`\p`（暂停一秒）、`\v`（粘贴剪贴板）、`\b`、`\e`、`\a`、`\c`、`\i`、`\l`、`\m`、`\u` 这些，原样留在命令里给用户看，预览里标「有特殊写法」、默认不勾。
- 依据：[Import a single button bar](https://www.vandyke.com/support/tips/import-a-single-button-bar-into-securecrt.html)、[Command Manager](https://vandyke.com/support/tips/transfer-button-bars-to-the-securecrt-command-manager.html)。命令管理器（8.7 以后）存在哪里查不到，先不导。

### Electerm（导出文件）

- **只导导出文件，没有一键导入**：Electerm 的原始数据在一个数据库文件里，和带密码的书签放在一起，不去读它。用户在 Electerm 的快捷命令设置里点导出，得到 `electerm-quickCommands-<时间>.json`。
- **格式**（依据 Electerm 源码 `quick-command-transport-mod.jsx`、`default-quick-commands.js`、`quick-command-steps.js`，2026-10-25 的 master）：一个数组，每项 `{ id 或 _id, name, commands: [{ command, enter?, delay, type? }], inputOnly, labels: [...], shortcut }`；老格式没有 `commands`，只有一个 `command` 字符串。
- **对应**：`labels` 的第一个是分类，没有就放进「默认分类」，有几个的在提醒里说一句。发送文字的步骤按顺序拼成多行；最后一步的 `enter` 为 `false` 就是不自动回车，没写 `enter` 时看 `inputOnly`（为 `true` 就不回车，和 Electerm 一样）。`delay`、`shortcut` 不导入。
- **做不到的写法**：中间某一步不回车、有按键 / 等待 / 输入框步骤（`type` 是 `key`、`wait`、`prompt`）、命令里有 `{{clipboard}}`、`{{time}}`、`{{date}}` 模板的，标「有特殊写法」、默认不勾。

### 预览里的「有特殊写法」

解析器给这类命令带上原因（`ImportedCommand.unsupported`，一句话），预览里显示标签、默认不勾，用户看过可以自己勾上，导进来的是原样的文字。不替用户改写命令：猜错了更麻烦。

### 先不做

| 软件 | 原因 |
|---|---|
| Xshell | 只有 Windows 版。快速命令集 `.qbl` 只找到零星样例（UTF-16 文本，`Label_N` / `Text_N`），没有官方说明，Xshell 8 又换成了树形的命令管理器。拿到 Xshell 7、8 的真实文件再做 |
| Tabby（装了 quick-cmds 插件的） | 格式清楚（`config.yaml` 的 `qc`），但要加一个读 YAML 的库，属于新依赖，先问所有者 |
| iTerm2 | 格式清楚（`snippets.plist`），但要能读 plist，可能也要新依赖，先问所有者 |
| Termius | 命令存在加密的云端，没有导出 |
| MobaXterm、WindTerm、Royal TSX | 查不到存法 |
| Termora | 存在数据库里，和连接、私钥放在一起；用的人少，以后再说 |

调研的完整记录在这次会话里，结论以本节为准；以后要加来源时重新查一遍再写。

## 对网页、Windows、手机的影响

- 网页端：没有一键导入，手动选文件照常能用；`noEnter` 两端一样。
- Windows：位置表按平台分开写好，到 M6 在 Windows 上实测。
- 手机：命令页还没设计，`noEnter` 是数据里的一个字段，不影响。

## 怎么测

- 单元测试（`packages/ui/src/core/importers/commands/__tests__/`，只用编造的样例文件）：每个来源的解析、合并的两种分类方式和重复判断、已删除的跳过。
- 发送（`packages/ui/src/core/__tests__/commands-panel.test.ts`）：不自动回车时末尾不带回车、不进历史；多行时前面几行带回车。
- 存储：`noEnter` 存得下、读得回，老数据读出来是自动回车；空格原样保存，勾不勾「不自动回车」都一样。
- Rust：`config.json` 交给前端的内容里只有 `quick_commands`，样例里放进去的假密码、假私钥一个字都不出现。
- 网页版 `?mock`：假后端提供 FinalShell 的样例，导入流程、预览、命令页的标记深浅色各看一遍。
- 真机：所有者在正式版里一键导入，对一下 17 个分类、127 条、10 条不自动回车。
