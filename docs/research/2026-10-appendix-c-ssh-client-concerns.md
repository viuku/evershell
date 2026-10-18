# 附录 C：SSH 客户端这类软件特有的重点，业界怎么做

> 调研日期：2026-10-18。用途：给 EverShell 定“工程规范体系”收集依据。只调研，没改仓库。
>
> 标注约定：
> - 每条结论后面是来源链接。优先官方文档、RFC、OWASP、OpenSSH 发布说明、项目自己的文档。
> - **[待核实]**：没找到一手来源，或者一手来源和二手来源对不上。
> - **[本仓库]**：从 `/Users/kairos/Developer/Evershell` 的代码里直接读到的现状（2026-10-18 工作区，含未提交改动）。
> - **[本地源码]**：从本机 `~/.cargo/registry`、`node_modules`、`vendor/` 里的依赖源码直接读到的。

## 0. 现状快照（和后面各节有关的部分）

| 项目 | 现状 | 位置 |
|---|---|---|
| 主机指纹 | `check_server_key` 一律返回 `true`，只记录 SHA256 指纹，注释写着 `TODO(M1)` | `crates/ssh-core/src/lib.rs:78` [本仓库] |
| russh 配置 | `client::Config::default()`：不发 keepalive（`keepalive_interval: None`）、`inactivity_timeout: None`、通道窗口 2MB | `crates/ssh-core/src/lib.rs:104`；默认值见 `vendor/russh/src/client/mod.rs:2670` [本仓库] |
| TCP | 桌面直连时 `set_nodelay(true)`（russh 默认是开 Nagle 的） | `crates/ssh-core/src/lib.rs:256` [本仓库] |
| russh 版本 | vendor 里是 0.64.1（crates.io 当前最新，2026-10-05 发布），打了 wasm 定时器和 CHANNEL_CLOSE 两处补丁 | `vendor/README.md`；[crates.io 版本列表](https://crates.io/crates/russh/versions) |
| russh 特性 | `default-features = false, features = ["ring", "rsa", "flate2"]`：没开 `des`（3des-cbc）、没开 `dsa` | 根 `Cargo.toml` [本仓库] |
| 保险箱 | XChaCha20-Poly1305（RustCrypto `chacha20poly1305` 0.11），每条单独加密，随机 24 字节 nonce，AAD = `evershell-vault/v1/entry/<id>`，文件带 `version: 1`，读到更新版本直接拒绝 | `crates/vault/src/lib.rs` [本仓库] |
| 钥匙串 | `keyring` 4.2，默认特性 `v1` → `apple-native-keyring-store/keychain`（老的文件式钥匙串），没开 `protected`（数据保护钥匙串） | `apps/desktop/src-tauri/Cargo.toml`；`keyring-4.2.0/Cargo.toml` [本地源码] |
| 终端输出通路 | Rust 侧 `mpsc::unbounded_channel` 收 shell 输出 → Tauri Channel → `term.write(data)`，**没有回压** | `crates/ssh-core/src/lib.rs` `open_shell`；`apps/desktop/src-tauri/src/session.rs:77`；`packages/ui/src/core/session-manager.ts:362` [本仓库] |
| xterm.js | `@xterm/xterm` 6.0.0，只装了 `addon-fit`（没装 webgl、unicode11、clipboard），`scrollback: 5000`，TERM 固定 `xterm-256color` | `packages/ui/package.json`；`session-manager.ts:164`；`session.rs:73` [本仓库] |
| 监控采集 | 一条命令：`env LC_ALL=C sh -c "... ps -eo rss=,pcpu=,comm= ..."`，读 `/proc/*` | `crates/ssh-core/src/monitor.rs:16` [本仓库] |
| SFTP 上传 | `WRITE | CREATE | TRUNCATE` 直接写目标文件；下载按偏移并发读；用了 `limits@openssh.com` | `crates/ssh-core/src/sftp.rs` [本仓库] |
| 中转 | Node 版：URL 里带固定令牌，`target` 任意 host:port，没有目标限制；有 1MB 高水位回压 | `services/relay-node/server.mjs` [本仓库] |
| 日志 | `env_logger` 默认 `info`；会打印 `host:port`；`Auth` 类型没派生 `Debug`（好）；密码是普通 `String`，没清零 | `apps/desktop/src-tauri/src/lib.rs:11`、`session.rs:124`、`ssh-core/src/lib.rs:39` [本仓库] |
| 本地数据版本 | 保险箱 `version: 1`；连接数据 `version: 1`；导出文件 `EXPORT_VERSION = 1`，读到更新版本时警告并忽略未知字段 | `hosts-store.ts:59`、`importers/export.ts:7`、`importers/evershell.ts:63` [本仓库] |

---

## 1. 安全

EverShell 保管的是“能登录别人服务器的东西”，安全是第一位的。

### 1.1 威胁模型怎么写

**业界通用写法：四个问题 + STRIDE + 数据流图。**

- OWASP 的威胁建模四问：我们在做什么（画数据流图）→ 会出什么错（常用 STRIDE 列威胁）→ 打算怎么办（缓解 / 消除 / 转移 / 接受）→ 做得够不够（所有人复核，缓解措施要能测）。来源：[OWASP Threat Modeling Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html)
- STRIDE 六类和各自破坏的性质：仿冒→认证，篡改→完整性，抵赖→可追责，信息泄露→机密性，拒绝服务→可用性，提权→授权。同上来源。
- 数据流图要画出数据流、数据存储、进程、外部实体和**信任边界**，信任边界是最可能被攻击的地方。威胁模型是活文档，架构或缓解决策变了就要更新。同上来源。
- Tauri 自己的安全模型把信任边界画在“WebView 前端（受限）”和“Rust 核心（全权限）”之间，IPC 是唯一桥梁，跨边界的数据都要严格定义和校验。来源：[Tauri Security](https://v2.tauri.app/security/)

**这类软件的典型资产（按 EverShell 的数据整理）：**

| 资产 | 价值 | 现在放哪 |
|---|---|---|
| 服务器密码、私钥、私钥口令 | 最高：直接登录服务器 | 保险箱 `vault.json`（加密） |
| 保险箱钥匙 | 等于全部机密 | macOS 钥匙串 |
| 主密码 / 派生密钥（M2） | 等于全部同步数据 | 只在内存里 |
| 连接清单（主机名、IP、端口、用户名、分组） | 高：攻击目标地图，本身就是敏感元数据 | 本地存储，明文 |
| known_hosts（M1 要做） | 完整性要求高：被篡改等于允许中间人 | 待定 |
| 快捷命令、历史命令、会话日志（M5） | 常常夹带密码、令牌 | 待定 |
| 中转令牌 / 同步账号凭据 | 能冒用中转或下载密文 | URL 参数里（M0） |
| 发布签名私钥、更新签名私钥 | 能给所有用户推恶意版本 | 开发机 / CI |

**典型攻击者（题目要求的六类，加上两类这类软件特有的）：**

| 攻击者 | 能做什么 | 业界参照 |
|---|---|---|
| 同机恶意软件（同一用户权限） | 读应用数据目录、读剪贴板、注入进程、冒充本应用去读钥匙串 | 见 1.2 的钥匙串说明 |
| 电脑丢失 / 被盗 | 离线读磁盘（没开 FileVault 时） | 需求文档 3.5 已分析 |
| 备份泄露（Time Machine、iCloud Drive、拷贝的配置目录） | 拿到 `vault.json` 和连接清单 | FinalShell 固定钥匙的教训 |
| 被攻破的同步服务器 | 读 / 改 / 删 / 回滚密文，看元数据，冒充服务器给客户端下发数据 | Bitwarden、1Password 的服务器不可信设计（1.2） |
| 恶意或被滥用的中转 | 开放代理、扫内网（SSRF）、看流量元数据；拿不到 SSH 明文 | OWASP SSRF（1.6.5） |
| 供应链投毒 | npm / crates 包、GitHub Actions、构建机 | Shai-Hulud、tj-actions、xz（1.5） |
| **恶意或被攻破的 SSH 服务器**（这类软件特有） | 发终端转义序列（读剪贴板、伪造标题、超链接钓鱼）、发畸形协议包打崩客户端、借 agent 转发用你的私钥、给 SFTP 返回恶意文件名 | CVE-2016-0777、CVE-2023-38408、russh 2026 年的客户端漏洞（1.6） |
| **网络中间人**（这类软件特有） | 首次连接冒充服务器（TOFU 的固有弱点）、Terrapin 降级 | 1.6.1、1.6.3 |
| WebView 里的恶意脚本（XSS、恶意依赖） | 通过 IPC 调 Rust 命令读机密、发按键 | Tauri 安全模型 |

### 1.2 同类产品怎么存机密、怎么做端到端加密

| 产品 | 本地 / 同步加密 | 钥匙怎么来 | 可借鉴 | 来源 |
|---|---|---|---|---|
| **Termius** | libsodium 1.0.20：`crypto_box`（X25519 + XSalsa20 + Poly1305）、`crypto_secretbox`（XSalsa20-Poly1305）；口令哈希 `crypto_pwhash` + ARGON2ID13，参数是 `OPSLIMIT/MEMLIMIT_INTERACTIVE` | 注册时生成随机密钥对，私钥用“加密密码”锁住后同步；登录用改过的 SRP6a（Botan 3.2.0），密码和密码哈希都不上网 | 团队保险箱：每个 vault 一把钥匙，用成员公钥分别加密；同步范围包括 known hosts | [Termius Encryption overview](https://docs.termius.com/security/encryption-overview)；[Termius Security](https://www.termius.com/security)（vault 包含 Known Hosts 来自检索摘要 [待核实具体页面]） |
| **Tabby** | AES-256-CBC，钥匙由口令经 PBKDF2-SHA512 派生，64 位盐；vault 存在 YAML 配置里 | 用户口令 | 反面参照：CBC 无认证，wiki 里没提 MAC；迭代次数没写。文档是 2021 年的 | [Tabby wiki: Vault Encryption](https://github.com/Eugeny/tabby/wiki/Vault-Encryption) [待核实当前代码] |
| **Bitwarden** | 主密码 →（PBKDF2-SHA256 默认 600,000 次，或 Argon2id 默认 32 MiB / 6 次 / 4 线程）→ 256 位 Master Key → HKDF 扩成 512 位 → 解开随机生成的 512 位 User Symmetric Key；每个条目还有自己随机的 64 字节 Cipher Key | 主密码；服务器只收“主密码哈希”，再用 PBKDF2 60 万次加盐哈希一遍才存 | 分层钥匙（换主密码不重加密数据）；每条目单独钥匙；认证凭据和加密钥匙分开派生；可选轮换用户钥匙 | [Bitwarden Security Whitepaper](https://bitwarden.com/help/bitwarden-security-white-paper/)；[KDF Algorithms](https://bitwarden.com/help/kdf-algorithms/) |
| **1Password** | AES-256-GCM；钥匙集（keyset）层层包裹 | 2SKD：账号密码经 PBKDF2-HMAC-SHA256 **650,000 次**，再和 Secret Key（HKDF，以账号 ID 为盐）的结果 XOR，得到 AUK；认证走 SRP（4096 位群） | Secret Key 让服务器上的数据无法离线爆破；白皮书 0.5.2（2026-03-05） | [1Password Security Design: Key derivation](https://agilebits.github.io/security-design/deepKeys.html)；[白皮书目录](https://agilebits.github.io/security-design/)；[How we use SRP](https://1password.com/blog/developers-how-we-use-srp-and-you-can-too) |
| **KeePass / KeePassXC（KDBX 4）** | 文件加密 AES-256 / ChaCha20（RFC 8439）/ Twofish；头部 HMAC-SHA-256；数据按 1MB 分块，每块单独 HMAC（先加密后认证），先验后解 | 主密码 + 可选密钥文件 / YubiKey 挑战应答，KDF 为 Argon2（KDBX 4） | 先认证再解密；格式自带版本号；KeePassXC 文档推荐 Argon2id 防时序攻击。新库默认 KDF 和参数没找到一手来源 | [KeePass: KDBX 4](https://keepass.info/help/kb/kdbx_4.html)；[KeePassXC docs](https://keepassxc.org/docs/)；[KeePassXC issue #10558](https://github.com/keepassxreboot/keepassxc/issues/10558) [默认参数待核实] |
| **Standard Notes（协议 004）** | XChaCha20-Poly1305，256 位钥匙，192 位 nonce；密文格式 `004:nonce:ciphertext:aad`；AAD 含条目 uuid 和协议版本 | Argon2id（64 MiB、5 次、1 并行），输出 512 位：前一半是 masterKey（加密用），后一半是 serverPassword（认证用）；items key 随机生成并用 masterKey 加密；每个条目再有随机 item_key | **和 EverShell 选的算法完全一样**，最值得照抄：一次派生拆成“加密钥匙”和“服务器认证密码”；密文自带版本前缀；AAD 绑定 uuid | [Standard Notes Encryption](https://standardnotes.com/help/security/encryption) |
| **Atuin**（Rust、可自建、端到端加密的 shell 历史同步） | 老方案 NaCl secretbox（XSalsa20-Poly1305，随机 192 位 IV，一把钥匙加密所有记录）；新方案 PASETO v4 local（XChaCha20 + BLAKE2b）+ PASERK 钥匙包裹：每条记录随机一把内容钥匙，用主钥匙包裹后跟数据一起存 | 注册时生成随机钥匙存本地，新机器登录要输密码**和钥匙**（钥匙不是从密码派生的）；丢钥匙无法恢复 | 作者的教训：别自创密码学构造、用标准；**一开始就规划钥匙轮换和泄露**（老方案钥匙泄露只能新建账号）；`store verify / rekey / purge` 命令 | [Atuin's new encryption scheme](https://blog.atuin.sh/new-encryption/)；[Atuin store 文档](https://docs.atuin.sh/main/reference/store/)；[Setting up Sync](https://docs.atuin.sh/latest/guide/sync/) |

**系统钥匙串（同机恶意软件这一项）：**

- Apple 建议新代码默认用**数据保护钥匙串**（`kSecUseDataProtectionKeychain`）；文件式钥匙串“正走向弃用”，访问控制是按代码签名的 ACL；数据保护钥匙串用钥匙串访问组（来自签名权限，需要描述文件授权），可加 `SecAccessControl`（比如要求生物识别）。来源：[Apple TN3137: On Mac keychain APIs and implementations](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)
- EverShell 现在用的 `keyring` 4 默认是文件式钥匙串 [本地源码]。需求文档 3.5 说的“以后开 Touch ID”要走数据保护钥匙串 + `SecAccessControl`，到时要换 `keyring` 的 `protected` 特性或直接调 Security 框架，并且需要带权限签名 [推论]。

### 1.3 加密选型的依据

**XChaCha20-Poly1305 vs AES-GCM：关键在 nonce 长度。**

- XChaCha20 的 nonce 是 192 位，用安全随机数每条消息随机生成就行，约 2^96 条消息才有 50% 概率撞一次。来源：[draft-arciszewski-xchacha](https://datatracker.ietf.org/doc/html/draft-arciszewski-xchacha)（这是过期草案，没成为 RFC）
- libsodium 的 AEAD 文档里，只有 XChaCha20-Poly1305 被列为“可以放心用随机 nonce”的选项；AES-256-GCM 要用计数器式 nonce。来源：[libsodium AEAD](https://libsodium.gitbook.io/doc/secret-key_cryptography/aead)
- AES-GCM（96 位 nonce）用随机 IV 时，NIST SP 800-38D 第 8.3 节把同一把钥匙的加密次数限制在 2^32 次。来源：[NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final)；引用原文的邮件 [openssl-users 2016-05](https://mta.openssl.org/pipermail/openssl-users/2016-May/003793.html)。另有 AWS 讲稿给出不同解读，[待核实原文附录 B]。
- EverShell 用的 RustCrypto `chacha20poly1305` 接受过 NCC Group 的一次审计（MobileCoin 出资，2020 年 2 月），没有重大发现；README 说所有实现按常数时间设计。来源：[NCC Group 公开报告](https://www.nccgroup.com/research/public-report-rustcrypto-aesgcm-and-chacha20pluspoly1305-implementation-review/)；[RustCrypto chacha20poly1305 README](https://github.com/RustCrypto/AEADs/tree/master/chacha20poly1305)。审计的是哪个版本没写，0.11 是否在审计范围内 [待核实]。
- ring 的 AEAD 只有 96 位 nonce 的 ChaCha20-Poly1305 和 AES-GCM，没有 XChaCha [待核实，凭记忆]，所以保险箱用 RustCrypto 是对的；这也意味着加密库有两套（russh 走 ring，保险箱走 RustCrypto），依赖审计要两边都盯。

**Argon2id 参数：**

| 来源 | 参数 | 说明 |
|---|---|---|
| RFC 9106 第一推荐 | t=1，p=4，m=2 GiB，盐 128 位，输出 256 位 | 默认就选 Argon2id。来源：[RFC 9106 §4](https://www.rfc-editor.org/rfc/rfc9106.html) |
| RFC 9106 第二推荐（内存受限时） | t=3，p=4，m=64 MiB | 同上 |
| OWASP 最低配置（几种等价） | m=46 MiB/t=1，m=19 MiB/t=2，m=12 MiB/t=3，m=9 MiB/t=4，m=7 MiB/t=5，都是 p=1 | 是“服务器存用户密码”的最低线；PBKDF2-HMAC-SHA256 要 60 万次。来源：[OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) |
| Bitwarden 默认 | 32 MiB，6 次，4 线程 | 超过 64 MiB 时 iOS 自动填充会告警。来源：[Bitwarden KDF](https://bitwarden.com/help/kdf-algorithms/) |
| Standard Notes 004 | 64 MiB，5 次，1 并行 | 来源见 1.2 |
| Termius | libsodium `INTERACTIVE` 档 | 来源见 1.2；具体数值没写 |

要点：主密码派生是**客户端**做的，攻击者拿到的是密文，只能离线爆破，所以参数要往“客户端能忍受的最慢”调，而不是 OWASP 的最低线。手机和浏览器（WASM）内存有限，要在最弱的目标设备上实测 [推论]。参数必须和盐一起存进数据，以后才能升级。

**分层钥匙的常见做法（Bitwarden、1Password、Standard Notes、Atuin 都这么做）：**

1. 密码只用来派生“钥匙加密钥匙”（KEK），真正加密数据的是随机生成的数据钥匙；换密码只重新包一下数据钥匙。EverShell 需求文档 3.5 / 4 节已经是这个思路。
2. 同一次派生拆成“加密用”和“认证用”两半（Standard Notes 的 masterKey / serverPassword，Bitwarden 的 Master Key / 主密码哈希），**服务器永远拿不到加密用的那一半**；服务器端还要对收到的认证凭据再慢哈希一次（Bitwarden 60 万次 PBKDF2）。1Password 和 Termius 更进一步用 SRP，连认证凭据都不传。
3. 不同用途用 HKDF（[RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)）带不同 info 派生子钥匙，做域分离。
4. 密文自带格式版本前缀（Standard Notes 的 `004:`），AAD 绑定条目 id 和版本，防止密文被挪用、防止降级。EverShell 保险箱的 AAD 已经这么做了 [本仓库]。
5. 规划轮换：Bitwarden 可以在改主密码时轮换用户钥匙并重加密所有条目钥匙；Atuin 新方案为了轮换方便改成每条记录单独钥匙。

### 1.4 日志不许漏机密

- OWASP 列出通常不能直接写进日志的数据：会话标识、访问令牌、认证密码、数据库连接串、加密钥匙和其他主要机密、敏感个人数据、超出日志系统密级的数据等；应当删除、打码、哈希或加密后再记。会话 ID 需要追踪时记哈希值。来源：[OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- 同一来源要求对所有事件数据做清洗防日志注入（CR、LF、分隔符）。SSH 客户端的特殊点：服务器返回的 banner、错误信息、文件名都是不可信输入，写日志前要转义。
- 本仓库现状：`Auth` 没派生 `Debug`，russh 的 trace 日志只记包长度不记内容 [本地源码 `vendor/russh/src/client/encrypted.rs:83`]，目前没看到泄露点；但 info 级别会记 `host:port`（属于敏感元数据，见 1.1），会话内容、按键绝不能进日志。

### 1.5 依赖审计、供应链和漏洞披露

**工具：**

| 工具 | 做什么 | 来源 |
|---|---|---|
| RustSec 漏洞库 | Rust 安全工作组维护；cargo-audit、cargo-deny、cargo-auditable、OSV、Trivy、GitHub Advisory Database（Dependabot 用它）都消费这份数据 | [rustsec.org](https://rustsec.org/) |
| cargo-audit | 用 `Cargo.lock` 对照 RustSec | 同上 |
| cargo-deny | 四类检查：licenses（许可证）、bans（禁用 crate、重复版本）、advisories（漏洞、无人维护、被撤回）、sources（来源） | [cargo-deny checks](https://embarkstudios.github.io/cargo-deny/checks/index.html) |
| npm audit | 对照注册表报漏洞；`--audit-level` 只改失败阈值；`npm audit signatures` 校验注册表签名和来源证明 | [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit) |
| Dependabot | 支持 Cargo、npm、GitHub Actions 的版本更新和安全更新；**Cargo 的 vendoring 不支持** | [Dependabot supported ecosystems](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories) |
| OpenSSF Scorecard | 检查项包括 Security-Policy（SECURITY.md）、Pinned-Dependencies、Dangerous-Workflow、Token-Permissions、Signed-Releases、Dependency-Update-Tool、Vulnerabilities（OSV）、Branch-Protection、Code-Review、Fuzzing、SAST、SBOM 等 | [Scorecard checks](https://github.com/ossf/scorecard/blob/main/docs/checks.md) |

**vendor 里的 russh 会不会被漏查？** 读了 rustsec 的查询代码：`crate_scope()` 不按来源过滤；`Cargo.lock` 里没有 `source` 的路径依赖不会被排除，按名字和版本照样匹配 crates.io 的公告。来源：[rustsec query.rs](https://github.com/rustsec/rustsec/blob/main/rustsec/src/database/query.rs)。本仓库 `Cargo.lock` 里 russh 确实没有 `source` 行 [本仓库]。结论：cargo-audit 能查到 vendor 版 russh 的公告 [推论，没实跑，cargo-audit 本机没装]；但 Dependabot 不会帮你升级 vendor 里的副本。

**供应链近年的真实事件（威胁模型里要写）：**

- npm “Shai-Hulud” 蠕虫：CISA 2025-09-23 告警，500 多个包被投毒，偷 GitHub PAT 和云服务密钥，借被盗的维护者凭据自我传播；建议审查锁文件、轮换凭据、启用防钓鱼 MFA。来源：[CISA Alert](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem)
- GitHub Action `tj-actions/changed-files`（CVE-2025-30066）：2025-03 标签被改指向恶意提交，把 CI 机密打进日志；**按提交 SHA 固定 Action 的用户不受影响**。来源：[SentinelOne CVE-2025-30066](https://www.sentinelone.com/vulnerability-database/cve-2025-30066)（二手，[待核实 GitHub 官方公告]）
- xz/liblzma 后门（CVE-2024-3094，CVSS 10）：5.6.0、5.6.1 被植入，经 systemd 干扰 sshd 认证。来源：[CERT-EU 2024-032](https://cert.europa.eu/publications/security-advisories/2024-032/)
- Tauri 更新器强制签名，不能关；私钥丢了就再也发不了更新，泄露了就能给所有用户推包。来源：[Tauri Updater](https://v2.tauri.app/plugin/updater/)

**漏洞披露：**

- GitHub 公开仓库的所有者 / 管理员可以开“私密漏洞报告”（Settings → Advanced Security → Private vulnerability reporting），还能在 `.github/VULNERABILITY_REPORT.yml` 定制表单。来源：[GitHub Docs](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository)
- Scorecard 的 Security-Policy 项检查 `SECURITY.md`。来源见上表。
- Tauri 自己的做法：私下通过 GitHub Security Advisories 或 security@tauri.app 报告。来源：[Tauri Security](https://v2.tauri.app/security/)

### 1.6 SSH 特有的安全点

#### 1.6.1 主机指纹校验（known_hosts、首次信任）

- `StrictHostKeyChecking` 默认 `ask`；`accept-new` 自动记新主机但拒绝指纹变了的主机；`yes` 永不自动添加；`no` 连指纹变了都放行。来源：[ssh_config(5)](https://man.openbsd.org/ssh_config)
- `UpdateHostKeys`：服务器在认证后告诉客户端自己所有的主机公钥（协议扩展 `hostkeys-00@openssh.com` / `hostkeys-prove-00@openssh.com`），只有主机已经通过 known_hosts 验证过才接受新增的钥匙；OpenSSH 8.5 起默认开。来源：[ssh_config(5)](https://man.openbsd.org/ssh_config)；[OpenSSH PROTOCOL](https://cvsweb.openbsd.org/src/usr.bin/ssh/PROTOCOL)；[8.5 发布说明](https://www.openssh.org/releasenotes.html)
- `HashKnownHosts`：文件泄露时不暴露主机名（默认 `no`）。来源：[ssh_config(5)](https://man.openbsd.org/ssh_config)
- known_hosts 格式：可选标记 `@cert-authority` / `@revoked`、主机名（`|1|` 开头为哈希）、非标准端口写 `[host]:port`、通配符 `*?`、`!` 取反。导入用户的 `~/.ssh/known_hosts` 要能解析这些。来源：[sshd(8) SSH_KNOWN_HOSTS FILE FORMAT](https://man.openbsd.org/sshd.8)
- `VerifyHostKeyDNS`（SSHFP 记录）：默认 `no`；OpenSSH 10.2 预告将弃用 SHA1 的 SSHFP 记录。来源：[ssh_config(5)](https://man.openbsd.org/ssh_config)；[发布说明](https://www.openssh.org/releasenotes.html)
- Termius 把 known hosts 放进端到端加密的 vault 跟着同步（见 1.2）。

#### 1.6.2 agent 转发

- `ForwardAgent` 官方警告：要谨慎开启；能绕过远端文件权限的人可以通过转发的连接使用本地 agent；拿不走私钥，但能用私钥签名。来源：[ssh_config(5)](https://man.openbsd.org/ssh_config)
- CVE-2023-38408：ssh-agent 的 PKCS#11 搜索路径不可信，agent 被转发到攻击者控制的机器时可远程执行代码；9.3p2 修复，默认拒绝远程加载 PKCS#11 模块；**用别的工具转发 agent socket 可能绕过这个检查**。来源：[OpenSSH 9.3p2 发布说明](https://www.openssh.com/txt/release-9.3p2)
- 对 EverShell 的意义：如果以后做 agent 转发，EverShell 自己就是“别的工具”，要么默认关、按主机单独开，要么自己实现 agent 并对每次签名请求弹确认 [推论]。

#### 1.6.3 Terrapin（CVE-2023-48795）

- 前缀截断攻击：中间人在握手时操纵序列号，悄悄删掉加密通道开头的消息；受影响的是 `chacha20-poly1305@openssh.com` 和任何 `-cbc` 配 `-etm@openssh.com` MAC；能剥掉 EXT_INFO（RFC 8308）降级 RSA 公钥认证、关掉 OpenSSH 9.5 的击键时序混淆。对策是“strict kex”，**双方都支持才生效**。来源：[terrapin-attack.com](https://terrapin-attack.com/)
- OpenSSH 9.6（2023-12-18）加入 strict KEX。来源：[发布说明](https://www.openssh.org/releasenotes.html)
- russh 0.40.2 修复（0.40.1 及以前受影响）。来源：[Terrapin patches 列表](https://terrapin-attack.com/patches.html)
- 本仓库的 russh 0.64.1 默认 KEX 列表里带 `kex-strict-c-v00@openssh.com` [本地源码 `vendor/russh/src/negotiation.rs:162`]。但老服务器不支持 strict kex 时，用 chacha20-poly1305 仍然可被攻击——可以考虑在状态栏标出“对方不支持 strict kex”[推论]。

#### 1.6.4 russh 的历史漏洞（重点：2026 年非常密集）

GitLab 漏洞库收录 russh 公告 22 条：2023 年 2 条、2024 年 2 条、2025 年 1 条、**2026 年 17 条**。来源：[GitLab Advisory DB: russh](https://advisories.gitlab.com/pkg/cargo/russh/)；[russh GitHub Security Advisories](https://github.com/Eugeny/russh/security/advisories)

和**客户端**有关的（EverShell 只用客户端）：

| 编号 | 内容 | 受影响 / 修复 | 来源 |
|---|---|---|---|
| CVE-2023-28113 | 不安全的 DH 公钥（没校验对方 DH 值） | 修复版本 [待核实] | [GitLab](https://advisories.gitlab.com/pkg/cargo/russh/) |
| CVE-2023-48795 | Terrapin | ≤0.40.1 / 0.40.2 | [terrapin patches](https://terrapin-attack.com/patches.html) |
| CVE-2024-43410 | 按不可信长度分配内存导致 OOM | 修复版本 [待核实] | [GitLab](https://advisories.gitlab.com/pkg/cargo/russh/) |
| GHSA-g9g7-5cgw-6v28 | 客户端 keyboard-interactive 不检查提示数量 | 2026-05-20 公布，修复版本 [待核实] | [russh advisories p2](https://github.com/Eugeny/russh/security/advisories?page=2) |
| GHSA-g9hv-x236-4qp3 | 客户端收到长度不对的 X25519 值时 panic（认证前 DoS） | 2026-07-22 公布 | 同上 |
| GHSA-w3jg-pjxf-73p4 | 混合 ML-KEM 交换不校验 X25519 全零点，经典部分贡献为零，只剩 ML-KEM；**恶意服务器对客户端同样有效** | <0.63.0 / 0.63.0 | [GHSA-w3jg](https://github.com/Eugeny/russh/security/advisories/GHSA-w3jg-pjxf-73p4) |
| GHSA-47hw-gvq5-r2gm（High） | 恶意服务器发客户端从没打开过的通道号的 exit-status / data / close，客户端照样回调 Handler，可伪造命令生命周期事件或打崩按通道号索引状态的应用 | ≤0.63.0 / 0.63.1 | [GHSA-47hw](https://github.com/Eugeny/russh/security/advisories/GHSA-47hw-gvq5-r2gm) |
| GHSA-4wc5-f2rc-q74m | agent 协议服务端被恶意约束记录撑爆内存（EverShell 将来自己实现 agent 时相关） | ≤0.64.0 / 0.64.1 | [GHSA-4wc5](https://github.com/Eugeny/russh/security/advisories/GHSA-4wc5-f2rc-q74m) |

另外几条（未打开通道的服务端回调、解压后包大小不限、CryptoVec 分配、标识串解析等）多数在服务端或双方共用的解析路径上，具体对客户端的影响 [待核实]。

发布节奏：0.62.0（2026-07-02）到 0.64.1（2026-10-05）三个月 15 个版本。来源：[crates.io 版本列表](https://crates.io/crates/russh/versions)。**每次升级都要重新打 vendor 补丁**，这是 EverShell 当前最大的安全维护成本。

同类客户端的历史教训：

- OpenSSH CVE-2016-0777：客户端默认开启的“roaming（断线续连）”功能能把客户端私钥泄露给恶意服务器；主机钥匙校验挡住了中间人，但挡不住恶意服务器本身。来源：[Red Hat CVE-2016-0777](https://access.redhat.com/articles/2123781)。**教训：断线续连、会话恢复这类功能是攻击面。**
- PuTTY CVE-2024-31497：0.68–0.80 生成 NIST P-521 ECDSA 签名时 nonce 有偏，攻击者收集约 60 个签名（比如攻破一台你常登录的服务器）就能算出私钥；升级不能救已有钥匙，必须换钥匙；FileZilla、WinSCP 等打包了 PuTTY 的也受影响。来源：[Help Net Security](https://www.helpnetsecurity.com/2024/04/16/cve-2024-31497/)。**对 EverShell 的意义：从 PuTTY/WinSCP 导入 P-521 私钥时可以提示用户。**

#### 1.6.5 终端转义序列：OSC 52 读剪贴板

- xterm.js 的 `ClipboardAddon` 收到 `OSC 52 ; ? `（读请求）时，**默认读本机剪贴板并把内容发回远端**；源码里没有关闭读取的开关，只能传自定义 provider。来源：[ClipboardAddon.ts](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-clipboard/src/ClipboardAddon.ts)
- 对比 kitty：默认 `write-clipboard write-primary read-clipboard-ask read-primary-ask`，读剪贴板要用户同意；文档明说关掉确认后任何程序（包括 SSH 远端）都能读你的剪贴板。来源：[kitty clipboard_control](https://sw.kovidgoyal.net/kitty/conf/#opt-kitty.clipboard_control)
- 用户刚复制过密码时，这就是一条“恶意服务器偷本机机密”的路。

#### 1.6.6 中转被当开放代理 / 访问内网

- OWASP SSRF：目标不固定时只能用黑名单，且黑名单容易被绕过；要挡的网段包括云元数据 169.254.169.254、127.0.0.0/8、0.0.0.0/8、::1、10/8、172.16/12、192.168/16、fc00::/7、fe80::/10、组播；**防 DNS 重绑定要先解析、逐个校验 A/AAAA、再连接校验过的 IP**；IPv4 映射的 IPv6 地址（`::ffff:127.0.0.1`）要单独查。来源：[OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- Cloudflare Workers 的 `connect()` 本身就禁止连 Cloudflare IP、localhost、私有网段，默认禁 25 端口。来源：[Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。所以 Workers 版天然不能打内网，**自建 Node 版必须自己做**。
- 本仓库现状：令牌放在 URL 查询参数里（会进反向代理的访问日志）、目标不限 [本仓库]。M0 报告已列为后续事项。

### 1.7 对 EverShell 的建议

**现在（M1）就该立的规矩：**

1. **写一份威胁模型文档**（`docs/security/threat-model.md` 之类）：一张数据流图（界面 ↔ IPC ↔ Rust ↔ 钥匙串 / 保险箱 / SSH 服务器；网页版加中转；M2 加同步服务），标出信任边界；表格列 1.1 的资产和攻击者，逐条写“防住 / 不防 / 以后防”。需求文档 3.5 已经有一段“防得住什么、防不住什么”，搬过去扩写。每个里程碑结束时复核一次。
2. **主机指纹校验是 M1 的硬门槛**：默认等价 `ask`；指纹变了必须硬拦截（不给“继续”的大按钮，只给“我已核实，更新指纹”）；记录格式能导入 OpenSSH known_hosts（含 `[host]:port`、哈希名、`@revoked`）；known_hosts 数据要防篡改（放保险箱或带 MAC）。
3. **OSC 52 规矩**：要接剪贴板就自己写 provider，**只允许写、默认拒绝读**（或像 kitty 一样每次问）。其他转义序列（标题、OSC 8 超链接）当不可信输入处理，超链接点击前显示真实 URL。
4. **日志规矩**：机密类型一律不派生 `Debug`（或手写打码的 `Debug`，像 `VaultKey(..)` 那样）；终端数据、按键、SFTP 文件内容永不进日志；正式版禁止 trace 级别；服务器返回的字符串写日志前转义。可以加一条 CI 检查：`grep` 出带 `password|passphrase|pem|secret` 字段的结构体有没有 `derive(Debug)`。
5. **依赖规矩**：CI 跑 `cargo deny check`（advisories + licenses + bans + sources）和 `npm audit --audit-level=high`；开 Dependabot（Cargo、npm、GitHub Actions）；GitHub Actions 一律按提交 SHA 固定；workflow 默认 `permissions: read-all`。
6. **russh 跟版规矩**：订阅 russh 的 GitHub Security Advisories（Watch → Custom → Security alerts）；russh 出安全版本后一周内重打补丁升级；**尽快把 wasm 定时器和 CHANNEL_CLOSE 两个补丁提给上游**，这是降低维护成本最有效的一步。
7. **漏洞披露**：加 `SECURITY.md`（写清报告方式、支持的版本、响应时间），开 GitHub 私密漏洞报告。
8. **机密在内存里**：保险箱钥匙已经用 `Zeroizing`；把 `Auth::Password(String)` 和私钥 PEM 也换成 `Zeroizing<String>` / `secrecy` 类型，减少在内存和崩溃转储里的停留。
9. **Tauri 边界**：capabilities 只开用到的命令；读机密的命令不暴露给前端（前端只传“连接 id”，Rust 自己去保险箱取）——看起来现在就是这样，写进规范防止以后有人加“读取密码”的命令。CSP 禁 `unsafe-eval`、禁远程脚本。

**到哪个里程碑再做：**

- M1 末 / 发布前：发布签名和公证、更新签名私钥的保管方式（只放 CI 的加密机密或硬件钥匙，写进威胁模型）。
- M2（同步）：照 Standard Notes 004 / Bitwarden 设计（详见第 5 节建议）：Argon2id 派生后拆“加密钥匙 / 认证凭据”，服务器对认证凭据再慢哈希；参数随数据存；密文带版本前缀；钥匙轮换流程。考虑 SRP 或 OPAQUE 代替“发送认证凭据”[待评估]。
- M2/M3：中转改短期票据（不放 URL，放 WebSocket 子协议头或首帧）；自建中转默认禁内网网段 + 解析后再校验 IP，可配白名单。
- M4（端口转发 / 跳板机 / agent）：agent 转发默认关、按主机开、签名时提示；动态转发（SOCKS）默认只监听 127.0.0.1。
- M5（AI 助手、会话日志、历史命令）：这些数据当机密处理（进保险箱或至少加密存储）；AI 助手发送前提示可能包含机密，[待评估]命令输出里的 prompt 注入。
- Touch ID：换数据保护钥匙串 + `SecAccessControl`，需要带权限签名。

**现有设计里看到的风险：**

- **主机指纹现在全部接受**（`check_server_key` 返回 `true`）：任何中间人都能拿到密码登录的明文密码。在 M1 完成前，不应该用 EverShell 以密码方式连不可信网络里的服务器。
- **russh 安全公告密集 + vendor 补丁**：Dependabot 不会升级 vendor 副本，升级全靠人；补丁不进上游，每次升级都可能拖延。
- **SSH 客户端标识串**是 `SSH-2.0-russh_0.64.1` [本地源码 `client/mod.rs:2673`]，服务器和中间人能据此精确知道 russh 版本，配合公告挑漏洞打。可以考虑改成不带小版本号的标识 [推论]。
- `keyring` 用的是文件式钥匙串，同一用户下其他程序访问要弹框，但“始终允许”之后就不再拦；这和需求文档“防得住其他软件悄悄读取”的说法要对齐措辞 [推论]。
- 自建中转令牌在 URL 里、目标不限（M0 已知）。

---

## 2. 兼容性

### 2.1 OpenSSH 各版本的算法变化

全部来自 [OpenSSH Release Notes](https://www.openssh.org/releasenotes.html)（逐段抓取核对；9.8 / 9.9 的 DSA 表述有一处摘要冲突，以 9.8 为准）。

| 版本（日期） | 变化 |
|---|---|
| 6.7（2014-10-06） | sshd 默认关掉 CBC 和 arcfour |
| 7.0（2015-08-11） | SSH v1 编译期默认关；`diffie-hellman-group1-sha1` 运行期默认关；`ssh-dss`（DSA）运行期默认关；删 v00 证书格式 |
| 7.2（2016-02-29） | 客户端默认关 blowfish-cbc、cast128-cbc、arcfour、rijndael-cbc 别名、MD5 和截断的 HMAC |
| 7.4（2016-12-19） | 客户端默认提案去掉 3des-cbc；服务端删除 SSH v1 |
| 7.6（2017-10-03） | 删除 SSH v1 支持；删 hmac-ripemd160；删 arcfour、blowfish、CAST；默认不提供 CBC |
| 7.8（2018-08-24） | ssh-keygen 默认写 OpenSSH 格式私钥（不再是 PEM） |
| 7.9（2018-10-19） | RSA 默认 3072 位；不允许 DSA 当 CA |
| 8.2（2020-02-14） | 默认 KEX 去掉 `diffie-hellman-group14-sha1`；CA 签名不再接受 `ssh-rsa`（SHA-1）；预告将默认禁用 `ssh-rsa` |
| 8.5（2021-03-03） | 默认开 `UpdateHostKeys`；首选签名算法从 ECDSA 换成 Ed25519；默认关 `CheckHostIP` |
| 8.8（2021-09-26） | **默认禁用 RSA/SHA-1 签名（`ssh-rsa`）** |
| 9.0（2022-04-08） | **默认 KEX 改成 `sntrup761x25519-sha512@openssh.com`（后量子混合）**；scp 默认改走 SFTP 协议 |
| 9.5（2023-10-04） | ssh-keygen 默认生成 Ed25519 |
| 9.6（2023-12-18） | strict KEX（防 Terrapin） |
| 9.8（2024-07-01） | DSA 编译期默认关闭 |
| 9.9（2024-09-19） | 新增 `mlkem768x25519-sha256`，默认可用 |
| 10.0（2025-04-09） | **删除 DSA**；客户端默认 KEX 改为 `mlkem768x25519-sha256`；默认加密顺序 ChaCha20-Poly1305 → AES-GCM → AES-CTR；**sshd 默认关掉有限域 DH（diffie-hellman-group* 和 group-exchange）** |
| 10.1（2025-10-06） | 协商到非后量子 KEX 时警告（`WarnWeakCrypto`，默认开） |
| 10.2（2025-10-10） | 预告弃用 SHA1 的 SSHFP 记录 |
| 10.3（2026-04-02） | 默认接受 FIDO/WebAuthn 签名格式 |

### 2.2 老服务器和网络设备的旧算法

- OpenSSH 官方“Legacy options”页：连只支持旧算法的设备时，用 `+` 前缀把旧算法**追加**到默认列表（`KexAlgorithms=+diffie-hellman-group1-sha1`、`HostKeyAlgorithms=+ssh-dss`），这样对方支持更强的算法时还会自动选强的；页面明确说这是临时手段，首选升级对端。来源：[OpenSSH Legacy Options](https://www.openssh.org/legacy.html)
- 老 Cisco IOS 只提供有限的 DH 群（group2 1024 位、group14 2048 位、group16），用户靠给客户端加 `diffie-hellman-group14-sha1` 才连得上；较新的 IOS XE 17.9 主机钥匙已是 `rsa-sha2-512`。来源：[Cisco Community](https://community.cisco.com/t5/cisco-bug-discussions/cisco-ios-does-not-support-openssh-6-4/m-p/4396869)（二手，具体型号和版本 [待核实]）

### 2.3 russh 0.64.1 支持的算法（直接读 vendor 源码）

[本地源码] `vendor/russh/src/kex/mod.rs`、`cipher/mod.rs`、`mac/mod.rs`、`negotiation.rs`：

| 类别 | 实现了的 | 默认提案（按顺序） | 备注 |
|---|---|---|---|
| KEX | mlkem768x25519-sha256、curve25519-sha256（含 @libssh.org 旧名）、ecdh-sha2-nistp256/384/521、DH group1-sha1、group14-sha1、group14-sha256、group15/16/17/18-sha512、group-exchange-sha1/sha256 | mlkem768x25519 → curve25519 → gex-sha256 → group18/17/16/15-sha512 → group14-sha256，加 ext-info 和 strict-kex 标记 | **没实现 `sntrup761x25519-sha512`**（源码注释明说）；SHA-1 的 DH 实现了但不在默认里 |
| 加密 | chacha20-poly1305@openssh.com、aes128/256-gcm@openssh.com、aes128/192/256-ctr、aes128/192/256-cbc、3des-cbc（要 `des` 特性） | chacha20-poly1305 → aes256-gcm → aes256/192/128-ctr | **aes128-gcm 不在默认里**；CBC 不在默认里；本仓库没开 `des` |
| MAC | hmac-sha1、hmac-sha2-256/512，及各自 -etm | sha512-etm → sha256-etm → sha512 → sha256 | SHA-1 MAC 不在默认里 |
| 主机钥匙 | Ed25519、ECDSA P-256/384/521、rsa-sha2-512、rsa-sha2-256、ssh-rsa（SHA-1）；DSA 要 `dsa` 特性 | Ed25519 → ECDSA → rsa-sha2-512 → rsa-sha2-256 → **ssh-rsa** | 默认还接受 SHA-1 的 ssh-rsa（OpenSSH 8.8 起默认不接受）；本仓库没开 `dsa` |
| 压缩 | none、zlib、zlib@openssh.com（`flate2` 特性） | none 优先 | |

结论：对新服务器没问题（含后量子）；对老网络设备，**只开 group14-sha1 / CBC / 3des / DSA 中的哪几个，需要一个“按主机启用旧算法”的开关**，否则连不上。

### 2.4 Linux 监控采集在不同环境的差异

- **BusyBox（Alpine、很多嵌入式和容器）**：`ps` 的 `-o` 只在 `ENABLE_DESKTOP` 构建里有；可用字段是 user、group、comm、args、pid、ppid、pgid、tty、vsz、sid、stat、rss（另有几个要编译选项）；**`pcpu` 在源码里是注释掉的，不支持**；`-e` 等 POSIX 选项“接受但忽略”。来源：[BusyBox procps/ps.c](https://github.com/mirror/busybox/blob/master/procps/ps.c)。
  - 对 EverShell：现在的 `ps -eo rss=,pcpu=,comm=` 在 BusyBox 上会因为 `pcpu` 报错退出，错误被 `2>/dev/null` 吞掉，**进程列表在 Alpine 上会是空的** [推论，没实测；本机 Docker 没启动]。BusyBox 的 rss 单位 [待核实]。
- **容器**：`/proc/meminfo` 从来没按 cgroup 隔离，容器里 `free`/`top` 显示的是宿主机总内存；2012 年把 meminfo 改成按 memcg 显示的内核补丁被拒，评审建议另做文件再 bind mount。来源：[LKML 2012 讨论](https://lkml.iu.edu/hypermail/linux/kernel/1205.3/03133.html)；LXCFS 就是干这个的（提供按 cgroup 计算的文件，bind mount 到 /proc 原文件上）。来源：[LXCFS](https://linuxcontainers.org/lxcfs/introduction/)
  - 真实限制在 cgroup v2 文件里：`memory.current`、`memory.max`（默认 `max`）、`memory.stat`、`memory.swap.current`；CPU 是 `cpu.stat` 的 `usage_usec` 和 `cpu.max`（格式 `$MAX $PERIOD`，默认 `max 100000`）。来源：[Linux cgroup v2 文档](https://docs.kernel.org/admin-guide/cgroup-v2.html)
  - `/proc/stat` 在容器里也是宿主机的 CPU [待核实，未找到一手说明]；`nproc` 是否考虑 cgroup CPU 配额 [待核实]。
- **非英文 locale**：命令输出（日期、数字、表头）会随 locale 变；本仓库已经用 `env LC_ALL=C` 包住 [本仓库]，这条规矩要保留并写进规范。
- **登录脚本往标准输出打印文字**：会污染 exec 输出和 SFTP 数据流（本仓库 `docs/dev/pitfalls.md` 已记录 SFTP 的这个坑）；监控命令的解析也要容忍前面多出来的行 [本仓库已用 `==NAME==` 分段，能容忍]。
- **macOS / FreeBSD 服务器**：没有 Linux 那种 `/proc`，要用 `sysctl`、`vm_stat`、`netstat -ib`、`top -l 1` 之类 [待核实具体命令]；现在返回 `supported: false` [本仓库]。
- **Windows 服务器（Win32-OpenSSH）**：默认 shell 是 cmd / PowerShell，现在的命令会失败 [推论]。

### 2.5 终端兼容：vim / tmux / 中文宽字符 / emoji / 输入法 / TERM / 真彩色 / 括号粘贴 / OSC 7 / OSC 52

- **xterm.js 6.0.0** 的重要变化：删除 canvas 渲染器（只剩 DOM 和 WebGL）；视口和滚动条重写；新增同步输出（DEC mode 2026）、连字、进度条插件、OSC 52 剪贴板支持；修了部分输入法重复输入和 macOS CapsLock 重复输入。来源：[xterm.js 6.0.0 release](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)
- **Unicode 宽度**：`addon-unicode11` 提供 Unicode 11 宽度规则，加载后要设 `terminal.unicode.activeVersion = '11'`。来源：[addon-unicode11 README](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-unicode11)。`addon-unicode-graphemes`（字素簇）是实验性的，README 说可能有非标准行为，未发布到 npm。来源：[addon-unicode-graphemes README](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-unicode-graphemes)。终端和远端程序（vim、tmux、glibc 的 wcwidth）宽度表不一致时会错位，这是所有终端的通病 [待核实具体案例]。
- **xterm.js 支持的序列**：括号粘贴 DECSET 2004 支持；鼠标 X10/1000/1002/1003/1004/1006/1016 支持，1005/1015 不支持；OSC 0/2/4/8/10/11/12/104/110–112 支持；**OSC 7 不在内置列表里**。来源：[xterm.js VT features](https://xtermjs.org/docs/api/vtfeatures/)。自定义 OSC 处理用 `parser.registerOscHandler(ident, cb)`。来源：本机 `node_modules/@xterm/xterm/typings/xterm.d.ts:1864` [本地源码]
  - OSC 7（当前目录）要远端 shell 主动发，通常要往 `PROMPT_COMMAND` / `precmd` 里加；需求文档里“文件目录跟随终端当前目录”可以用 OSC 7，也可以另开 exec 通道查 shell 进程的 `/proc/<pid>/cwd` [推论；FinalShell 的做法 待核实]。
- **TERM**：tmux 内部的 TERM 必须是 `screen`、`tmux` 或 `tmux-256color` 之类；外层应和真实终端一致；真彩色要告诉 tmux 外层支持 RGB（tmux 3.2+ 用 `terminal-features ...:RGB`，或 `terminal-overrides` 加 `Tc`）。来源：[tmux FAQ](https://github.com/tmux/tmux/wiki/FAQ)。远端没有 `xterm-256color` 的 terminfo 时（极老或极简系统），程序会退化或报错 [待核实]。
- **真彩色探测**：约定是 `COLORTERM=truecolor` / `24bit`；它默认**不会经 ssh 转发**，要客户端 `SendEnv` + 服务端 `AcceptEnv`。来源：[termstandard/colors](https://github.com/termstandard/colors)。sshd 默认不接受任何客户端环境变量，只有请求 PTY 时的 TERM 例外。来源：[sshd_config(5)](https://man.openbsd.org/sshd_config)
- **OSC 52**：见 1.6.5。

### 2.6 对 EverShell 的建议

**现在（M1）就该立的规矩：**

1. **算法策略写成文档**：默认算法用 russh 默认（已含后量子和 strict kex）；“旧算法”按主机单独开（group14-sha1、group1-sha1、aes-cbc、3des-cbc、ssh-rsa、DSA），开了就在状态栏标黄；状态栏显示协商结果（KEX / 加密 / 主机钥匙类型），像 OpenSSH 10.1 那样对非后量子 KEX 给提示。是否开 russh 的 `des`、`dsa` 特性要明确决定（影响 WASM 体积和攻击面）。
2. **兼容性测试矩阵**（建议 CI 用容器跑，至少每个里程碑跑一次）：
   - OpenSSH：最新版、10.0（无 DSA、sshd 无 DH）、9.x、8.x（CentOS 8 / Ubuntu 20.04 一代）、7.4（CentOS 7）；
   - Dropbear（路由器、嵌入式常见）[建议加，未调研其算法]；
   - 网络设备：至少一个“只有 group14-sha1 + aes-cbc + ssh-rsa”的模拟服务器（用 OpenSSH 配置旧算法即可模拟）；
   - 监控：Debian/Ubuntu、CentOS 7（老内核无 MemAvailable 已兼容）、**Alpine（BusyBox ps）**、Docker 容器内、非 C locale 用户、登录脚本会打印文字的用户、macOS 服务器（期望 `supported: false` 而不是报错）。
3. **监控命令不依赖 `ps` 的扩展字段**：进程列表改成直接读 `/proc/[pid]/stat` 和 `/proc/[pid]/status`（BusyBox 也有 /proc），或者 `ps` 失败时退回 `ps -o pid,rss,comm` 再自己算 CPU；容器里优先读 cgroup v2 的 `memory.max` / `memory.current` 显示“容器限制”。
4. **终端基线**：加 `addon-unicode11`（设 `activeVersion = '11'`），加 `addon-webgl`（失败退回 DOM）；明确不接 graphemes 插件（实验性）。写一份手测清单：vim、tmux（含鼠标、真彩色）、htop、中文和 emoji 宽度、中文输入法候选框位置和回车上屏、括号粘贴、`less` 鼠标滚动、窗口缩放后 reflow。

**到哪个里程碑再做：**

- M1 后期：OSC 7 跟随目录（需求 P0 里有“文件目录跟随终端当前目录”）。
- M3（网页版）：浏览器里的输入法、复制粘贴权限、快捷键冲突（Ctrl+W 等）单独一轮兼容测试。
- M6（Windows）：ConPTY 不涉及（我们是远端 PTY），但本地字体回退、输入法框架不同，要单独测。

**现有设计里看到的风险：**

- Alpine / BusyBox 上进程列表大概率为空（上面推论，建议尽快实测）。
- 容器里内存显示宿主机数值，用户会误以为内存很充足。
- russh 默认还接受 SHA-1 的 `ssh-rsa` 主机签名，比 OpenSSH 8.8+ 宽松；是兼容性利好，但应当在界面上可见。

---

## 3. 可靠性

### 3.1 断线检测与 keepalive

- OpenSSH 客户端 `ServerAliveInterval` 默认 0（不发）；`ServerAliveCountMax` 默认 3，间隔 15 秒时约 45 秒判定断线；`TCPKeepAlive` 可被伪造，而 ServerAlive 消息走加密通道不可伪造；TCP keepalive 会让短暂抖动也断开连接。来源：[ssh_config(5)](https://man.openbsd.org/ssh_config)
- 服务端对应的 `ClientAliveInterval` 默认 0、`ClientAliveCountMax` 默认 3；`ChannelTimeout`、`UnusedConnectionTimeout` 默认不超时，但服务器管理员可能配了，空闲会话会被服务器关掉。来源：[sshd_config(5)](https://man.openbsd.org/sshd_config)
- OpenSSH 有传输层 ping 扩展 `ping@openssh.com`（SSH2_MSG_PING/PONG）。来源：[OpenSSH PROTOCOL](https://cvsweb.openbsd.org/src/usr.bin/ssh/PROTOCOL)
- russh 客户端：`keepalive_interval`（多久没收到数据就发 keepalive，默认 `None`）、`keepalive_max`（默认 3）、`inactivity_timeout`（默认 `None`）。[本地源码 `vendor/russh/src/client/mod.rs:2657–2661, 2684–2686`]
- 本仓库没设任何 keepalive [本仓库]：网络断了（换 Wi-Fi、合盖睡眠、NAT 超时）时，界面可能长时间显示“已连接”但没反应。

### 3.2 重连和会话恢复：Mosh、Eternal Terminal 的思路

| 方案 | 原理 | 代价 | 来源 |
|---|---|---|---|
| Mosh | SSH 只用来登录和交换钥匙，之后走 UDP 上的 SSP（状态同步协议）：两端各有屏幕快照，只同步到最新状态，可跳过中间帧；客户端至少每 3 秒心跳；服务器以最新认证包的源地址为回复地址，所以能漫游；本地预测回显 | 服务器要装 `mosh-server`，要开 UDP 60000–61000；只同步可见屏幕，**滚动历史不完整**（建议配 tmux）；两端要 UTF-8 locale | [mosh.org](https://mosh.org/) |
| Eternal Terminal | SSH 只用来启动；之后客户端连服务器上的 ETServer 进程。TCP 写成功只代表进了内核缓冲区，所以双方记录“读到的字节序号”，发送方保留最近 N 字节的加密备份缓冲，重连后补发差额 | 服务器要装 `etserver`；不实现 SSH 协议，没有通道 / 转发 | [ET: How it works](https://eternalterminal.dev/howitworks/) |
| 服务器端 tmux / screen | 会话本身在服务器上，客户端断了重新 attach | 要求服务器有 tmux；ET 还支持 tmux 控制模式 `-CC` | [ET: How it works](https://eternalterminal.dev/howitworks/) |
| OpenSSH 的 roaming（已废） | 客户端断线续连 | **CVE-2016-0777：把客户端私钥泄露给恶意服务器** | [Red Hat](https://access.redhat.com/articles/2123781) |

对 EverShell：需求是“服务器上不装 agent”，所以 Mosh/ET 那种“服务器常驻进程保住会话”的方式不适用；能做的是“检测到断线 → 自动重新建 SSH 连接 → 新开 shell”，远端进程是否保住取决于用户是否用 tmux / screen。

### 3.3 SFTP 大文件、断点续传、并发

- OpenSSH `sftp`：`-B` 缓冲默认 32768 字节；`-R` 同时在途请求默认 64；`reget` / `reput`（等于 `-a`）续传，**手册明说：如果已有的部分和源文件不一致，结果很可能是坏的**；`-f` 传完调用 fsync（上传时要服务器支持 `fsync@openssh.com`）；`-p` 保留时间和权限。来源：[sftp(1)](https://man.openbsd.org/sftp)
- OpenSSH 的 SFTP 扩展：`posix-rename@openssh.com`（POSIX 语义改名，可覆盖）、`fsync@openssh.com`、`limits@openssh.com`（最大包长、最大读写长度、最大打开句柄数，0 表示不限）、`copy-data`（服务器端拷贝）、`expand-path@openssh.com`、`home-directory`、`statvfs@openssh.com`、`hardlink@openssh.com`、`users-groups-by-id@openssh.com`。来源：[OpenSSH PROTOCOL](https://cvsweb.openbsd.org/src/usr.bin/ssh/PROTOCOL)
- 文件校验：SFTP 的 `check-file-handle` / `check-file-name`（md5、sha1、sha256 等）只存在于 2006 年过期的草案里；2023 年邮件列表还在问 OpenSSH 会不会实现，没找到实现的证据。来源：[draft-ietf-secsh-filexfer-extensions](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-extensions)；[openssh-unix-dev 2023-10](https://lists.mindrot.org/pipermail/openssh-unix-dev/2023-October/040970.html)。实际做法是另开 exec 通道跑 `sha256sum` / `shasum -a 256`（服务器有这些命令时）[推论]。
- **WinSCP 的做法**（值得照抄）：大于阈值（默认 100 KB）的文件先传成 `.filepart` 临时名，**传完才改成目标名**；中断后留下 `.filepart`，下次检测到就提议续传；续传要求源文件没变；部分文件比源文件大时拒绝续传。副作用：上传是新建文件，原文件的所有者 / 组会丢（权限位保留）；目标目录没有写权限时这个方式会失败；目标属于别的用户时 WinSCP 不用临时名。来源：[WinSCP: Resume / temporary filename](https://winscp.net/eng/docs/resume)
- 本仓库现状：上传直接 `TRUNCATE` 覆盖目标文件 [本仓库]——上传到一半断了，**服务器上原来的文件已经被截断损坏**；下载已按偏移并发读、读了 `limits@openssh.com` [本仓库]。

### 3.4 对 EverShell 的建议

**现在（M1）就该立的规矩：**

1. **默认开 keepalive**：比如 `keepalive_interval = 15s`、`keepalive_max = 3`（约 45 秒判死，和 OpenSSH 文档示例一致），按主机可调；系统睡眠唤醒、网络切换时立即发一次探测。断线状态要在标签上明确显示，不要假装还连着。
2. **重连只做“新连接 + 可选自动 attach tmux”**：断线后自动重连（指数退避、上限次数），重连成功提示“这是新会话，之前的进程可能已结束”；连接设置里可选“登录后自动 `tmux new -A -s evershell`”。**不实现任何“协议级会话恢复”**（CVE-2016-0777 的教训）。
3. **SFTP 上传规矩**：先写 `<名字>.evershell-part`（或类似），传完 fsync（支持 `fsync@openssh.com` 时）→ `posix-rename@openssh.com` 覆盖目标；服务器不支持 posix-rename 时退回“删目标再改名”并在界面提示有短暂窗口；目标属于别人或目录不可写时退回直接覆盖并提示风险。
4. **续传规矩**：只对“临时文件 + 源文件大小和修改时间没变”的情况续传；续传完成后能算哈希就校验（远端 `sha256sum` 可用时），不能就提示“未校验”。
5. **并发规矩**：单文件内的在途请求数和块大小以 `limits@openssh.com` 为上限（已做）；多文件并发默认 2–3 个（WinSCP / FileZilla 的常见默认，具体数值 [待核实]），共用一条 SSH 连接时要考虑和终端抢带宽——传输占满时终端按键延迟会变大，可以给传输限速选项。

**到哪个里程碑再做：**

- M2：传输队列持久化（应用退出后能续传）。
- M4：跳板机后的重连（要重建整条链）。

**现有设计里看到的风险：**

- 不发 keepalive：NAT / 防火墙空闲超时后会话“假在线”。
- 上传直接截断目标文件：中断会毁掉服务器上原有文件，这是最该先改的一条。
- 手动重连已有（`session-manager.ts` 的 `reconnect`），自动重连和睡眠唤醒检测还没有 [本仓库]。

---

## 4. 性能

### 4.1 终端吞吐与流控

- xterm.js 处理速度约 **5–35 MB/s**，而生产者能到几 GB/s；`write()` 不阻塞，数据先进内部缓冲，**缓冲硬上限 50 MB，超出的数据直接丢弃**。来源：[xterm.js Flow Control 指南](https://xtermjs.org/docs/guides/flowcontrol/)；源码 `DISCARD_WATERMARK = 50000000` [本地源码 `node_modules/@xterm/xterm/src/common/input/WriteBuffer.ts`]（[GitHub](https://github.com/xtermjs/xterm.js/blob/master/src/common/input/WriteBuffer.ts)）
- 推荐做法：`write(chunk, callback)` 回调表示这块处理完了；用水位线，HIGH = 100000 字节暂停数据源、LOW = 10000 恢复；为了按键响应快，HIGH 别超过 500K，用 `yes` 再按 Ctrl-C 测响应时间；为减少回调开销，每 100000 字节才要一次回调，按“待完成回调数”计（HIGH 5、LOW 2）。远程场景（WebSocket）要客户端在回调里发 ACK 控制消息、服务端据此暂停 / 恢复，两端必须统计同一个东西，否则会永久卡住。来源：同上指南。
- 对 SSH 来说，“暂停数据源”= 不再读 russh 通道 → russh 不再给服务器补窗口 → 服务器停发，这是天然的端到端回压 [推论]。russh 客户端默认窗口 2 MB、`channel_buffer_size` 100 条消息 [本地源码 `client/mod.rs:2680–2682`]。
- 本仓库现状：Rust 侧用无界通道把 shell 输出全部读走，前端 `term.write(data)` 不带回调 [本仓库] → **窗口一直被补满，服务器一直狂发**；`cat` 一个大文件或 `yes` 时，内存在 Rust 无界队列和 xterm.js 写缓冲里涨，超过 50 MB 后 xterm.js 开始丢数据（屏幕内容错乱），Ctrl-C 也要等积压的数据处理完才有反应。

### 4.2 渲染与内存

- xterm.js 6 只有 DOM 和 WebGL 两种渲染器（canvas 已删）。来源：[6.0.0 release](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)。本仓库没装 `addon-webgl`，用的是 DOM 渲染器 [本仓库]。WebGL 上下文可能丢失（显卡重置、标签太多）需要回退处理 [待核实具体 API]。
- 每个单元格 3 个 uint32（内容 + 前景 + 背景）= 12 字节，组合字符和扩展属性另存。[本地源码 `src/common/buffer/BufferLine.ts:22`]（[GitHub](https://github.com/xtermjs/xterm.js/blob/master/src/common/buffer/BufferLine.ts)）。粗算：5000 行滚动 × 200 列 × 12 字节 ≈ 12 MB / 标签（满屏时），10 个标签 120 MB [推论]。
- 历史数据：xterm.js 3.9 从 JS 数组换成 TypedArray 缓冲，1000 行滚动的 `ls` 场景从 25–50 MB 降到 8–15 MB。来源：[xterm 3.9.0 release notes](https://newreleases.io/project/npm/xterm/release/3.9.0)（第三方镜像）

### 4.3 Tauri IPC 的开销

- 官方文档：默认返回值会序列化成 JSON，大数据（比如文件）会拖慢；返回字节用 `tauri::ipc::Response`；前端发字节用 ArrayBuffer / Uint8Array 作请求体、Rust 用 `tauri::ipc::Request` 读 `InvokeBody::Raw`；**有序、高吞吐的推送用 Channel，不要用事件**（事件的异步监听可能乱序）。来源：[Tauri: Calling Rust from the Frontend](https://v2.tauri.app/develop/calling-rust/)
- 维护者说 Tauri 2 的二进制 IPC 不经序列化但仍走 fetch API；有用户非正式测 10 MB：macOS 约 5 ms、Windows 约 200 ms（维护者也觉得 Windows 变慢了）；只有 WebView2 支持共享内存但“出奇地慢”。来源：[tauri-apps discussion #11915](https://github.com/orgs/tauri-apps/discussions/11915)
- 第三方项目 connectrpc-tauri 的对比：64 KiB 原始字节 0.375 ms，同样数据放进 JSON 参数 5.063 ms（JSON 里每个字节是一个数字）。来源：[connectrpc-tauri](https://libraries.io/cargo/connectrpc-tauri)（第三方，[待核实]）
- 本仓库已经是“按键原始字节作请求体、输出用 Channel 推 ArrayBuffer”[本仓库，M0 报告]，方向正确；Windows 版要重新测。

### 4.4 基准工具

- **vtebench**（Alacritty）：只测终端读 PTY 的吞吐，README 明说不测帧率和延迟、不能代表整体性能。来源：[vtebench](https://github.com/alacritty/vtebench)。它是给本地终端用的，EverShell 的瓶颈在“网络 → russh → IPC → xterm.js”，可以把它的 benchmark 脚本放到远端服务器上跑，在 EverShell 里看耗时 [推论]。
- 按键延迟测量（如 Typometer）、xterm.js 自带的基准仓库 [待核实，未查到一手来源]。

### 4.5 对 EverShell 的建议

**现在（M1）就该立的规矩：**

1. **端到端回压是 M1 必做**：Rust 侧把无界通道换成有界（或按字节计数），前端按 xterm.js 指南的“每 100 KB 要一次回调、待完成回调 > 5 暂停 / < 2 恢复”发 ACK 给 Rust，Rust 暂停读 russh 通道。网页版走 WASM 时同理（两端统计同一个量）。验收：`yes` 跑 10 秒后按 Ctrl-C，1 秒内停；`cat` 1 GB 文件内存不涨过某个上限；屏幕内容不乱。
2. **性能预算写进规范**（数字是建议起点 [推论]）：本机回环下按键回显 p95 < 30 ms；吞吐 ≥ 10 MB/s 且不丢数据；10 个标签空闲时内存 < 500 MB；滚动行数默认 5000，上限可调但设置里提示内存代价。
3. **装 WebGL 渲染器**，失败或上下文丢失时退回 DOM；后台标签暂停渲染（xterm 继续收数据）。
4. **基准脚本进仓库**（`scripts/bench/`）：连 `scripts/test-sshd.sh` 起的本地 sshd，跑 `cat` 大文件、`yes | head -c 100M`、vtebench 的几个脚本，输出吞吐和内存；每个里程碑记录一次，看趋势。

**到哪个里程碑再做：**

- M3：网页版 WebSocket 中转的 ACK 回压（中转本身已有 1 MB 高水位，但浏览器到 xterm 那一段还没有）。
- M6：Windows 上 IPC 慢的问题，必要时改成更大的批量块。

**现有设计里看到的风险：**

- 没有回压（上面已说），这是性能和正确性（丢数据）双重问题。
- 监控每秒一次 exec，和终端共用一条连接，在慢链路上会和终端抢带宽 [推论，没测]。

---

## 5. 数据

### 5.1 本地存储格式的版本号与迁移

- 业界都把版本写进数据本身：KDBX 3.1 / 4 共存，KeePassXC 允许用户把库升级到 KDBX 4。来源：[KeePassXC docs](https://keepassxc.org/docs/)；Standard Notes 每段密文带 `004:` 前缀，并靠 AAD 里的版本和钥匙参数做跨客户端恢复。来源：[Standard Notes Encryption](https://standardnotes.com/help/security/encryption)
- Actual 的经验：同步消息格式一旦定下，**改 schema 很难，因为老客户端还会发老格式的消息**。来源：[Actual: Using CRDTs in the Wild](https://archive.jlongster.com/using-crdts-in-the-wild)
- 本仓库现状：保险箱遇到更高版本拒绝打开并提示升级、遇到低于当前的版本也报“不认识”；导出文件遇到更高版本只警告并忽略未知字段 [本仓库]——两种策略都对，但要写成统一规矩。

### 5.2 导入导出格式

- Bitwarden 的加密导出分两种：“账号绑定”（只能导回同一账号，轮换账号钥匙后就解不开）和“密码保护”（用户另设密码，经 KDF 派生、HKDF 扩展出加密钥匙和 MAC 钥匙，能导入任何账号）；文件是 JSON，结构保留，敏感字段换成密文串。来源：[Bitwarden Encrypted Exports](https://bitwarden.com/help/encrypted-export/)
- 对 EverShell 需求 4 节“随时导出加密备份文件，恢复时不依赖任何服务器”：应当是 Bitwarden 的“密码保护”型，并且格式公开写进文档（这就是“防跑路”的核心承诺）。

### 5.3 同步冲突处理

| 方案 | 怎么做 | 优点 | 缺点 | 来源 |
|---|---|---|---|---|
| 逐条记录 + 版本号（需求文档现在的写法） | 每条记录一个递增版本 | 简单 | 两台设备离线各改一次，版本号相同或无法比较谁新；需要额外的决胜规则 | [推论] |
| 逐条 / 逐字段 LWW + 混合逻辑时钟（HLC） | 时间戳 = 物理时间 + 计数器 + 节点 ID，可按字符串排序 | 接近墙钟、保持因果顺序；离线友好 | 依赖时钟大致准；Actual 拒收时钟偏差超过 1 分钟的消息 | HLC 论文 [Logical Physical Clocks（Kulkarni、Demirbas 等）](https://www.cse.buffalo.edu/~demirbas/publications/hlc.pdf)（链接来自检索，本次抓取 404，[待核实]）；[Actual](https://archive.jlongster.com/using-crdts-in-the-wild) |
| Actual 的做法（LWW map CRDT） | 不写整行，每次增删改拆成 `dataset/row/column/value` 的字段级消息，带 HLC；删除 = 把 `tombstone` 列设 1；用时间戳的 Merkle 树比较两端，找到分歧点再补消息；服务器约 300 行，只存和转发 | 永不需要用户手动解决冲突；不同字段的修改互不覆盖 | 消息日志只增不减，需要一个“纪元”之前的可删；跨字段约束无法保证；消息量大 | [Actual](https://archive.jlongster.com/using-crdts-in-the-wild) |
| Atuin 的记录日志 | 加密的只追加记录日志（历史是 `Create(History)` / `Delete(HistoryId)`），本地再“构建”成可查询的数据库；按 tag 和 host 分组，每个 host 有自己的 idx；早期用链表维护顺序，作者承认“难调试、难推理”后放弃 | 同步只交换记录，不交换数据库行；加密简单 | 日志增长；删除也是一条记录 | [Atuin store](https://docs.atuin.sh/main/reference/store/)；[sync v2 讨论](https://forum.atuin.sh/t/sync-v2-testing/124)；链表一事来自检索摘要中的提交信息 [待核实] |
| CRDT 文档（Automerge 一类） | 完整变更历史，自动合并 | 适合多人协作文本 | 存全量历史有性能和存储问题；同一属性同时改仍是冲突 | [Ink & Switch: Local-first software](https://www.inkandswitch.com/essay/local-first/) |
| Etebase | 每次修改生成新修订（可回看和回滚）；集合级 `stoken` 每次变化，用来只拉变化或保证集合完整性 | 修订历史 | 细节需看协议规范 | [Etebase overview](https://docs.etebase.com/overview) |

**墓碑要留多久：** Cassandra 删除时写墓碑，保留 `gc_grace_seconds`（默认 10 天）；如果一个副本离线超过这段时间，墓碑被清掉后它回来，**删掉的数据会被当成新数据“复活”**。所以墓碑保留时间必须超过任何副本可能离线的时间。来源：[Cassandra Compaction overview](https://cassandra.apache.org/doc/latest/cassandra/managing/operating/compaction/overview.html)。EverShell 的设备可能几个月不开机，墓碑要么永久保留（连接记录数量小，代价不大），要么服务器记录每台设备的同步进度，所有设备都确认后再清 [推论]。

### 5.4 端到端加密同步的现成设计可借鉴之处

- **Standard Notes 004 最接近 EverShell 的选型**（Argon2id + XChaCha20-Poly1305）：root key 拆 masterKey / serverPassword；items key 随机生成并作为普通条目同步；每个条目再有随机 item_key；AAD 含 uuid 和版本。来源：[Standard Notes Encryption](https://standardnotes.com/help/security/encryption)
- **Bitwarden**：服务器对收到的主密码哈希再 PBKDF2 60 万次；每个条目单独 Cipher Key，附件另有 Attachment Key；可选轮换。来源：[Bitwarden Whitepaper](https://bitwarden.com/help/bitwarden-security-white-paper/)
- **1Password 2SKD**：Secret Key 让服务器被拖库也无法离线爆破（Secret Key 不在服务器上）。来源：[1Password deepKeys](https://agilebits.github.io/security-design/deepKeys.html)。EverShell 需求里“恢复码”[待确认]可以参考它的应急包（Emergency Kit）思路 [推论]。
- **Atuin**：每条记录随机内容钥匙、主钥匙包裹，便于轮换；记录元数据（id、idx、version、tag、host）作为隐式断言参与认证（来自第三方转述的 AGENTS.md，[待核实]）。来源：[Atuin new encryption](https://blog.atuin.sh/new-encryption/)
- **服务器能看到的元数据**：即使内容加密，服务器仍能看到记录数量、大小、修改时间、哪台设备在什么时候同步、记录 id。Termius 的文档就没有说明哪些元数据可见 [来源见 1.2]。威胁模型里要明写这一条。
- **服务器作恶的几种方式**（加密只防“看”，不防这些）：回滚到旧版本、丢弃某些记录、把 A 用户的密文给 B、重放旧的删除。对策：AAD 绑定账号 id + 记录 id + 版本；客户端记录每条记录见过的最高版本，拒绝回退 [推论]。

### 5.5 对 EverShell 的建议

**现在（M1）就该立的规矩：**

1. **所有持久化格式都有版本号**（已做），并统一三条规则：读到更高版本 → 只读或拒绝，**绝不覆盖写回**（防止老版本软件毁掉新数据）；读到旧版本 → 按迁移链逐级升级，升级前先备份原文件；每个版本留一份样例文件做测试夹具，迁移代码有单元测试。
2. **所有记录现在就带 `id`（UUID）、`updatedAt`（以后换 HLC）、`deleted`（墓碑）字段**，哪怕 M1 还没有同步——M2 再加就要迁移所有用户数据。删除连接不要真删，而是标墓碑（界面上隐藏）。
3. **导出格式写成公开文档**（字段含义、版本、加密方式），这是“不跑路”承诺的一部分；加密导出用“密码保护”型（Argon2id + XChaCha20-Poly1305，参数随文件存）。
4. 本地数据只经 `core/storage.ts`（CLAUDE.md 已有）——保持。

**到哪个里程碑再做：**

- M2 同步设计时决定：**建议“逐条记录 LWW + HLC 时间戳 + 设备 id 决胜 + 墓碑永久保留”**，不上通用 CRDT（连接配置、快捷命令都是小记录，字段级合并收益不大；Actual 的字段级 LWW 是可选的升级路径）。服务器只存 `(账号, 记录 id, HLC, 密文)`，按 HLC 增量拉取。
- M2 钥匙设计：参照 Standard Notes 004（见 5.4），并补上需求文档没写的两点：①认证凭据和加密钥匙分开派生，服务器对认证凭据再慢哈希；②钥匙轮换流程（主密码泄露时怎么办）。
- M2：多设备合并（需求文档 4 节“后加入的设备用同步的保险箱钥匙重新加密后合并”）要有冲突预览，至少处理“两边都有同名连接”。

**现有设计里看到的风险：**

- 需求文档写的是“逐条记录比较版本号”，没写版本号怎么生成、两台离线设备同时修改怎么决胜；建议改成 HLC。
- 墓碑没写保留策略，按 Cassandra 的经验会出现“删掉的连接又回来了”。
- 需求文档 4 节写“数据用主密码派生出的密钥在本地加密”，如果字面实现（直接用派生钥匙加密数据），改主密码就要重加密全部数据；3.5 节的“保险箱钥匙另锁一份”是对的分层做法，两处措辞要统一成“随机数据钥匙 + 主密码派生的包裹钥匙”。

---

## 6. 开源协议合规

### 6.1 GPL-3.0-or-later 的义务

- **发二进制必须提供对应源码**，第 6 节给了五种方式：随实体介质附源码；实体产品附至少 3 年有效的书面要约；偶尔、非商业地转交书面要约；**从指定地点提供目标代码，并在同一地点以同等方式免费提供源码（6d，GitHub Releases 就属于这种）**；P2P 分发时告知源码在哪。来源：[GPL-3.0 全文（OSI 镜像）](https://opensource.org/license/gpl-3-0)；[gnu.org 原文](https://www.gnu.org/licenses/gpl-3.0.html)
- **“安装信息”条款**：只针对“用户产品”（消费类有形个人财产或装进住宅的东西），转让占有时要附上安装修改版所需的方法、授权钥匙等。来源：同上第 6 节。纯软件下载是否构成“用户产品”交付、iOS 设备上是否触发 [待核实，需法律意见]。
- 第 4 节：保留版权声明、许可证适用声明、无担保声明，并附许可证副本。来源：同上。
- 第 7 节：可以对**自己拥有版权的部分**加“额外许可”（例外条款）；下游转发时可以删掉这些额外许可。来源：同上。
- 第 10 节有“不得对本许可授予的权利施加进一步限制”的规定 [凭记忆，措辞待核实]，App Store 冲突就出在这类条款上（见 6.4）。

### 6.2 Apache-2.0 与 GPLv3 的兼容性、NOTICE 义务

- FSF：Apache 2.0 **与 GPLv3 兼容，与 GPLv2 不兼容**；ISC、Expat（MIT）与 GPL 兼容；旧 OpenSSL 许可证与 GPL 不兼容（OpenSSL 3.0 起改为 Apache 2.0）；Unicode 许可证与所有 GPL 版本兼容；MPL-2.0 通过其 3.3 节间接兼容。来源：[FSF License List](https://www.gnu.org/licenses/license-list.html)
- Apache-2.0 第 4 节再分发义务：(a) 附许可证；**(b) 修改过的文件要有显著的“已修改”声明**；(c) 保留原有版权、专利、商标、署名声明；**(d) 原作品带 NOTICE 文件时，要在 NOTICE、源码 / 文档或第三方声明展示处附上其中的署名内容**。来源：[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- 本仓库：vendor/russh 是 Apache-2.0，没有 NOTICE 文件；新增的 `rt_time.rs` 头部写了“本仓库补丁”，`client/encrypted.rs`、`lib.rs`、`Cargo.toml` 在改动处有行内注释，`client/mod.rs` 的改动处没看到注释 [本仓库]；`vendor/README.md` 写了改动清单。是否满足 4(b) 的“显著声明”[待核实]，稳妥做法是每个改过的文件头部加一行。
- **ring 的许可证**：0.17.14 的 `Cargo.toml` 是 `Apache-2.0 AND ISC`，LICENSE 说 BoringSSL 来源的代码按 Apache 2.0 或 ISC [本地源码 `ring-0.17.14/LICENSE`]，两者都和 GPLv3 兼容。早期 ring 的许可证包含旧 OpenSSL 许可（带广告条款），曾被 Tor 的 arti 项目专门讨论过。来源：[arti issue #493](https://gitlab.torproject.org/tpo/core/arti/-/issues/493)；[ring on crates.io](https://crates.io/crates/ring)。**升级或换加密后端时要重新确认**。

### 6.3 生成第三方声明的工具

- **cargo-about**：为所有 Rust 依赖生成许可证清单，`cargo about init` 生成 `about.toml` 和 Handlebars 模板，`cargo about generate about.hbs > license.html` 输出。来源：[cargo-about](https://github.com/EmbarkStudios/cargo-about)。对 NOTICE 文件和许可证澄清的处理，README 没写，要看它的手册 [待核实]。
- **cargo-deny 的 licenses 检查**：在 CI 里强制“只允许这些许可证”。来源：[cargo-deny checks](https://embarkstudios.github.io/cargo-deny/checks/index.html)
- **npm 侧**：`license-checker` 一类工具 [待核实当前维护状态和推荐替代]。
- 打包进 `.app`、Docker 镜像、网页构建产物的都要覆盖：Docker 镜像里还包括 Node 运行时和基础镜像的系统包 [推论]。

### 6.4 GPL 与 App Store 的冲突

- FSF 2010 年的论证：App Store 的“使用规则”（必须接受服务条款才能用、限制安装设备数）属于 GPL 禁止的“进一步限制”；这些规则“附加在”用户和开发者之间的任何条款之上，所以即使软件是 GPL 的也照样生效；结果是苹果下架了 GNU Go。来源：[FSF: More about the App Store GPL Enforcement](https://www.fsf.org/blogs/licensing/more-about-the-app-store-gpl-enforcement)
- VLC 当年因 GPLv2 被移出 App Store。来源：[Computerworld](https://www.computerworld.com/article/1347653/gplv2-blocks-vlc-from-apple-s-app-store.html)
- 出路 [推论]：版权人自己不受 GPL 约束，可以用别的条款把自己的代码发到 App Store；或者在 GPL 之外加一条 App Store 例外（第 7 节额外许可）。**两种都要求拥有全部代码的版权，或者所有贡献者同意**——所以要在接受第一个外部贡献之前定下来。TestFlight 是否同样受这些条款约束 [待核实]。Mac 版走 Developer ID 签名 + 公证、不上 Mac App Store，就不涉及这个问题 [推论]。
- 依赖方面：Apache-2.0 / MIT 的依赖不限制上 App Store；问题只在 EverShell 自己的 GPL 代码和其他 GPL 依赖 [推论]。

### 6.5 以后想换协议或商用：DCO 与 CLA

- **DCO 1.1**：贡献者在每个提交上签名（`Signed-off-by`），声明 (a) 自己写的、有权按项目许可证提交，或 (b) 基于开源作品修改、有权按同一许可证提交，或 (c) 转交别人符合上述条件的作品，且 (d) 同意贡献和签名记录公开保存。来源：[developercertificate.org](https://developercertificate.org/)
- **区别**：两者都是“贡献者有权提交、项目有权分发”；CLA 不标准化，可能包括版权和 / 或专利授权，甚至版权转让；**DCO 不授予重新授权（relicense）的权利**，CLA（尤其含版权转让或宽泛授权的）给项目以后改许可证的灵活性。来源：[opensource.com: CLA vs. DCO](https://opensource.com/article/18/3/cla-vs-dco-whats-difference)；[CERN OSPO: CLAs and DCOs](https://ospo.docs.cern.ch/recommendations/CLAs-and-DCOs)
- `or-later` 的意思是用户可以选择 GPLv3 或 FSF 以后发布的任何新版本 [凭许可证常识；gnu.org FAQ 本次被限流没抓到，待核实原文]。

### 6.6 对 EverShell 的建议

**现在（M1）就该立的规矩：**

1. **每个源文件头部加 SPDX 标识**（`// SPDX-License-Identifier: GPL-3.0-or-later`）和版权行；vendor 里改过的 russh 文件头部加“EverShell 修改，见 vendor/README.md”。
2. **CI 跑 `cargo deny check licenses`**，允许列表先定为：GPL-3.0-or-later 兼容的 Apache-2.0、MIT、BSD-2/3-Clause、ISC、Zlib、Unicode-3.0、MPL-2.0（文件级）、CC0-1.0；遇到 GPL-2.0-only、AGPL、SSPL、旧 OpenSSL 许可、无许可证直接失败。npm 侧同样设一个允许列表。
3. **发布产物附第三方声明**：`.app` 里放 `LICENSE` + cargo-about / npm 工具生成的 `THIRD-PARTY-NOTICES`；应用“关于”页能打开它。GitHub Release 页写清源码就是对应的 tag（满足 6d）。
4. **现在就决定贡献规则**（在合并第一个外部 PR 之前）：
   - 如果确定以后要上 iOS App Store 或做商业版，选 CLA（或至少要求贡献“同时按 GPL-3.0-or-later 加 App Store 例外”授权）；
   - 如果只想纯开源、不打算上 App Store，DCO 就够（更轻量，社区更接受）；
   - 两条路都写进 `CONTRIBUTING.md`。
5. **网页版和中转**：网页版的 JS + WASM 是发给用户浏览器执行的，属于分发目标代码，页面上要给源码链接 [推论，FSF 对网页 JS 的立场待核实]；中转如果只作为服务运行不涉及 GPL 分发义务（GPL 不是 AGPL）；**Docker 镜像发布就是分发**，镜像里所有组件都要满足各自许可证。

**到哪个里程碑再做：**

- M2：Docker 镜像发布前补齐镜像内组件的声明。
- iOS 之前：找懂开源许可的律师确认 App Store / TestFlight 的方案。

**现有设计里看到的风险：**

- iOS 是规划里的平台，**纯 GPL-3.0-or-later 与 App Store 冲突**，越晚定贡献规则，越难补救（要追溯所有贡献者同意）。
- vendor/russh 的修改声明不完整（`client/mod.rs` 改动处没看到标注）。
- ring 等依赖的许可证会随版本变化，要靠 cargo-deny 持续盯。

---

## 7. 汇总：按里程碑排的规矩清单

| 时间 | 规矩 | 对应章节 |
|---|---|---|
| **M1 立即** | 威胁模型文档（数据流图 + 资产 + 攻击者 + 防 / 不防） | 1.1 |
| M1 立即 | 主机指纹校验（指纹变了硬拦截；可导入 known_hosts） | 1.6.1 |
| M1 立即 | 日志规矩（机密类型不派生 Debug、终端数据不进日志、正式版禁 trace） | 1.4 |
| M1 立即 | CI：cargo deny（advisories / licenses / bans / sources）+ npm audit + Dependabot + Actions 固定 SHA | 1.5、6.3 |
| M1 立即 | SECURITY.md + 开 GitHub 私密漏洞报告 | 1.5 |
| M1 立即 | russh 跟版：订阅公告、一周内升级；补丁提上游 | 1.6.4 |
| M1 立即 | OSC 52 只写不读（或每次询问） | 1.6.5 |
| M1 立即 | 默认 keepalive；断线状态如实显示；自动重连只建新会话 | 3.1、3.2 |
| M1 立即 | SFTP 上传先写临时文件再 posix-rename；续传要校验 | 3.3 |
| M1 立即 | 终端端到端回压（xterm 回调 → Rust 暂停读通道） | 4.1 |
| M1 立即 | 兼容测试矩阵（多版本 OpenSSH、旧算法设备、Alpine、容器） | 2.6 |
| M1 立即 | 监控不依赖 `ps pcpu`；容器内读 cgroup | 2.4 |
| M1 立即 | 所有记录带 id / updatedAt / deleted；版本迁移三规则；导出格式公开 | 5.5 |
| M1 立即 | SPDX 头；第三方声明随包发布；在第一个外部 PR 前定 DCO 还是 CLA | 6.6 |
| M1 发布前 | 发布签名、公证、更新签名私钥保管 | 1.5、1.7 |
| M2 | 同步：HLC + LWW + 墓碑永久保留；钥匙分层 + 认证 / 加密分离 + 轮换流程；服务器作恶对策 | 5.3–5.5、1.3 |
| M2/M3 | 中转短期票据（不放 URL）、默认禁内网、解析后校验 IP | 1.6.6 |
| M3 | 网页版回压 ACK；浏览器输入法 / 剪贴板兼容；网页版源码链接 | 4.5、2.6、6.6 |
| M4 | agent 转发默认关、签名提示；SOCKS 只听本机；跳板机重连 | 1.7、3.4 |
| M5 | 历史命令 / 会话日志 / AI 助手数据按机密处理 | 1.7 |
| iOS 前 | 律师确认 App Store 方案 | 6.4 |

## 8. 本次没能核实、需要后续补的

- KeePassXC 新库的默认 KDF（Argon2d 还是 Argon2id）和参数。
- russh CVE-2023-28113、CVE-2024-43410 和 2026 年 5 月几条客户端相关公告的确切修复版本。
- BusyBox 上现有监控命令的实际表现（本机 Docker 没启动，没实测）；BusyBox `rss` 的单位。
- 容器里 `/proc/stat`、`nproc` 对 cgroup 配额的处理。
- ring 是否确实没有 XChaCha20-Poly1305。
- GPL FAQ 中关于 `or later`、网页 JavaScript 分发、App Store 的条目（gnu.org 本次一直返回 429）；GPLv3 第 10 节原文措辞。
- TestFlight 是否与 App Store 一样受使用规则约束。
- 多文件并发传输的业界默认值（FileZilla、WinSCP）。
- Termius 文档中“vault 包含 Known Hosts”的具体页面。
- HLC 论文的正式出处（会议 / 年份）。
