# 规范体系调研（2026-10-18）

给 EverShell 定工程规范之前做的调研，是后面各分册的依据。正文是结论摘要，每条都附来源；完整的调研记录在三份附录里：

- [附录 A：同类开源项目怎么组织工程和文档](2026-10-appendix-a-peer-projects.md)（10 个项目，逐项附仓库文件链接）
- [附录 B：从立项到长期维护的各个阶段](2026-10-appendix-b-lifecycle.md)（12 个阶段，附 Apple、Tauri、微软、Cloudflare、NIST、OpenSSF 文档）
- [附录 C：SSH 客户端特有的重点](2026-10-appendix-c-ssh-client-concerns.md)（安全、兼容性、可靠性、性能、数据、开源协议）

标记沿用附录的约定：**【推断】**是从来源推出来的，原文没直接写；**【待核实】**是只找到二手说法或没找到一手来源，动手前要再确认。附录 C 的“现状快照”和各节的“现有设计里看到的风险”是对 2026-10-18 工作区代码的判断，代码改了就会过时。

这是一份带日期的快照，不随代码更新。以后再调研，另写一份新日期的。

---

## 0. EverShell 是什么（调研的出发点）

| 方面 | 内容 | 出处 |
|---|---|---|
| 定位 | FinalShell 风格的 SSH 客户端：终端、文件管理、服务器监控在一个窗口；核心承诺是“不跑路、数据握在自己手里” | [requirements.md](../requirements.md) 第 1 节 |
| 用户 | 现在是所有者自己（管多台 Linux 服务器的中文用户）；以后是想离开 FinalShell 的中文运维和开发者，可能还有不想自建、用所有者托管服务的人 | 需求第 1、4 节 |
| 核心能力 | SSH 终端、SFTP、无 agent 监控、快捷命令、从其他客户端导入、本地加密保险箱；以后加同步、端口转发、远程桌面、AI 助手 | 需求第 3 节 |
| 平台路线 | Mac → 网页（Rust 内核编成 WASM，经中转连 SSH）→ Windows → iOS / Android | 需求第 2 节 |
| 里程碑 | M0 技术验证（完成）→ M1 Mac 能日常用（进行中）→ M2 云同步 → M3 网页版 → M4 进阶 → M5 新功能 → M6 Windows → 手机 | 需求第 8 节 |
| 长期形态 | 多端客户端 + 同步服务（Docker 或用户自己的 Cloudflare，多账号、端到端加密、离线优先）+ 中转服务；GPL-3.0-or-later 公开仓库；以后可能有外部用户和贡献者 | 需求第 4、5 节，[README](../../README.md) |
| 开发方式 | 所有者不写代码，全部代码由 AI 写；所有者拍板产品和界面 | 项目记录 |

这几点直接决定了规范的重心：**它保管的是能登录别人服务器的东西**（安全排第一）；**它承诺数据能带走、能自建**（数据格式和导出是对外承诺）；**它要上五个平台**（现在的每个决定都不能把以后堵死）；**写代码的是 AI**（规矩要写成能自动检查的，不能只靠记得）。

---

## 1. 同类开源项目怎么组织工程和文档

调研了 5 个终端 / SSH 客户端（Tabby、Electerm、Wave Terminal、WezTerm、Alacritty）和 5 个 Tauri 2 / Rust 桌面应用（GitButler、Spacedrive、Clash Verge Rev、Yaak、Cap）。详见附录 A。

**普遍做法**（10 个里 6 个以上）：

