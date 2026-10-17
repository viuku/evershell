# M0 技术验证报告

> 日期：2026-10-17。目标：验证 [需求文档](requirements.md) 第 7 节的技术路线能不能走通，特别是风险最大的“网页版在浏览器里跑 SSH”。
>
> 验证时用的占位名是 ShellDev，下文已统一改成正式名 EverShell。

## 结论

| 验证项 | 结果 |
|---|---|
| Rust SSH 内核（russh）在桌面原生运行 | ✅ 通过 |
| 同一份内核编译成 WASM 在浏览器里运行 | ✅ 通过（需要给 russh 打一个小补丁） |
| 网页 SSH 经自建中转（Node）连服务器 | ✅ 通过 |
| 网页 SSH 经 Cloudflare Workers 中转连服务器 | ✅ 本地模拟通过，尚未部署到真实 Cloudflare |
| Tauri 2 桌面端 + xterm.js | ✅ 能打包、能启动，会话层连真实 OpenSSH 通过；⚠️ 还没在窗口里点界面连过一次 |
| 网页端界面（与桌面端共用） | ✅ 在浏览器里实际连上本机 OpenSSH，敲命令、中文、颜色、vi、调整窗口都正常 |

**技术路线可以定稿**：Tauri 2 + React + Rust 内核，网页版用 WASM 内核 + 只转发字节的中转。密码和私钥不经过中转。

## 架构（M0 实际跑通的样子）

```
桌面端：  React 界面 ──Tauri IPC──▶ Rust（ssh-core）──TCP──────────────────────▶ SSH 服务器
网页端：  React 界面 ──▶ WASM（同一个 ssh-core）──WebSocket──▶ 中转 ──TCP──▶ SSH 服务器
                                                            （Node 或 Workers，只搬字节）
```

| 目录 | 内容 |
|---|---|
| `crates/ssh-core` | SSH 内核：握手、认证（密码 / Ed25519 / RSA）、PTY、收发、调整窗口。只依赖一条字节流，不关心来源 |
| `crates/ssh-wasm` | 把 ssh-core 包装成浏览器可调用的 `WebShell` 类 |
| `services/relay-node` | 自建中转（Node + ws），以后放进 Docker 镜像 |
| `services/relay-worker` | Cloudflare Workers 中转，协议与 Node 版完全相同 |
| `packages/ui` | 桌面端和网页端共用的 React 界面 |
| `apps/desktop` | Tauri 2 桌面应用 |
| `apps/web` | 网页应用 |
| `vendor/russh` | 打了补丁的 russh 0.64.1，见 `vendor/README.md` |

## 测试结果

### SSH 内核（`cargo test -p ssh-core`）

- 用 russh 自带的服务端起回显 shell：密码登录、错误密码报“认证失败”、Ed25519 和 RSA 私钥登录、PTY 尺寸、窗口调整、退出码，全部通过。
- 连本机真实 OpenSSH 10.3（临时 sshd，127.0.0.1:2222，只开密钥登录）：登录、执行命令、PTY 24×80，通过。

### 网页链路（`scripts/e2e-web-ssh.mjs`，Node 22 里加载 WASM，不需要浏览器）

| 项目 | Node 中转 | Workers 中转（本地） |
|---|---|---|
| 建立连接（含握手和认证） | 46ms | 48ms |
| PTY 尺寸、resize | ✅ | ✅ |
| 50 次连续按键顺序 | ✅ | ✅ |
| 2MB 流式输出 | 65ms | 82ms |
| 退出码 | ✅ | ✅ |
| 错误令牌 | 拒绝 | 拒绝 |
| 目标不可达 | 返回原因 | 返回原因 |

以上都是本机回环网络上的数字，只能说明链路本身没有额外瓶颈，不代表真实网络下的延迟。

WASM 包体积：2.4MB，gzip 后 0.6MB。

## 踩到的坑和处理方式

1. **aws-lc-rs 编不出 WASM**：russh 的加密后端统一改用 ring（桌面端也用 ring，两边一致）。
2. **ring 的 C 代码在 macOS 上编 WASM 时缺符号**：macOS 自带的 `ar` 不认 WASM 目标文件。改用 Rust 自带的 llvm-ar，已固定在 `.cargo/config.toml` + `scripts/llvm-ar`，前提是装了 `rustup component add llvm-tools`。
3. **随机数**：ring 用 getrandom 0.2、russh 用 0.3，两个版本都要打开浏览器后端。
4. **russh 的定时器在浏览器里 panic**：russh 直接调用 `tokio::time::sleep`，而 tokio 的计时依赖 `std::time::Instant`，wasm32 上没有实现。russh 主干也还没修。在 `vendor/russh` 打了补丁：原生平台不变，WASM 下改用浏览器的 setTimeout，改了 6 处。**建议给 russh 上游提 PR**，合并后就能去掉 vendor。
5. **浏览器 WebSocket 不能跨线程（不是 `Send`）**：russh 要求字节流是 `Send` 的。中间放一个内存管道桥接，两头各用一个任务搬运数据。
6. **按键顺序**：界面里每次按键都是一次独立的异步调用，可能乱序。桌面端和网页端都改成每个会话一个写入队列，顺序执行。
7. **Workers 收到的二进制消息是 Blob**：新的兼容日期下 WebSocket 默认 `binaryType` 是 blob，`new Uint8Array(blob)` 得到空数组，客户端发出的数据全丢。显式设置 `binaryType = 'arraybuffer'` 后正常。
8. **wrangler dev 的日志噪音**：每次连接结束会打印一条 “Network connection lost”。已确认不是我们代码里的未处理异常（全局监听器没触发），像是本地开发代理打印的。部署到真实 Cloudflare 后再看。

