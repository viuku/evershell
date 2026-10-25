# 不需要密码的服务器（SSH none 认证）

> 2026-10-18。内核和界面都已做（所有者选了界面方案 A）。

## 问题

认证方式选“密码”、密码留空的连接，每次连接都弹密码框；服务器允许空密码、或者根本不要认证时也一样。FinalShell 能直接连上。

原因有两层：

1. **内核**：`Connection::connect` 只会密码和私钥两种认证，不先发 none 请求（RFC 4252 5.2 节）。OpenSSH 服务端的 `PermitEmptyPasswords yes` 是在 none 这一步放行空密码账号的（OpenSSH 源码 `auth2-none.c` 的 `userauth_none`），dropbear 的 `-B` 也一样，所以客户端不发 none 就进不去。OpenSSH 客户端和 FinalShell 用的 JSch 每次都先发 none。
2. **界面**：保存连接时密码为空就不存（`packages/ui/src/components/manager/EditConnectionDialog.tsx` 里的 `form.password && form.remember`），连接时 `packages/ui/src/core/connect.ts` 的 `resolveAuth` 找不到保存的密码就弹框；“测试连接”遇到空密码直接报「请填写密码后再测试」。

## 内核（已做）

- 认证前先 `authenticate_none`，成功就不再发密码或私钥。服务器不要认证时，保存过的密码也不会发出去。
- 密码为空、none 又没通过：直接返回 `Error::AuthFailed`，**不发空密码**。主流服务端（OpenSSH、dropbear）的空密码账号都在 none 这一步放行；把空密码发给要密码的服务器，它的日志里会多一条 `Failed password`，fail2ban 的默认规则会算进封禁次数。
- 接口没变：`Auth::Password("")` 就表示“没有密码”。桌面端、`crates/ssh-wasm`、网页端都不用改。
- 代价：每次登录多一个来回（none 请求）。OpenSSH 服务端的第一次 none 请求不计入 `MaxAuthTries`。

放弃的方案：none 没通过时再发一次空密码（JSch 在设了空密码时会这么做）。只对“认 password 方式的空密码、不认 none”的少见服务器有用，代价是上面的失败记录。真遇到再加。

没覆盖：keyboard-interactive 认证（PAM、二次验证）内核还不支持，是另一件事。

### 测试

`crates/ssh-core/tests/shell.rs` 的测试服务器加了：

- `nopass` 账号：像开了 `PermitEmptyPasswords` 的 OpenSSH，在 none 这一步放行；
- `AuthLog`：服务端按顺序记下收到的认证方式（不记密码）。

新测试：空密码直接登录、服务器不要认证时保存的密码不发、空密码不发给要密码的服务器；原来的错密码测试加了“先 none 后 password”的检查。`scripts/test-sshd.sh` 只开了密钥登录，测不了空密码，私钥登录先发 none 由连它的测试覆盖。

## 界面（已做，方案 A）

设计稿：https://claude.ai/artifact/6T9NPaxk947ZBsrvPS8svt 。所有者选了 A（照 FinalShell），并要求不加设计稿里那句密码框占位提示。没选的 B 是在认证方式里加「不需要密码」，要改连接清单的格式。

- `packages/ui/src/core/connect.ts`：`resolveAuth` 没存密码时不再弹框，返回空密码（“不带密码”）；弹框挪到 `askServerPassword`，勾了“记住密码”就存进保险箱。`isAuthFailure` 按内核报错开头的「认证失败」认出认证没通过：Tauri 只传得过来字符串，内核改 `Error::AuthFailed` 的文案要一起改。
- `packages/ui/src/core/session-manager.ts`：不带密码连、认证没通过时，调 `setPasswordPrompt` 挂上的回调要密码，拿到后重连；问的时候标签保持“连接中”，取消就停在「连接已取消」。做法和指纹分支的 `setHostKeyPrompt` 一样。填了密码还认证失败的，照旧报错，不再问。
- `packages/ui/src/App.tsx`：挂上回调。
- 连接编辑框的「测试连接」：密码留空也能测，服务器要密码时提示「服务器要求密码验证，请填写密码后再测试」。
- 假后端：密码留空时只有主机含 `nopass` 能连上，其他主机报认证失败、界面再弹框。
- 单元测试 `packages/ui/src/core/__tests__/connect.test.ts`。会话层的重连靠网页版 `?mock` 验过：不要密码的直接连上；要密码的先“连接中”再弹框，记住密码生效；取消显示「连接已取消」，点重连会再问。
- 网页端没有保险箱，每次连要密码的服务器都会先试一次，弹框前多等一次握手。

## 和指纹分支合并

`claude/dazzling-vaughan-d63a5a` 给 `Connection::connect` 加了 `&ConnectConfig` 参数，没动认证那几行，这里的改动可以直接合。会冲突的是 `crates/ssh-core/tests/shell.rs`：那边改了 `connect` 帮助函数和 `start_server`，这边加了 `connect_as` 和 `start_server_logged`，合并时把参数补上。界面改动和指纹分支都碰了 `session-manager.ts`（`connect` 的 catch 里各加了一个分支、类里各加了一个回调）、`EditConnectionDialog.tsx`（测试连接）、`App.tsx`（挂回调），合并时两边都留。