1. **没有一个写根目录的 ARCHITECTURE.md**。架构说明放在开发说明的“目录结构”一节、给 AI 的规则文件，或模块自己的文档里。（附录 A 3.1）
2. **开发说明和贡献规矩分开**：DEVELOPMENT / HACKING 讲怎么跑起来，CONTRIBUTING 讲规矩。（Tabby、Wave、GitButler、Yaak、Spacedrive）
3. **发版流程几乎一样**：推 tag → CI 多平台构建、签名、公证 → 生成草稿 Release → 维护者人工验收 → 发布。（7 个项目，附录 A 3.1）
4. **正式版之外都有 beta、rc 或 nightly 渠道**（9/10），Tauri 项目都用 updater 的签名密钥。
5. **7/10 开了 GitHub 私密漏洞报告，只有 4 个写了 SECURITY.md，没有一个承诺响应时限**。（[GitButler SECURITY.md](https://github.com/gitbutlerapp/gitbutler/blob/master/SECURITY.md) 写了“只支持最新版”）
6. **6/10 有给 AI 的规则文件**。新趋势是 AGENTS.md 当唯一正本、CLAUDE.md 只指向它（Spacedrive、Clash、Cap）。
7. **Rust 项目 CI 三件套**：`cargo fmt --check`、`clippy -D warnings`、测试；多数加了 cargo-deny 或 cargo-audit 和依赖自动更新。

**最值得马上借鉴的**（附录 A 3.3）：

- **把守则写成自动检查**：Clash 用 CI 里的 grep 拦禁用写法（[backend-guardrails.yml](https://github.com/clash-verge-rev/clash-verge-rev/blob/dev/.github/workflows/backend-guardrails.yml)）。EverShell 的跨平台守则可以直接变成检查：`packages/ui` 里不准出现 `@tauri-apps/`，`core/storage.ts` 以外不准用 localStorage，组件里不准写死 ⌘。AI 最常犯的就是“知道规则但忘了遵守”。
- **开发版和日常用的版本分开 App ID**：GitButler 的 nightly、Yaak 的 development 配置都换了 identifier（[tauri.conf.nightly.json](https://github.com/gitbutlerapp/gitbutler/blob/master/crates/gitbutler-tauri/tauri.conf.nightly.json)）。EverShell 现在调试版和所有者日常用的版本共用钥匙串和数据目录。注意附录 B 第 5 节的提醒：**beta 和正式版**应该用同一个 identifier，靠更新渠道区分；要分开的是**开发构建**。
- **加密格式、同步格式现在就带版本号**，迁移只往前兼容（GitButler、Electerm、Spacedrive）。
- **跨会话交接文件要有长度上限**：Spacedrive 的状态文件长到 98KB 后整套任务系统冻结了（附录 A 3.3 第 7 条）。
- **中文用户更新日志从现在攒起**，照 Clash 的模板，每个用户看得见的变化一行（[Changelog 模板](https://github.com/clash-verge-rev/clash-verge-rev/blob/dev/template/Changelog.md)）。所有者不读代码，这就是他了解“这次改了什么”的渠道。
- **Yaak 的架构和 EverShell 的计划几乎一样**：Rust 内核编 WASM、网页端单独入口，网页构建里不出现 Tauri 依赖。

**分歧很大、要自己选的**：对 AI 贡献的态度（Alacritty 全禁 → Clash 要求声明 → GitButler、Cap 禁止 AI 署名）；DCO 还是 CLA；测试是默认要加还是要有理由才加；SemVer 还是 CalVer。EverShell 代码全由 AI 写，提交里署名 AI 是如实说明，和 Clash 一致。（附录 A 3.2）

**同类客户端踩过的安全坑**：Tabby 9 个 + Electerm 23 个公告，攻击者大多是**恶意或被攻破的服务器、恶意的导入或同步数据**，不是网络中间人。典型的：SFTP 文件名路径穿越、服务器给的文件名拼进 shell 命令、终端里的链接打开系统协议、导入的书签藏执行字段、同步加密用固定 IV 又没有完整性校验。对照表见附录 A 3.6，正好对应 EverShell 的 SFTP、FinalShell 导入、快捷命令和自建同步。

---

## 2. 从立项到长期维护会经过哪些阶段

详见附录 B，下表是总览（附录 B 第 0 节）：

| 阶段 | 主要产出 | 过关标准 | EverShell 现状 |
|---|---|---|---|
| 需求 | 需求文档、里程碑、待定事项 | 下一个里程碑用到的待定事项都有结论 | 已有，部分待定 |
| 技术验证 | 验证报告、风险和退路 | 没有“没验证、也没退路”的高风险项 | M0 完成 |
| 设计稿 | 可点的设计稿、确认记录 | 所有者确认 | 三张已定稿 |
| 自用版 | 能替代 FinalShell 的 Mac 版 | 连续自用 2~4 周没丢数据、没阻塞 | M1 进行中 |
| 内测 | beta 渠道、反馈入口 | beta 连续几版没有严重问题 | 未开始 |
| 签名公证 | 公证过的 .app / .dmg、发布流水线 | 干净的 Mac 上双击能开 | 只做了签名 |
| 自动更新 | 更新密钥、清单、渠道 | 上一版能自动升到这一版（实测过） | 未开始 |
| 正式发布 | 版本号规则、CHANGELOG、检查单 | 按检查单逐项过 | 未开始 |
| 移植 | 网页、Windows、手机 | 各平台签名分发走通 | 网页 M0 验证过 |
| 同步服务 | 镜像、部署、备份、监控、迁移 | 恢复演练成功；老客户端不被新服务端弄坏 | 未开始 |
| 开源社区 | 贡献说明、协议附加条款、议题模板 | 外人能照文档编译、提问题 | 只有 LICENSE |
| 漏洞响应 | SECURITY.md、私密报告、依赖跟进节奏 | 能按承诺时间回复和修复 | 未开始 |

**和这个技术栈相关、现在就要知道的结论**：

- **Mac 只走 Developer ID 直接分发，不上 Mac App Store**（沙盒和 GPL 都是障碍）；Tauri 默认开 hardened runtime，设好环境变量打包时自动公证，CI 里用 App Store Connect API 密钥（[Tauri macOS 签名](https://v2.tauri.app/distribute/sign/macos/)）。Mac 版 beta 不走 TestFlight，靠单独的更新渠道。【待核实：Apple 没有一句话明说】
- **更新私钥丢了无法挽回**，已安装的用户再也收不到更新；要离线备份两份。更新清单里任何一个平台条目不完整，所有平台都更新失败；桌面端不能回滚，只能发更高版本号的修复版（[Tauri updater](https://v2.tauri.app/plugin/updater/)）。
- **版本号只用纯数字 X.Y.Z**：Windows MSI 和 App Store 都不接受字母后缀，beta 和正式版靠渠道区分，同一个包先 beta 再推正式（附录 B 8.1）。
- **Windows 签名**：微软云签名对个人只开放美国、加拿大；EV 证书从 2024 年起不再免 SmartScreen 警告；剩下 OV 证书或 SignPath 的开源免费签名（[微软签名选项](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)）。
- **GPL 和 App Store 冲突**：只有版权持有人能主张，所以所有者可以在 LICENSE 里加一条允许经 App Store 分发的附加许可（Signal、KDE Connect 这么做过）。**必须在接受第一个外部贡献之前定**，否则要追溯每个贡献者同意（附录 B 9.3、附录 C 6.4）。全部由 AI 写的代码在版权上可能偏弱【待核实】。
- **iOS 切后台约 20~30 秒就断网**，SSH 会话会断，手机版要先做产品设计（附录 B 9.3）。
- **Cloudflare 免费计划每个请求只有 10ms CPU**，重的密钥派生必须放客户端；D1 单库单线程、免费 500MB；Worker 回滚时表结构不跟着回滚，所以只能做向前兼容的改动（[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)）。
- **安全开发框架挑最小集合**：NIST SSDF 当分类目录，OpenSSF 最佳实践徽章的“及格级”当自评清单，发布签名密钥放 GitHub 受保护环境、每次发布要所有者在网页上批准（代码全由 AI 写时尤其重要）（附录 B 第 13 节，[NIST SSDF](https://csrc.nist.gov/projects/ssdf)、[OpenSSF 徽章](https://www.bestpractices.dev/en/criteria/0)）。

---

## 3. 这类软件特有的重点

详见附录 C。每块先写业界结论，再写对 EverShell 的影响。

### 3.1 安全

- **威胁模型用 OWASP 四问 + STRIDE + 数据流图**，信任边界画在 WebView 和 Rust 之间、客户端和服务器之间（[OWASP 威胁建模](https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html)、[Tauri 安全模型](https://v2.tauri.app/security/)）。这类软件特有的两类攻击者：**恶意或被攻破的 SSH 服务器**（转义序列、畸形包、SFTP 恶意文件名、借 agent 转发用私钥）和**网络中间人**（首次连接冒充、Terrapin 降级）。资产和攻击者清单见附录 C 1.1。
- **加密选型**：XChaCha20 的 192 位 nonce 可以放心随机生成，AES-GCM 随机 nonce 同一把钥匙最多加密约 2^32 次；Argon2id 参数参考 [RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html) 和 [OWASP 密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。同步加密最值得照抄 [Standard Notes 004](https://standardnotes.com/help/security/encryption)：算法和 EverShell 完全一样，一次派生拆成“加密钥匙”和“服务器认证凭据”两半，密文自带版本号。
- **日志不许漏机密**（[OWASP 日志](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)）：机密类型不派生 Debug，终端数据和文件内容不进日志。
- **依赖审计和漏洞披露**：cargo-deny（漏洞 + 协议）、Dependabot、Actions 固定 SHA；SECURITY.md + GitHub 私密漏洞报告。
- **russh 漏洞很密集**：GitLab 漏洞库收录 22 条，2026 年就有 17 条（附录 B 按 GitHub 列表数约 20 条），几条是恶意服务器能打客户端（[GitLab 漏洞库](https://advisories.gitlab.com/pkg/cargo/russh/)、[russh 公告](https://github.com/Eugeny/russh/security/advisories)）。vendor 补丁让 Dependabot 帮不上忙，每次都要手工合；**把两处补丁提给上游**是降低维护成本最有效的一步。
- **终端转义序列 OSC 52**：xterm.js 剪贴板插件默认会响应远端的“读剪贴板”请求，恶意服务器能偷走用户刚复制的密码；要用就改成只写不读（附录 C 1.6.5）。
- **CSP 没开**（`csp: null`）：Tauri 只有配置了 CSP 才启用保护（[Tauri CSP](https://v2.tauri.app/security/csp/)）。

### 3.2 兼容性

- OpenSSH 一路在收紧：8.8 默认禁 `ssh-rsa`（SHA-1），9.0 默认后量子混合密钥交换，10.0 删除 DSA、sshd 默认关有限域 DH（[OpenSSH 发布说明](https://www.openssh.org/releasenotes.html)，逐版本表见附录 C 2.1）。老服务器和网络设备只有旧算法，OpenSSH 的做法是按主机追加旧算法（[Legacy options](https://www.openssh.org/legacy.html)）。
- **监控采集在不同环境差别很大**：BusyBox / Alpine 的 ps 不支持现在用的字段【推断，未实测】，容器里 /proc 显示的是宿主机内存，非英文 locale 会改命令输出，登录脚本打印文字会污染输出（附录 C 2.4）。
- **终端显示**：中文和 emoji 宽度要装 xterm.js 的 Unicode 11 插件；vim、tmux、真彩色、括号粘贴、输入法要有手测清单（[xterm.js 支持的序列](https://xtermjs.org/docs/api/vtfeatures/)）。

### 3.3 可靠性

- **keepalive**：russh 默认不发，NAT 超时后会话“假在线”；建议 15 秒一次、3 次无响应判断断线（附录 C 3.1）。
- **重连只建新会话**，可选登录后自动接回 tmux；不做协议级会话恢复（[Mosh](https://mosh.org/)、[Eternal Terminal](https://eternalterminal.dev/howitworks/) 的思路和代价见附录 C 3.2）。
- **SFTP 上传先写临时文件、传完再改名覆盖**，中途断线不会毁掉服务器上的原文件；续传要校验（[WinSCP 的做法](https://winscp.net/eng/docs/resume)）。

### 3.4 性能

- **终端要端到端回压**：xterm.js 每秒能处理的数据有限，写缓冲超过上限会丢数据；按 [xterm.js 流控指南](https://xtermjs.org/docs/guides/flowcontrol/) 用回调做 ACK，让 Rust 暂停读通道。验收例子：`yes` 跑 10 秒后 Ctrl-C，1 秒内停。
- 吞吐基准可以用 [vtebench](https://github.com/alacritty/vtebench) 手测，有回归再上 CI。

### 3.5 数据

- **所有持久化格式带版本号**，三条规则：读到更高版本只读或拒绝、绝不覆盖写回；读到旧版本逐级迁移、迁移前先备份；每个版本留样例文件做测试（附录 C 5.1）。
- **记录现在就带 id、更新时间、删除标记（墓碑）**，M2 再加就要迁移所有用户数据。
- **同步冲突**建议“逐条记录最后写入胜出 + 混合逻辑时钟（HLC）+ 墓碑永久保留”，不上通用 CRDT；需求文档的“比较版本号”没说清两台离线设备同时改谁算新（附录 C 5.3）。
- **导出格式写成公开文档**，这是“不跑路”承诺的一部分。

### 3.6 开源协议合规

- Apache-2.0 和 GPLv3 兼容（[FSF 协议列表](https://www.gnu.org/licenses/license-list.html)）；vendor 里改过的 russh 文件要标“已修改”（Apache-2.0 第 4 条）。
- 发二进制要附源码获取方式、许可证和第三方声明（用 [cargo-about](https://github.com/EmbarkStudios/cargo-about) 之类生成）；cargo-deny 可以把不兼容 GPL 的依赖协议拦在 CI。
- DCO 只证明贡献者有权贡献，拿不到改协议的权利；以后想上 App Store 或改协议，要 CLA 或在贡献条款里带上附加许可（附录 C 6.5）。

---

## 4. 读代码时发现的现状风险（2026-10-18）

调研时顺带读了代码，下面这些是现在就存在的问题，不是规范层面的事。是否、何时修由所有者定，规范体系里只记录“这类问题以后怎么防”。

| 风险 | 后果 | 依据 |
|---|---|---|
| 服务器指纹一律接受（M0 报告已列为 M1 必做） | 中间人能拿到密码登录时的明文密码 | 附录 C 0、1.6.1 |
| 终端输出没有回压 | 大量输出时内存一直涨、屏幕乱、Ctrl-C 很久才停 | 附录 C 4.1 |
| SFTP 上传直接截断目标文件 | 传一半断线，服务器上原文件就坏了 | 附录 C 3.3 |
| 不发 keepalive | 断线后标签还显示“已连接” | 附录 C 3.1 |
| CSP 没开 | 少一层防注入保护 | 附录 B 第 4 节 |
| Alpine 上监控进程列表可能是空的【未实测】 | 监控显示不全 | 附录 C 2.4 |
| 调试版和日常版共用数据 | 测试可能弄坏所有者的真实连接和密码 | 附录 A 3.3 |

**这份文档和附录在公开仓库里会被所有人看到**，其中写明了还没修的安全问题。提交前要所有者决定：先修再提交，或者接受（现在只有所有者自己在用）。

---

## 5. 对规范体系的输入

| 调研结论 | 落到哪 |
|---|---|
| 守则写成自动检查；修 bug 先写失败的测试；只跑相关检查 | 质量关卡 |
| 威胁模型、加密选型依据、日志规矩、依赖审计、漏洞披露、OSC 52、CSP | 安全 |
| OpenSSH 算法变化、旧设备、发行版和容器、终端手测清单 | 兼容性 |
| keepalive、重连、SFTP 临时文件、回压、性能预算 | 架构与分层（运行时约定）+ 质量关卡（验收标准） |
| 格式版本三规则、记录带 id / 时间 / 墓碑、导出格式公开、HLC | 数据与迁移 |
| 版本号、CHANGELOG、草稿 Release、签名公证、更新密钥、渠道、密钥清单 | 发布与版本 |
| GPL 义务、附加许可、DCO / CLA、SPDX、第三方声明 | 开源与合规 |
| AI 规则文件的组织、交接文件长度上限、外部内容当数据 | AI 协作 |
| 开发版独立 App ID | 环境速查 + 安全（保护所有者的真实数据） |
| 同步服务的 Cloudflare 限制、备份恢复、API 版本 | 同步服务分册（M2 前写） |
| 中转鉴权、禁内网、网页版回压、浏览器兼容 | 网页版分册（M3 前写） |
| Windows 签名路线、WebView2 | Windows 分册（M6 前写） |
| iOS 后台断网、出口合规、GPL 附加许可 | 手机分册（手机版前写） |

## 6. 没核实的

汇总自各附录末尾：KeePassXC 的默认 KDF；russh 几条旧 CVE 的确切修复版本；BusyBox 上监控命令的实际表现；容器里 /proc 对 cgroup 配额的处理；GPL FAQ 关于网页 JavaScript 和 App Store 的条目（调研时 gnu.org 一直限流）；Mac 版 Developer ID 与 TestFlight 的关系；多文件并发传输的业界默认值；AI 生成代码的版权地位。用到时再查。