## 桌面端

- Tauri 2.12 稳定版，界面用共用的 `packages/ui`，Tauri 专属代码只在 `apps/desktop`。
- 数据通路：按键以原始字节作为请求体发给 Rust（不转 JSON 数组）；远端输出通过 Tauri Channel 以 ArrayBuffer 推回前端；退出事件走同一条 Channel，保证不会抢在最后一段输出之前。
- 按键顺序：前端把 invoke 串成一条链，Rust 端每个会话一个队列，两层都保证顺序。
- 测试（`cargo test -p evershell-desktop`）：经会话管理层连本机真实 OpenSSH，登录、指纹、执行命令、50 次逐字节连续写入顺序正确、调整窗口、关闭后收到退出事件；连接失败时中文错误原样传到界面。全部通过。
- `npx tauri build --debug --bundles app` 能打出 `EverShell.app`，启动后窗口正常渲染。debug 包 48MB，release 包体积还没量。
- **没验证到的一环**：还没有在真实窗口里从界面输入、点连接、连上 SSH。自动化工具往这个窗口后台发按键会丢键，全屏操作的授权又没有人响应，所以没测成。会话层和 IPC 两头都单独验证过，但两头之间的 Tauri IPC 只核对过源码，没有实际跑过。**请你在打开的 EverShell 窗口里连一次自己的服务器。**

## 网页端

在内置浏览器里打开网页版，经 Node 中转连本机 OpenSSH（私钥登录），实测：

- 登录后显示 macOS 的登录信息和 shell 提示符，状态栏显示服务器指纹。
- 中文输出、ANSI 颜色、`ls` 输出正常。
- 浏览器窗口从窄变宽，终端从 68 列变成 122 列 × 41 行，`stty size` 同步；vi 全屏显示正确。
- 令牌错误：提示“无法连接中转：地址不对、中转没启动，或令牌错误”（原来只有一句“代码 1006”，实测后改了）。
- 密码错误：提示“认证失败：用户名、密码或私钥不正确”。
- 构建产物：JS 573KB（gzip 160KB）+ WASM 2.4MB（gzip 600KB）。

## 留给后续里程碑的事

- **服务器指纹校验**：目前接受任何服务器公钥，只记录指纹。M1 要做 known_hosts 校验和首次连接确认。
- **中转鉴权**：现在是放在 URL 里的固定令牌，只适合自己用。M2 换成账号登录后签发的短期票据。
- **中转可被用来访问内网**：持有令牌就能连中转所在网络里的任意地址。自建版应提供目标白名单或默认禁止内网地址。
- **Workers 未真实部署**：生产环境的限制（不能连 Cloudflare 自家 IP、25 端口被封、连接时长）还没实测。部署会用到你的 Cloudflare 账号，需要你点头。
- **密码登录只在测试服务端验证过**：本机临时 sshd 不是 root，只能用密钥。真实服务器上的密码登录和二次验证（keyboard-interactive，尚未实现）留到 M1 用你的服务器测。
- **Windows 未验证**：llvm-ar 包装脚本是 sh 写的，Windows 开发机需要另配。
- **前端包偏大**：xterm 让 JS 包超过 500KB，之后按需拆分加载。
- **Node 中转默认监听所有网卡**：部署到服务器时符合预期，本机开发时可以加一个只监听本机的选项。

## 怎么在本机复现

```bash
# 1. 内核测试
cargo test -p ssh-core

# 2. 构建网页端 WASM 内核
./scripts/build-wasm.sh

# 3. 起中转（二选一）
RELAY_TOKEN=dev-token node services/relay-node/server.mjs              # 自建版，端口 8787
cd services/relay-worker && npx wrangler dev --local --port 8788        # Workers 版，令牌在 .dev.vars

# 4. 界面
npm install
npm run dev -w @evershell/web                                          # 网页版，http://localhost:5173
npm run tauri -w @evershell/desktop -- dev                             # 桌面版

# 5. 无界面端到端测试
RELAY=ws://127.0.0.1:8787 RELAY_TOKEN=dev-token TARGET=<主机>:<端口> \
SSH_USER=<用户名> SSH_KEY=<私钥路径> node scripts/e2e-web-ssh.mjs
```
