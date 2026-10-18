# 附录 B：EverShell 从立项到长期维护的各个阶段

> 调研日期：2026-10-18。只调研，没改仓库。
> 写法：每条结论后面用方括号标来源，链接统一列在文末“来源”一节，点进去是原文。
> - 没标特殊记号的，来自官方文档或项目自己的公告。
> - **【推断】**：根据来源推出来的，原文没直接写。
> - **【待核实】**：只查到社区或二手说法，或者官方文档没写清，动手前要再确认。
>
> 对照仓库现状：`docs/requirements.md`（需求）、`docs/m0-report.md`（技术验证）、`docs/design/*.dc.html`（设计稿）都已经有了；仓库里还没有 `.github/`（没有 CI），没有 SECURITY.md、CHANGELOG；`tauri.conf.json` 里 `csp: null`；russh 用的是 `vendor/russh` 打补丁的 0.64.1。

---

## 0. 总览

| 阶段 | 主要产出 | 进入下一阶段的标准 | EverShell 现状 |
|---|---|---|---|
| 1 需求 | 需求文档、里程碑、待定事项 | 当前里程碑涉及的待定事项都有结论 | 已有，部分待定 |
| 2 技术验证 | 验证报告、风险清单和退路 | 高风险项要么通过，要么有退路 | M0 已完成 |
| 3 设计稿 | 可点的设计稿、所有者确认记录 | 所有者确认 | 已有三张 |
| 4 自用版（dogfood） | 能日常替代 FinalShell 的 Mac 版 | 连续自用 2~4 周没有丢数据、没有阻塞问题 | M1 进行中 |
| 5 内测 | beta 渠道、反馈渠道、已知问题 | beta 连续若干版没有严重问题 | 未开始 |
| 6 签名公证打包 | 公证过的 .app / .dmg、CI 发布流水线 | 干净的 Mac 上双击能打开，没有 Gatekeeper 警告 | 只做了签名 |
| 7 自动更新 | 更新密钥、更新清单、渠道 | 上一版能自动升到这一版（N-1→N 实测过） | 未开始 |
| 8 正式发布 | 版本号规则、CHANGELOG、发布检查单、回退办法 | 按检查单逐项过 | 未开始 |
| 9 移植 | 网页版、Windows、iOS/Android | 每个平台各自的签名和分发走通 | 网页版 M0 验证过 |
| 10 同步服务上线 | Docker 镜像、Cloudflare 部署、备份、监控、迁移 | 恢复演练成功；老客户端不被新服务端弄坏 | 未开始 |
| 11 开源社区 | README、贡献说明、许可证附加条款、议题模板 | 外人能照文档编译、能提问题 | 只有 LICENSE |
| 12 漏洞响应和长期维护 | SECURITY.md、私密报告渠道、依赖更新节奏 | 收到报告后能按承诺时间回复和修复 | 未开始 |

---

## 1. 需求

**要做什么**：写清楚给谁用、做什么、不做什么、平台顺序、里程碑。没定的事列成“待定事项”，每项写上最晚在哪个里程碑前要定。

**产出**：`docs/requirements.md`（已有）。

**过关标准**：下一个里程碑用到的待定事项都有结论。比如开源协议已经定为 GPL-3.0-or-later；但“开放给别人用时的注册方式和配额”“恢复码”要在 M2 同步服务开工前定。

**典型的坑**：
- “以后可能给别人用”这类方向，最影响早期设计的是账号、数据隔离和配额。需求文档已经要求从第一版就做进去，这是对的。等有了用户再补，就要做数据迁移。【推断】
- 有些对外承诺会变成法律义务。例如欧盟《网络韧性法》（CRA）从 2026-09-11 起要求制造商在 24 小时内预警“正在被利用的漏洞”[ENISA-CRA]，但非商业、不收费提供的开源软件不在范围内[EU-CRA-OSS]。EverShell 现在免费自用，不受影响；以后如果对同步服务收费，要重新评估。【待核实：收费托管服务是否把客户端也带进范围，需要看委员会的正式指南】

---

## 2. 技术验证

**要做什么**：把风险最高的技术路线先跑通，每个风险要么验证通过，要么写好退路。

**产出**：验证报告（`docs/m0-report.md` 已有，写得很完整：结论表、踩坑、遗留事项、复现命令）。

**过关标准**：没有“没验证、也没退路”的高风险项。

**EverShell 遗留到后面的风险**（摘自 M0 报告，下文各阶段会接上）：
- 服务器指纹没校验（M1 必须做）。
- 中转用的是固定令牌，持有令牌就能连中转所在网络的任意地址（M3 前必须改）。
- Workers 中转没有真实部署，Cloudflare 生产环境的限制还没实测。
- 用的是打了补丁的 russh（`vendor/russh`）。

**典型的坑**：
- **自己维护的依赖分支会落后上游的安全修复。** russh 在 2026 年发了约 20 个安全公告，其中几个是 high（比如未认证就能触发的内存耗尽、解压后包大小没限制）[russh-advisories]。用 vendor 分支，每次上游出安全版本都要手工合补丁。M0 报告建议把补丁提给上游，这件事应该尽早做。
- 技术验证用本机回环网络测出的延迟不代表真实网络，M0 报告自己也写了这一点。

---

## 3. 设计稿

**要做什么**：写界面之前先出可点击的设计稿，所有者确认后再写代码（这是所有者定的规矩，见记忆文件）。

**产出**：`docs/design/*.dc.html`，加上确认记录（日期、确认了什么）。

**过关标准**：所有者确认。

**典型的坑**：
- 跨平台守则第 4 条要求“重要操作要有能点的入口，不能只靠悬停或右键”。设计稿阶段就该按这一条检查，不然手机版要返工。【推断】
- 设计稿只覆盖“正常路径”。连接失败、指纹变了、钥匙串拒绝访问、更新失败这些状态也要出图，不然实现时由 AI 自由发挥，风格会不统一。【推断】

---

## 4. 第一个能日常用的版本（M1，自用 / dogfood）

**要做什么**：所有者用它替代 FinalShell 干日常活。功能范围见需求文档 M1。

**产出**：
- 能装在自己 Mac 上的 .app（现在 `scripts/build-mac.sh` 能出 Developer ID 签名的 .app，没公证）。
- 已知问题清单。
- 本地数据导出 / 备份功能（需求文档写了“随时导出”）。

**过关标准（建议）**：
- 连续自用 2~4 周，没有丢数据，没有“必须切回 FinalShell 才能干完活”的情况。
- 安全底线：服务器指纹校验（known_hosts、首次连接确认、指纹变了要拦截）。没有这一条，SSH 客户端会把密码交给中间人。
- 本地数据可以导出，导出的文件能导回。

**典型的坑**：
- **本地数据格式没有版本号。** 自用阶段改格式最随意，到了要同步、要给别人用时，老数据读不出来。从现在起，`core/storage.ts` 存的每类数据都带一个格式版本号，迁移前先自动备份。【推断】
- **CSP 没开。** Tauri 只有在配置里写了 CSP 才会启用 CSP 保护[Tauri-CSP]，现在是 `csp: null`。终端会显示远程服务器输出的任意内容，界面里一旦有地方把远程内容当 HTML 渲染，就可能被注入脚本；有 CSP 能多挡一层。前端用了 WASM 时要在 `script-src` 加 `'wasm-unsafe-eval'`[Tauri-CSP]。Tauri 2026 年也发过“远程页面能调用本地 IPC 命令”一类的公告[Tauri-advisories]，Tauri 版本也要跟上。
- **更新签名密钥漏进前端包。** Tauri 出过这类公告：Vite 的 `envPrefix` 如果包含 `TAURI_`，更新私钥可能被打进前端[Tauri-GHSA-updater-key]。EverShell 现在的 `envPrefix` 是 `['VITE_', 'TAURI_ENV_*']`，私钥变量名 `TAURI_SIGNING_PRIVATE_KEY` 不在里面，**目前是安全的**；以后改 vite 配置时要保持。

---

## 5. 内测（beta、TestFlight）

**要做什么**：让少数别人（或所有者的其他设备）先装 beta 版，收集崩溃和反馈。

**产出**：beta 更新渠道、反馈入口（GitHub Issues 模板）、已知问题列表。

**过关标准（建议）**：beta 连续 2~3 个版本没有严重问题（丢数据、连不上、更新失败），再把同一个包推到正式渠道。

**Mac 版的内测怎么发**：
- **TestFlight 基本用不上。** Mac 上的 TestFlight 要求 App 带沙盒和描述文件，走的是 Mac App Store 那条线[Apple-forum-TF-mac]；Developer ID 直接分发的 App 不走 TestFlight。【待核实：Apple 没有一句话写明“Developer ID 不能用 TestFlight”，是从论坛里 Apple 工程师的回答推出来的】
- 所以 Mac 版 beta 的现实做法是：同一套 Developer ID 签名 + 公证，配一个单独的 beta 更新渠道（见第 7 节）。

**iOS 的 TestFlight（以后用）**：
- 内部测试员最多 100 人（团队成员），外部测试员最多 10,000 人；外部测试前要先过“TestFlight 版的 App 审核”，还要填 beta 说明[Apple-TestFlight]。
- 每个 build 最多能测 90 天，到期自动失效；上传新 build 重新算 90 天[Apple-TF-overview]。
- 上传到 TestFlight 也算“出口加密软件”，要回答加密出口合规问题；在 Info.plist 里写 `ITSAppUsesNonExemptEncryption` 可以省掉每次的问卷[Apple-encryption-export][Apple-ITSAppUses]。SSH 客户端用的是自带的加密实现（russh + ring），不是系统自带的 HTTPS，可能不算“豁免”，可能要交材料或每年报自分类报告[Apple-encryption-export]。【待核实：具体怎么分类，要按 Apple 的问卷逐项答】
- TestFlight 也受 Apple 条款约束，GPL 的冲突同样存在（见 9.3）。

**典型的坑**：
- 内测用户最常遇到的不是功能 bug，而是“装不上 / 打不开 / 更新后打不开”。所以第 6、7 节要在内测之前做完。【推断】
- beta 版和正式版用不同的包名（identifier）会导致钥匙串、数据目录分家，测试结果不代表正式版。建议同一个 identifier，靠更新渠道区分。【推断】

---

## 6. 签名、公证、打包（macOS）

### 6.1 Apple 的要求

- Developer ID 直接分发的软件必须公证：macOS 10.15 起，2019-06-01 之后构建的 Developer ID 软件都要公证；Mac App Store 的不用[Apple-notarize]。
- 公证的前置条件（Apple 列的清单）[Apple-notarize]：
  1. 所有可执行文件都签名，签名有效。
  2. 用 Developer ID 证书签（不能用开发证书、ad hoc）。
  3. 开启 hardened runtime。
  4. 签名带安全时间戳（`--timestamp`，只认 `timestamp.apple.com`，需要联网）[Apple-notarize-issues]。
  5. 不能带 `com.apple.security.get-task-allow`（调试用的权限）。
  6. entitlements 文件是格式正确的 XML。
- `altool` 从 2023-11-01 起不能再用于公证，要用 `notarytool`；已经公证过的旧软件不受影响[Apple-notarize][Apple-DevID]。`notarytool submit --wait` 等结果，`notarytool log` 拿日志；**成功了也要看日志里的警告**[Apple-notarize-workflow]。
- 公证一般不到一小时[Apple-notarize-workflow]。
- **staple（把公证票据钉到文件上）**：不钉的话，Gatekeeper 在线查票据；钉上之后断网也能验证。.app、.dmg、.pkg 都能钉，**zip 不能钉**，要先钉里面的 .app 再重新打 zip[Apple-notarize-workflow]。
- hardened runtime 的例外权限（JIT、关闭库校验等）**只在确实需要时加**；默认都是 false，值为 false 的权限干脆不要写进文件[Apple-hardened-runtime]。EverShell 不加载插件、不自己做 JIT（WebView 的 JS 引擎跑在系统的 WebKit 进程里），**大概率一个例外权限都不需要**。【推断，打包后用 `codesign -d --entitlements -` 检查】
- 证书和会员到期：证书有效时签的 App，证书过期后用户仍能下载运行，但签新版本要新证书；会员过期，已签名的 App 仍能装能用；**证书被吊销，已装的也打不开**[Apple-DevID-support]。每个账号最多 5 张 Developer ID Application 证书；只有 Account Holder 能创建[Apple-DevID-support]。
- 公证还有一层保护：Apple 记录了用你密钥签过的所有软件，如果签名密钥泄露、出现冒充版本，可以找 Apple 吊销那些版本的票据[Apple-notarize]。

### 6.2 Tauri 2 的配置

- `bundle > macOS > signingIdentity`，或环境变量 `APPLE_SIGNING_IDENTITY`；CI 里用 `APPLE_CERTIFICATE`（base64 的 .p12）+ `APPLE_CERTIFICATE_PASSWORD` 导入临时钥匙串[Tauri-sign-macos]。EverShell 已在 `tauri.macos.conf.json` 写了 `"Developer ID Application"`。
- `bundle > macOS > hardenedRuntime` 默认就是 `true`[Tauri-schema]，不用手动开。
- `bundle > macOS > entitlements` 指向 entitlements 文件；`minimumSystemVersion` 默认 10.13[Tauri-macos-bundle][Tauri-schema]。
- 公证用的环境变量二选一[Tauri-sign-macos]：
  - App Store Connect API 密钥：`APPLE_API_ISSUER`、`APPLE_API_KEY`、`APPLE_API_KEY_PATH`（推荐给 CI，不依赖个人 Apple ID 密码）。
  - Apple ID：`APPLE_ID`、`APPLE_PASSWORD`（App 专用密码）、`APPLE_TEAM_ID`。
- 设了这些变量，`tauri build` 会自动公证；有 `--skip-stapling` 参数，说明默认会 staple[Tauri-sign-macos]。【推断：文档没明说“默认 staple”】
- Tauri 文档的 CI 示例里 grep 的是 “Apple Development” 证书，照抄会选错证书，要改成 Developer ID[Tauri-sign-macos]。

### 6.3 产出和过关

**产出**：签名 + 公证 + staple 的 `EverShell.app` 和签名过的 `.dmg`；CI 里一条“打 tag 就出包”的流水线（`tauri-action` 能构建、建 GitHub Release、上传产物、生成更新清单 `latest.json`[tauri-action]）。

**过关标准**：在一台**没装过开发工具、从浏览器下载**的 Mac 上：
```
spctl -vvv --assess --type exec /Applications/EverShell.app     # 显示 Notarized Developer ID
xcrun stapler validate EverShell.dmg
codesign -vvv --deep --strict /Applications/EverShell.app
```
都通过，双击打开没有“无法验证开发者”[Apple-notarize-issues]。

**典型的坑**：
- 签名之后又改了包里的文件，签名失效，公证报 “The signature of the binary is invalid”[Apple-notarize-issues]。所有改动（包括写 Info.plist、塞资源）要在签名之前做完。
- **App 转移（translocation）**：从“下载”文件夹直接运行带隔离标记的 App，系统会把它复制到随机的只读位置运行，App 自己更新自己会失败；用签名的 DMG 分发比 zip 好，但 Ventura 之后挪到“应用程序”也不一定能完全避免[translocation-eclectic][translocation-mjtsai]。【待核实：Tauri updater 有没有专门处理，没查到 Tauri 的说明】要在“首次运行引导”里提示用户拖进“应用程序”。
- 要不要出 universal（Intel + Apple Silicon）包：用 `--target universal-apple-darwin`[Tauri-app-store]。更新清单按 `darwin-aarch64` / `darwin-x86_64` 分平台[Tauri-updater]，universal 包要两个键都填。【待核实：Tauri 有没有 `darwin-universal` 键，没查到官方说法】
- 证书私钥（.p12）、API 密钥都是“能冒充你发软件”的东西，只能放 CI 的受保护环境（见第 12 节），不进仓库，不进 AI 能随便读到的文件。

### 6.4 要不要上 Mac App Store

- Mac App Store 要求 App 沙盒[Tauri-app-store]。SSH 客户端要读 `~/.ssh/config`、私钥、任意本机目录做 SFTP 上传下载，在沙盒里每个位置都要用户手动授权。【推断】
- 加上 GPL 与 App Store 条款冲突（9.3），**建议 Mac 版只走 Developer ID 直接分发**。

---

## 7. 自动更新（Tauri 2 updater 插件）

### 7.1 机制

- 先用 `tauri signer generate -w ~/.tauri/xxx.key` 生成一对密钥：公钥写进 `tauri.conf.json`（`pubkey` 填内容，不是路径），私钥签每个更新包；**签名是强制的，不能关**[Tauri-updater]。
- 打包时用环境变量 `TAURI_SIGNING_PRIVATE_KEY`（路径或内容）和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；**`.env` 文件不生效**[Tauri-updater]。
- `bundle > createUpdaterArtifacts: true` 才会生成更新包。Mac 生成 `EverShell.app.tar.gz` 和 `.sig`；Windows 直接复用 NSIS 的 `-setup.exe` 和 MSI，各配一个 `.sig`[Tauri-updater]。
- `endpoints` 是 URL 数组，生产环境强制 HTTPS；URL 里能用 `{{current_version}}`、`{{target}}`、`{{arch}}`[Tauri-updater]。
- 两种服务端[Tauri-updater]：
  - **静态 JSON**（如 GitHub Releases 上的 `latest.json`）：必填 `version`、`platforms.<os-arch>.url`、`platforms.<os-arch>.signature`（是 .sig 的内容，不是链接）。**Tauri 会先校验整个文件再比版本**，任何一个平台的条目不完整，所有平台都更新失败。
  - **动态服务**：没有更新返回 204，有更新返回 200 + JSON。
- 默认只有新版本号大于当前版本才更新；要允许降级得自己写 `version_comparator`[Tauri-updater]。
- 需要在 capabilities 里加 `updater:default`[Tauri-updater]。

### 7.2 更新清单放哪

| 方案 | 优点 | 缺点 |
|---|---|---|
| GitHub Releases + `latest.json`（`tauri-action` 自动生成[tauri-action]） | 零运维、免费，和开源发布合一 | `releases/latest` **只指向最新的非预发布、非草稿版本**[GitHub-latest-release]，beta 渠道要另想办法；国内网络访问 GitHub 下载可能慢【待核实】 |
| 自建（放同步服务或 R2） | 能按渠道、按用户、按比例灰度；能做“最低版本强制升级” | 多一个要运维的服务，挂了就没人能更新 |

**建议**：M1 结束到 M2 之间用 GitHub Releases。stable 渠道用 `releases/latest/download/latest.json`；beta 渠道单独放一个 JSON（比如固定 tag `updater-beta` 下的 `latest-beta.json`，每次发 beta 覆盖），客户端按用户选择的渠道在运行时切换 endpoint（Rust 里 `updater_builder().endpoints(...)`，`format!` 里变量要写成 `{{{{target}}}}`）[Tauri-updater]。有了同步服务以后再考虑迁到自建动态服务。【推断：固定 tag 的做法是常见做法，不是 Tauri 文档原文】

### 7.3 更新密钥丢了 / 泄露了怎么办

- Tauri 原话的意思：**私钥丢了，已经装了 App 的用户就再也收不到更新**[Tauri-updater]。只能让所有用户手动下载新版重装。
- 泄露了：生成新密钥，把新公钥写进配置，**下一个版本仍用旧私钥签**（老客户端只认旧公钥），之后的版本才用新私钥[Tauri-GHSA-updater-key]。插件也支持在运行时设置公钥，方便轮换[Tauri-updater]。
- 所以“丢了”比“泄露”更糟：泄露还能过渡，丢了没法挽回。

**规矩（建议）**：
1. 第一个给别人装的版本发出前就生成密钥，之后不换。
2. 私钥 + 密码存两份离线备份（比如密码管理器一份、加密 U 盘一份），写一份“密钥清单”文档记录**放在哪、谁能拿到、怎么恢复**，文档里不写密钥本身。
3. 私钥只放 CI 的受保护环境，开发机上不常驻。
4. 可以考虑在 App 里预埋**两个公钥**（主用 + 备用，备用私钥离线保管），这样主私钥丢了还能用备用私钥签。【推断：Tauri 支持运行时设置公钥[Tauri-updater]，但“同时接受两个公钥”要自己实现或确认插件是否支持，待核实】

### 7.4 过关和坑

**过关标准**：每次发版前，**装上一个正式版，让它自己升级到这一版**，确认升级后能启动、数据还在、能再检查更新（N-1→N 实测）。

**典型的坑**：
- 一旦推出去的更新把“更新功能”本身弄坏了，用户就卡在那个版本，只能手动重装。所以 N-1→N 实测不能省。【推断】
- 桌面端没法真正“回滚”：默认不允许降级[Tauri-updater]。出事后的做法是**马上发一个更高版本号的修复版**（内容可以就是上上个版本的代码）。【推断】
- Windows 上安装更新时 App 会自动退出；`installMode` 默认 `passive`（有进度窗、不用点），`quiet` 只适合按用户安装或已有管理员权限的情况[Tauri-updater]。
- `latest.json` 里漏了一个平台，全平台更新失败（见 7.1）。CI 里加一步校验 JSON 完整性。

---

## 8. 正式发布：版本号与发布纪律

### 8.1 版本号

- SemVer：主版本号（不兼容的改动）. 次版本号（新功能）. 修订号（修 bug）；0.y.z 是早期开发，随时可能变；“已经在生产环境用了，就该是 1.0.0”[SemVer]。
- **EverShell 的特殊约束**（几个平台对版本号格式要求不同）：
  - Windows MSI：预发布标识只能有一个，**且只能是纯数字**（`1.2.0-1` 可以，`1.2.0-beta.1` 不行）[Tauri-bundler-1.2]；MSI 的主、次版本号还有 255 的上限。【待核实：255 上限来自 WiX/Windows Installer 的说法，没查到 Tauri 文档原文】
  - App Store / TestFlight：对外版本号要求是三段整数，build 号是一到三段整数且要递增[Apple-glossary]。
  - 结论：**版本号只用纯数字 `X.Y.Z`，不用 `-beta` 后缀**；beta 和 stable 靠更新渠道区分，beta 验证过的**同一个包**直接推到 stable（“构建一次、逐级推广”）。【推断】
- 版本号只在一处维护：Tauri 推荐写在 `tauri.conf.json`，没写才回退到 `Cargo.toml`[Tauri-distribute]。Rust crate、npm 包、同步服务各有自己的版本号，但发布时要能对上（在 CHANGELOG 里写“需要同步服务 ≥ x.y”）。

### 8.2 CHANGELOG

- 按 Keep a Changelog：给人看的；每个版本一节，最新的在上面，写日期；分类用 Added / Changed / Deprecated / Removed / Fixed / Security；顶部留 `Unreleased` 一节平时往里记，发版时挪进新版本；撤回的版本标 `[YANKED]` 但不删[KeepAChangelog]。
- OpenSSF 徽章的及格标准也要求每个版本有给人看的发布说明，并列出修了哪些已知 CVE[OpenSSF-Badge]。

### 8.3 发布检查单（建议，可以写成 `docs/dev/release-checklist.md` 并逐步脚本化）

1. CHANGELOG 的 `Unreleased` 已挪到新版本号下，写了日期。
2. 版本号在 `tauri.conf.json` 改好，打 tag（`vX.Y.Z`）。
3. CI 全绿：Rust 测试、前端类型检查、`cargo check -p ssh-wasm --target wasm32-unknown-unknown`、依赖漏洞和许可证检查。
4. CI 产出签名 + 公证 + staple 的包；`spctl`、`stapler validate` 通过（6.3）。
5. `latest.json` 各平台条目齐全（7.1）。
6. **N-1→N 自动升级实测**（7.4）。
7. 先发 beta 渠道，观察几天，再把同一个包推到 stable。
8. GitHub Release 设为不可变（immutable）：发出后附件不能改、tag 不能挪，GitHub 会自动生成发布证明[GitHub-immutable]。【注意：有用户反映先建草稿再手动传附件会让证明失效[GitHub-immutable]，用 CI 一次性发】
9. 如果同步服务要配合升级：先升服务端（兼容新旧客户端），再发客户端（见第 10 节）。

### 8.4 回滚

- 桌面客户端：不能降级，只能“往前修”（7.4）。所以 beta 渠道是主要的防线。
- Cloudflare Worker：`wrangler rollback` 或控制台回滚，能回到最近 100 个版本；**但绑定的资源（D1 数据、表结构）不会跟着回滚**，旧代码遇到新表结构可能直接坏[CF-rollbacks]。
- Docker 自建版：镜像打版本号 tag，回滚就是换回旧 tag；数据库同样不会自动回退。【推断】
- 结论：**数据库只做“向前兼容”的改动**（第 10 节的“扩展-迁移-收缩”），这样代码回滚才安全。

---

## 9. 移植到其他平台

### 9.1 网页版（M3）

**要做什么**：WASM 内核 + 只转发字节的中转（自建 Node / Cloudflare Workers），账号登录，PWA。

**中转的部署限制（Cloudflare）**：
- Workers 的 `connect()` 不能连 Cloudflare 自己的 IP 段，不能连 localhost 和内网地址；25 端口默认封；连回自己也不行[CF-TCP]。用户的服务器如果套了 Cloudflare 代理，就连不上。
- 每个请求同时打开的出站连接最多 6 个（含 TCP socket）[CF-Workers-limits][CF-TCP]。一个浏览器会话对应一个 WebSocket 请求，6 个够用；但如果设计成一个 WebSocket 复用多条 SSH，就会撞上限。【推断】
- 免费计划：每天 10 万请求，**每个请求 CPU 时间 10 ms**；付费计划默认 30 秒、最多 5 分钟[CF-Workers-limits]。等网络 I/O 不算 CPU 时间，所以纯搬字节的中转可能撑得住，但 10 ms 很紧[CF-Workers-limits]。【待核实：WebSocket 长连接在 Worker 里是按整个请求累计 CPU，还是按每条消息计；Durable Objects 是按每条 WebSocket 消息算一次调用、默认 30 秒[CF-DO-limits]】**部署到用户自己的免费账号前必须实测**。
- WebSocket 单条消息最大 32 MiB，超了用 1009 关闭[CF-Workers-WS]。
- 如果用 Durable Objects 托管 WebSocket：**部署新版本会重启所有 Durable Object，断开现有连接**[CF-DO-WS]。也就是说每次部署中转，所有人的网页 SSH 会话都会断。普通 Worker 在运行时更新时连接能多撑一会儿，但最终也会断，官方建议客户端自动重连并恢复状态[CF-Workers-WS]。
- 免费计划也能用 Durable Objects（仅 SQLite 后端），有每日额度[CF-DO-pricing]。

**鉴权和防滥用**：
- M0 报告已经点出：持有令牌就能让中转去连任意地址。OWASP 的建议[OWASP-SSRF]：能用白名单就用白名单；做不到时至少拒绝回环、内网（RFC1918）、链路本地、IPv6 本地地址和云厂商元数据地址（169.254.169.254）；**校验的是 DNS 解析出来的 IP，并且用校验过的 IP 去连**，防 DNS 重绑定；只接受“主机 + 端口”，不接受完整 URL；网络层再加一道出站防火墙。
- 自建版默认禁止内网地址，提供“允许连内网”的开关（自建在家里的人确实需要连内网）。【推断】
- 令牌改成“登录后签发的短期票据”（M0 报告已列）；按账号限制并发连接数；Cloudflare 的 Rate Limiting 绑定适合防刷，但它是按机房、最终一致的，官方明说“不是精确计数系统”，不能拿来做计费配额[CF-ratelimit]。

**PWA**：可安装、独立窗口、弱网或断网时最近用过的内容还能用[webdev-PWA]。网页版的 CSP、子资源都从自己的域名加载（OpenSSF 简明指南也建议生产环境只从自己控制的域名加载资源[OpenSSF-Concise]）。

**过关标准**：在真实 Cloudflare（免费账号和付费账号各一次）和一台 VPS 上部署通；中转拒绝内网地址的测试用例通过；部署新版本后浏览器能自动重连。

### 9.2 Windows（M6）

**签名路线**（对“个人开发者、不在美国/加拿大”的情况尤其重要）：

| 方案 | 费用 | 能不能用 | SmartScreen |
|---|---|---|---|
| Microsoft Store（MSIX，商店重签） | 免费 | 全球 | 不弹警告[MS-signing-options] |
| Azure Artifact Signing（原 Trusted Signing） | 约 $9.99/月 | **个人只限美国、加拿大**；机构限美、加、欧盟、英国[MS-signing-options] | 信誉慢慢积累 |
| OV 证书 | $150–300/年 | 全球；2023-06 起私钥必须放硬件或云 HSM[MS-signing-options] | 信誉慢慢积累 |
| EV 证书 | $400+/年 | 全球 | **2024 年起和 OV 一样，不再直接免警告**[MS-signing-options][MS-SmartScreen] |
| SignPath Foundation | 开源项目免费 | 要申请，有条件 | 发布者显示为 SignPath Foundation[SignPath-terms] |

- SmartScreen 看两样：发布者证书的信誉和文件哈希的信誉；新文件即使签了名，也可能要几周、几百次干净安装才不弹警告；**始终用同一个签名身份**，信誉才能跨版本延续[MS-SmartScreen]。Windows 11 的“智能应用控制”会直接拦没签名的文件[MS-SmartScreen]。
- SignPath Foundation 的条件：全部组件用 OSI 认可的协议、不搞商业双授权、二进制必须由 CI 从源码可验证地构建、团队成员都开多因素认证、每次签名要有人批准、主页和下载页要放“Code signing policy”页面[SignPath-terms]。【待核实：GPL + App Store 附加许可算不算“商业双授权”，要问 SignPath；另外“不能有主动扫描或利用漏洞的功能”这一条，SSH 客户端的批量执行等功能是否会被误判】
- Tauri 配置：`bundle > windows > certificateThumbprint`、`digestAlgorithm`、`timestampUrl`；云签名（Azure Key Vault、Artifact Signing）用 `signCommand`；**在 Mac/Linux 上交叉编译 Windows 包时必须用自定义 `signCommand`**[Tauri-sign-windows][Tauri-schema]。

**WebView2**：
- Windows 10（2018-04 之后）和 Windows 11 自带 WebView2[Tauri-windows-installer]。
- 安装模式：`downloadBootstrapper`（默认，要联网，+0 MB）、`embedBootstrapper`（+约 1.8 MB）、`offlineInstaller`（+约 127 MB，不用联网）、`fixedVersion`（+约 180 MB，自己控制版本）、`skip`（不推荐，没装就打不开）[Tauri-windows-installer]。
- 上 Microsoft Store 时必须用 `offlineInstaller`，安装器要能静默安装，发布者名不能和产品名一样；Tauri 只出 EXE / MSI，不直接出 MSIX[Tauri-ms-store]。

**安装器**：NSIS 默认按用户安装到 `%LOCALAPPDATA%`，不需要管理员权限；MSI 只能在 Windows 上打；交叉编译只支持 NSIS，官方说是“最后手段”[Tauri-windows-installer]。建议 CI 用 GitHub 托管的 Windows 机器出包。

**典型的坑**：
- 签名证书换了，SmartScreen 信誉要重新积累[MS-SmartScreen]。选好路线后不要轻易换。
- MSI 版本号格式限制（8.1）。
- M0 报告：`scripts/llvm-ar` 是 sh 脚本，Windows 开发机要另配。

### 9.3 iOS / Android（M6 之后）

**Tauri 2 移动端的成熟度**：
- Tauri 2.0 RC 时官方承认之前把“移动端一等公民”说过头了，但认为已能做生产级移动 App；**不是所有桌面插件都移植到了移动端**，移动端开发体验还要改进[Tauri-RC]。现在最新是 2.12（2026-09-26）[Tauri-blog]，没查到之后专门讲移动端进展的官方文章。【待核实：动手前看一遍插件支持表】
- 官方插件里生物识别、扫码、触感、NFC 只支持移动端；**没有官方的钥匙串插件**，最接近的是 Stronghold（加密数据库）[Tauri-plugins]。EverShell 现在用 `keyring` crate，在 iOS 上能不能用要验证。【待核实】
- 打 iOS 包必须在 Mac 上，用 `tauri ios build --export-method app-store-connect`，上传后通过校验就能进 TestFlight[Tauri-app-store]。

**iOS 的产品层面的坑**：
- iOS 切到后台后很快停掉 App 的网络活动，Termius 说新版系统大约 20~30 秒[Termius-bg]。SSH 会话、端口转发切后台就会断，常见对策是服务器端用 tmux/screen、或者用 Mosh[Termius-bg]。这会影响手机版的产品设计（自动重连、会话恢复），比技术移植本身更难。

**GPL 与 App Store 的冲突**：
- 先例：
  - 2010 年 FSF 认为 App Store 的使用条款给软件加了 GPL 禁止的额外限制（GPLv2 第 6 条），Apple 的反应是下架 GNU Go[FSF-GNUGo]。
  - VLC 的一位版权持有人 2010 年投诉后，Apple 在 2011-01 下架 VLC[VLC-removed]；2013-07 VLC for iOS 以 **MPL 2.0 + GPLv2+ 双协议**回归，官方说 App Store 版适用 MPL[VLC-2013]。
- 关键点：**冲突只在“别人的 GPL 代码被你发到 App Store”时才有人能主张**；版权持有人自己可以给额外许可。
  - Signal：版权持有人加了一条附加许可，允许经 App Store 分发，前提是仍满足 GPLv3（包括提供源码），App Store 里的可执行文件按 MPL 2.0 授权[Signal-exception]。
  - KDE Connect iOS：版权持有人声明不会就“仅由 App Store 条款引起”的冲突追究[KDE-Connect-iOS]。
  - ownCloud iOS：只对 Apple Ad Hoc 分发给了窄例外[ownCloud-iOS]。
  - Blink Shell（iOS 上的 SSH/Mosh 终端）本身就是 GPL-3.0，在 App Store 上架[Blink-GitHub]。【推断：说明版权集中在维护者手里时，GPL 应用上架在实践中可行】
- **对 EverShell 的影响**：
  1. 现在代码基本都在所有者名下，所有者可以随时在 LICENSE 里加一条 GPLv3 第 7 条“附加许可”（参照 Signal 或 KDE Connect 的写法），允许经 App Store / TestFlight 分发。
  2. **一旦接受了外部贡献**，那部分代码的版权在贡献者手里，就需要贡献者也同意这条附加许可。所以要在接受第一个外部 PR 之前，要么先把附加许可写进 LICENSE（之后的贡献都在这个条件下进来），要么要求签 CLA。【推断，涉及法律，建议正式决定前问一次懂开源协议的律师】
  3. 依赖的协议也要能兼容：russh、Tauri、xterm.js 是宽松协议，问题不大；以后引入 GPL 的第三方库要检查对方有没有类似附加许可。【推断】
  4. 还有一个新问题：AI 生成的内容在美国能不能有版权，美国版权局 2025-01 的报告认为**只有人类决定了足够的表达性元素才受保护，只给提示词不够**[USCO-AI]。代码全由 AI 写，GPL 的可执行性（以及“版权持有人”身份）可能比传统项目弱。这不影响你发布和上架，但会影响以后有人违反 GPL 时你能不能主张权利。【待核实，法律问题】
- Android：Google Play 没有类似的 GPL 冲突先例。【待核实】但 Google 在推开发者验证：2026-09-30 起在巴西、印尼、新加坡、泰国对“参与的商店”安装生效，2027 年扩到全球所有认证设备；有给学生和爱好者的限量分发账号（最多 20 台设备）和给高级用户装未验证 App 的流程[Android-verification]。Android 版打算侧载分发的话，要提前注册开发者身份。

---

## 10. 同步服务上线（M2）

### 10.1 部署形态

- **Docker 自建**：镜像发到 GHCR 之类的仓库，按版本打 tag；BuildKit 默认附带最简构建来源证明（provenance），`--sbom=true` 可以附带软件物料清单[Docker-attestations]。
- **部署到用户自己的 Cloudflare 账号**：可以用“Deploy to Cloudflare”按钮，Cloudflare 把仓库克隆到用户自己的 GitHub/GitLab 账号，并按 wrangler 配置自动创建 D1、R2 等资源；**仓库必须公开**；monorepo 里的子项目必须完全独立（包括依赖），多个 Worker 要多个按钮[CF-deploy-button]。EverShell 是 monorepo，同步服务和中转要各自能独立构建。

### 10.2 Cloudflare 的限制（直接影响设计）

| 项目 | 免费 | 付费 |
|---|---|---|
| D1 每个库最大 | 500 MB | 10 GB[CF-D1-limits] |
| D1 每账号库数量 | 10 | 50,000[CF-D1-limits] |
| D1 每账号总存储 | 5 GB | 1 TB[CF-D1-limits] |
| 每次 Worker 调用的 D1 查询数 | 50 | 1,000[CF-D1-limits] |
| 单行 / 单个 BLOB 最大 | 2 MB | 2 MB[CF-D1-limits] |
| Time Travel（时间点恢复） | 7 天 | 30 天[CF-D1-limits] |
| Workers 每天请求数 | 10 万 | 不限[CF-Workers-limits] |
| Workers 每请求 CPU | 10 ms | 默认 30 秒[CF-Workers-limits] |
| Workers 日志保留 | 3 天（每天 20 万条） | 7 天[CF-Workers-logs] |
| R2 免费额度 | 每月 10 GB 存储、100 万次 A 类、1000 万次 B 类操作；**出口流量免费**[CF-R2-pricing] | |

- **每个 D1 库是单线程的，一次只处理一个查询**；平均 1 ms 的查询大约每秒 1000 次[CF-D1-limits]。多租户时，“每个租户一个库”能分散压力，付费账号最多 5 万个库[CF-D1-limits]。【推断：这是常见做法，具体选哪种隔离方式要在 M2 设计时定】
- 单行 2 MB 上限：加密后的同步记录、附件（比如私钥文件、会话日志）大了就要放 R2，D1 只存元数据。【推断】
- **服务端不能做重的密码哈希**：Bitwarden 的做法是客户端用主密码派生密钥，只把“主密码哈希”发给服务器，服务器再做一次 60 万轮 PBKDF2[Bitwarden-whitepaper]。在免费计划每请求 10 ms CPU 的限制下[CF-Workers-limits]，服务器端这么重的哈希大概率超时。【推断，要实测】设计账号登录时，要让重的计算留在客户端，服务端只做轻量校验。

### 10.3 数据库迁移

- D1 用 `migrations/` 目录里按编号排序的 `.sql` 文件，已执行的记在 `d1_migrations` 表；用库名而不是绑定名执行，免得跑错库[CF-D1-migrations]。官方文档没写回滚（down migration）[CF-D1-migrations]。
- D1 本身是 SQLite，**同一套迁移 SQL 可以同时给 Docker 版的 SQLite 用**。【推断】
- Worker 代码回滚不会回滚 D1 表结构[CF-rollbacks]，所以迁移必须按“扩展 → 迁移 → 收缩”来：先加新列/新表让新旧代码都能跑，等所有客户端和服务端都升级了再删旧的；**跳过“收缩”这一步会留下更乱的结构**[Fowler-ParallelChange]。

### 10.4 备份和恢复

- D1 Time Travel 能恢复到最近 30 天（付费）/ 7 天（免费）里任意一分钟；**恢复是破坏性的，原地覆盖**，正在跑的查询会报错；每次恢复会返回一个“恢复前”的书签，可以再恢复回去[CF-D1-timetravel]。要保留超过 30 天，官方方案是用 REST API + Workflows 导出到 R2[CF-D1-timetravel]。
- Docker 自建的 SQLite：不要直接复制正在写的库文件；用 SQLite 的在线备份 API 或 `VACUUM INTO` 出一份副本[SQLite-backup]，或用 Litestream 持续复制到对象存储[Litestream]。
- 端到端加密的好处：服务器备份里只有密文，备份文件泄露也不暴露内容。但**用户的主密码丢了，备份也救不了**（需求文档已写明“主密码丢了无法找回”）。
- **过关标准**：做过一次完整的恢复演练（从备份起一个新实例，客户端连上去数据完整）。没演练过的备份不算备份。【推断】

### 10.5 监控告警

- Workers 在 wrangler 配置里开 `observability.enabled` 就有日志，免费保留 3 天[CF-Workers-logs]。Rate Limiting 绑定触发不会显示在控制台，要自己从日志里统计 429，或写进 Analytics Engine[CF-ratelimit]。
- Docker 版至少提供一个健康检查接口，方便用户接自己的监控。【推断】
- 自用阶段告警发给所有者自己就够；开放给别人后，要有“服务状态”页面。【推断】

### 10.6 多租户、配额、防滥用

- 需求文档要求账号、数据隔离、配额第一版就做；注册方式（邀请码 / 开放注册）还没定。
- 开放注册就会有人拿它当免费网盘或刷接口。按账号限容量（D1/R2 用量）、限请求频率；注册入口加人机验证（Cloudflare Turnstile）。Rate Limiting 绑定只能防刷，配额要自己在数据库里精确记账[CF-ratelimit]。
- 中转（网页版）是最容易被滥用的部分，见 9.1。

### 10.7 服务端和客户端的版本兼容

- 客户端会长期存在多个版本（用户不升级、手机版审核慢、离线设备很久才联网），服务端必须**同时兼容多个客户端版本**。【推断】
- 建议：API 路径带大版本（`/v1/`）；客户端每次请求带自己的版本号；服务端能返回“你的版本太旧，请升级”的明确错误，客户端据此提示更新；同步数据的记录格式也带版本号，新字段对旧客户端可忽略。新增字段用“扩展”方式，旧客户端能忽略不认识的字段[Fowler-ParallelChange]。
- 用户在自己的 Cloudflare 账号部署的服务端，**升级要靠用户自己**（他们的仓库是从你的仓库克隆过去的[CF-deploy-button]）。所以服务端的兼容窗口要比客户端更长，客户端要能和“几个版本前的服务端”一起工作。【推断】

---

## 11. 开源社区运营

**要做什么**：让外人看得懂、编得出、能反馈；想清楚接不接受外部贡献、怎么接受。

**产出**：README（已有）、CONTRIBUTING、议题模板、SECURITY.md、许可证附加条款（9.3）、行为准则（可选）。

**OpenSSF 徽章“及格级”的要求**（共 67 条，挑几条）[OpenSSF-Badge]：
- 网站说明软件做什么、怎么获取、怎么反馈、怎么贡献；协议文件在仓库里；全站 HTTPS。
- 公开版本控制，保留中间版本；每个版本有唯一版本号和给人看的发布说明。
- 有提 bug 的渠道；公布漏洞报告流程，**14 天内首次回复**。
- 有自动化测试并写明怎么跑；新功能要有测试的规则；开启编译器警告或 linter。
- 加密只用公开、经专家审过的算法，不自己发明；密码要加盐并拉伸；用安全的随机数生成密钥；分发渠道防中间人；**中等以上的公开漏洞 60 天内修**；不泄露私密凭据。
- 大版本发布前至少用过一种静态分析工具。

**典型的坑**：
- 许可证附加条款、CLA/DCO 的决定要在**第一个外部 PR 合并之前**做（9.3）。
- 一个人 + AI 写代码，OpenSSF Scorecard 的“代码审查”“多组织贡献者”两项分数天然低[OpenSSF-Scorecard]。这不是问题，但不要为了分数造假审查；可以用 CI 检查和发布前人工确认来弥补。【推断】
- “数据在自己手里”的项目，用户最关心的是“作者跑路怎么办”。文档里写清楚：怎么自己编译、怎么自己部署同步服务、怎么导出数据。这比社区活跃度更能体现项目定位。【推断】

---

## 12. 漏洞响应和长期维护

### 12.1 漏洞响应

- GitHub 仓库可以开启“私密漏洞报告”，之后安全公告页会出现“Report a vulnerability”按钮；可以用 `.github/VULNERABILITY_REPORT.yml` 自定义表单[GitHub-PVR]。
- OpenSSF 的维护者指南[OpenSSF-CVD]：
  - 准备：SECURITY.md（在 README 里链过去）、私密报告渠道、至少两个人有权限发安全公告、准备好私下开发补丁的流程和通知模板。
  - 处理：1~2 天内确认收到；评估是不是真的安全问题；和报告人商量公开时间（常见 7 天到 90 天，90 天是最长的常见默认值）；私下修；申请 CVE；避开周五到周日发布。
  - 公开：同时发修复版和公告，写上 CVE 编号。
- EverShell 是 SSH 客户端，最可能遇到的安全问题来自依赖（russh、Tauri）和协议层（例如 Terrapin 那样的攻击，靠双方都支持 strict KEX 才能防[Terrapin]）。所以“跟进依赖的安全公告”是漏洞响应的主体。【推断】

### 12.2 依赖和供应链

- russh 2026 年的公告很密（约 20 个）[russh-advisories]，Tauri 2026 年也有两个 IPC 访问控制的公告[Tauri-advisories]。**建议规定：russh / Tauri 出安全版本后 7 天内跟进发版**（vendored russh 要合补丁）。【推断：7 天是建议值】
- npm 生态 2025-09 出过会自我传播的 Shai-Hulud 蠕虫：钓鱼拿到发布权限，装包时跑脚本偷 npm/GitHub/云凭据，再用偷来的令牌发布更多带毒的包[ShaiHulud]。对策：
  - 依赖新版本发布后等几天再升（OpenSSF 简明指南建议约 3 天冷静期[OpenSSF-Concise]；Dependabot 现在默认对版本更新就有 3 天冷静期，安全更新不受影响[Dependabot-cooldown]）。
  - 锁定文件（`Cargo.lock`、`package-lock.json`）入库，CI 用 `npm ci`。【推断】
- Rust 依赖用 `cargo-deny` 一次查四样：安全公告、许可证、禁用的 crate、来源[cargo-deny]。**许可证检查对 GPL 项目特别有用**，能防止混进和 GPL 不兼容的依赖。【推断】

### 12.3 CI 和发布密钥的保护（AI 写全部代码时尤其重要）

- GitHub Actions 加固[GitHub-Actions-hardening]：
  - 第三方 action 固定到完整的提交 SHA。
  - `GITHUB_TOKEN` 默认只读，需要写权限的 job 单独开。
  - 不要把 PR 标题这类外部输入直接拼进脚本（脚本注入）。
  - 慎用 `pull_request_target`，不要在里面检出 PR 的代码。
  - **发布用的密钥放进 Environment，并设“需要审批人”**：job 拿不到密钥，直到审批人批准。
  - 公开仓库几乎不应该用自托管 runner。
- 对 EverShell 的意义：AI 能改代码、能推分支，但**签名证书、公证密钥、更新私钥只在 `release` 环境里**，每次发布要所有者在 GitHub 上点批准。这样 AI 出错或被提示注入时，最坏结果是一个坏提交，而不是一个签了名、推给所有用户的坏更新。【推断】

### 12.4 长期维护的固定节奏（建议）

- 每周：处理 Dependabot PR（冷静期过后）。
- 每月：看一遍 russh、Tauri、RustSec 的公告；跑一次完整的发布检查单（哪怕不发版，确认流水线没烂）。
- 每年：检查 Apple 开发者会员、Developer ID 证书到期日、Windows 签名证书到期日、域名到期日；做一次同步服务恢复演练；轮换 CI 里的 API 密钥。【推断】

---

## 13. 安全开发框架：对小项目有用的最小集合

### 13.1 各框架是什么

- **NIST SSDF（SP 800-218）**：一组以结果为导向的安全开发实践，分四组：PO 准备组织、PS 保护软件（防篡改和未授权访问）、PW 产出安全的软件、RV 响应漏洞[NIST-SSDF]。现行正式版是 1.1（2022-02）；1.2（SP 800-218 Rev. 1）2025-12-17 出了初稿，到今天还是草稿[NIST-SSDF-pubs]。它不是检查单，适合当“分类目录”用。
- **OpenSSF Scorecard**：自动给 GitHub 仓库打分的 20 项检查，比如危险的工作流、令牌权限、依赖固定、签名发布、有没有 SECURITY.md、有没有依赖更新工具[OpenSSF-Scorecard]。“签名发布”看最近 5 个版本的附件里有没有签名文件（.sig、.minisig 等），有 SLSA 来源证明（.intoto.jsonl）得满分[OpenSSF-Scorecard]。【推断：Tauri 更新包附带的 `.sig` 文件上传到 Release 后，可能就能让这一项得分】
- **OpenSSF 最佳实践徽章**：自评问卷，“及格级”67 条（见第 11 节）[OpenSSF-Badge]。
- **SLSA**：构建来源证明分级。L1 有来源证明；L2 由托管构建平台生成并签名，防构建后被篡改；L3 构建之间隔离、签名密钥用户步骤拿不到，防构建过程中被篡改[SLSA-levels]。现行版本是 1.2[SLSA-levels]。GitHub 的 artifact attestations 单独用就是 SLSA Build L2，放进可复用工作流能到 L3；公开仓库用 Sigstore 公共实例和公开透明日志[GitHub-attestations]。用 `actions/attest` 生成，用户用 `gh attestation verify` 验证[GitHub-attest-howto]。

### 13.2 建议的最小集合（按 SSDF 四组归类）

| 组 | 做什么 | 成本 | 时间点 |
|---|---|---|---|
| PO | 写一页 `docs/dev/security.md`：威胁模型（谁会攻击 SSH 客户端和同步服务）、密钥清单（放哪、谁能用、怎么恢复）、发布流程 | 低 | 现在 |
| PO | GitHub 账号开多因素认证（OpenSSF 建议有特权的开发者用 MFA 令牌）[OpenSSF-Concise] | 低 | 现在 |
| PS | 默认分支保护；发布密钥只放 Environment + 审批；action 固定 SHA；令牌只读[GitHub-Actions-hardening] | 低 | 建 CI 时 |
| PS | 不可变 Release + 构建来源证明（SLSA L2）[GitHub-immutable][GitHub-attestations] | 低 | 第一次公开发布 |
| PW | CI：测试、clippy、类型检查、WASM 编译检查、`cargo-deny`（公告+许可证）、密钥扫描 | 中 | 现在 |
| PW | 加密只用成熟库，不自己发明（徽章及格条件）[OpenSSF-Badge]；同步加密方案写成设计文档公开征求意见 | 中 | M2 前 |
| RV | SECURITY.md + 开启私密漏洞报告[GitHub-PVR]；承诺 14 天内首次回复、中高危 60 天内修复[OpenSSF-Badge] | 低 | 现在 |
| RV | Dependabot（带冷静期）[Dependabot-cooldown]；依赖安全版本限期跟进 | 低 | 建 CI 时 |
| — | Scorecard Action 定期跑，徽章做“及格级”自评 | 低 | M1 末 |
| — | SBOM、SLSA L3、第三方安全审计、模糊测试 | 高 | 开放给别人用、同步服务上线后再看 |

---

## 14. 对 EverShell 的建议

### 14.1 现在就定规矩（M1 进行中；现在定成本很低，以后改成本高）

1. **版本号规则**：只用纯数字 `X.Y.Z`，不用 `-beta` 后缀（MSI 和 App Store 都不接受字母后缀）[Tauri-bundler-1.2][Apple-glossary]；在 1.0 之前用 `0.y.z`；版本号只改 `tauri.conf.json` 一处；beta 和 stable 靠更新渠道区分，同一个包逐级推广。
2. **建 `CHANGELOG.md`**（Keep a Changelog 格式，顶部 `Unreleased`）[KeepAChangelog]。从现在起每次合并都往里记，AI 写代码时顺手记。
3. **本地数据格式版本化**：`core/storage.ts` 存的每类数据带格式版本号，迁移前自动备份。这是以后同步、跨设备合并的前提。
4. **许可证附加条款和贡献规则**：在接受第一个外部 PR 之前，决定是否在 LICENSE 里加 App Store 附加许可（参照 Signal / KDE Connect），并在 CONTRIBUTING 里写明贡献按什么条件进来（DCO 或 CLA）。不然 iOS 版到时候可能要逐个联系贡献者[Signal-exception][KDE-Connect-iOS]。【建议正式定之前问一次律师】
5. **SECURITY.md + 开启私密漏洞报告**，写明“14 天内首次回复”[GitHub-PVR][OpenSSF-Badge]。零成本。
6. **密钥清单**：写一份文档列出 Apple 证书、公证 API 密钥、以后的 Tauri 更新私钥、Cloudflare API 令牌各放在哪、怎么恢复（不写密钥本身）。更新私钥丢了无法挽回[Tauri-updater]。
7. **最小 CI**（GitHub Actions）：Rust 测试 + clippy、前端类型检查、`cargo check -p ssh-wasm --target wasm32-unknown-unknown`、`cargo-deny`；action 固定 SHA，`permissions` 默认只读；开 Dependabot（默认就有 3 天冷静期）[GitHub-Actions-hardening][Dependabot-cooldown]。
8. **依赖跟进规则**：russh / Tauri 出安全版本后限期跟进；推动 russh 补丁进上游，早日去掉 `vendor/russh`[russh-advisories]。
9. **M1 的安全底线写进 M1 完成标准**：服务器指纹校验（M0 报告已列）、开启 CSP[Tauri-CSP]。

### 14.2 M1 收尾、第一次给别人装之前

- 打通公证 + staple + DMG 签名，写进 `scripts/build-mac.sh` 或 CI；用干净的 Mac 验证（6.3）。
- 公证用 App Store Connect API 密钥，不用个人 Apple ID 密码[Tauri-sign-macos]。
- 接入 updater：生成密钥并离线双备份；stable 用 GitHub Releases `latest.json`，beta 单独一个 JSON[Tauri-updater][GitHub-latest-release]；建 `release` Environment，发布密钥只在里面、要所有者审批[GitHub-Actions-hardening]。
- 写发布检查单（8.3），第一次发版就照着走；N-1→N 升级实测。
- Release 设为不可变，加构建来源证明[GitHub-immutable][GitHub-attestations]。
- Scorecard 跑一次，徽章“及格级”自评一次，看缺什么[OpenSSF-Scorecard][OpenSSF-Badge]。

### 14.3 M2 同步服务开工前

- 定注册方式和配额（需求文档待定事项）。
- 定账号认证方案：重的密钥派生放客户端，服务端只做轻量校验，先在 Cloudflare 免费账号上实测 CPU 时间[CF-Workers-limits][Bitwarden-whitepaper]。
- 定 API 版本规则（`/v1/`、客户端带版本号、“版本太旧”错误）和迁移规则（只做“扩展-迁移-收缩”）[Fowler-ParallelChange][CF-rollbacks]。
- 同一套迁移 SQL 给 D1 和 SQLite 用[CF-D1-migrations]。
- 定备份方案并做一次恢复演练（D1 Time Travel + 定期导出到 R2；Docker 用 Litestream 或 `VACUUM INTO`）[CF-D1-timetravel][Litestream][SQLite-backup]。
- 同步加密方案写成设计文档，公开征求意见后再实现。
- 同步服务、中转在 monorepo 里各自能独立构建（Deploy to Cloudflare 按钮的要求）[CF-deploy-button]。

### 14.4 M3 网页版前

- 中转：短期票据鉴权；默认拒绝内网和元数据地址，校验解析后的 IP；按账号限并发[OWASP-SSRF]。
- 在真实 Cloudflare 免费和付费账号上实测 CPU、连接时长、不能连 Cloudflare IP 的影响[CF-TCP][CF-Workers-limits]；客户端做自动重连（部署会断连）[CF-DO-WS][CF-Workers-WS]。

### 14.5 M6 Windows 前

- 先确认签名路线：所有者如果是美国、加拿大以外的个人，Artifact Signing 用不了[MS-signing-options]；在 OV 证书（云 HSM）和 SignPath Foundation 之间选，先去问 SignPath 附加许可算不算“商业双授权”[SignPath-terms]。选定后不要换，SmartScreen 信誉跟着签名身份走[MS-SmartScreen]。
- CI 加 Windows 机器出 NSIS 包；WebView2 用默认 `downloadBootstrapper`，上商店时单独配置 `offlineInstaller`[Tauri-windows-installer][Tauri-ms-store]。
- 更新清单里加 Windows 条目后，确认 Mac 用户的更新没被一起弄坏（清单任一平台不完整，全部失败）[Tauri-updater]。

### 14.6 手机版前

- LICENSE 附加许可必须已经到位（9.3）。
- 准备出口合规的答案，在 Info.plist 写 `ITSAppUsesNonExemptEncryption`[Apple-encryption-export][Apple-ITSAppUses]。
- 先做产品设计：iOS 切后台很快断网[Termius-bg]，会话恢复怎么做。
- 核对 Tauri 移动端插件支持表、`keyring` 在 iOS/Android 上的可用性[Tauri-plugins]。
- Android 打算侧载分发的话，提前注册开发者身份（2027 年全球生效）[Android-verification]。

### 14.7 以后再说

- SLSA L3、SBOM、第三方安全审计、模糊测试：等开放给别人用、同步服务有外部用户之后再做。
- 欧盟 CRA：只要不收费就不在范围内[EU-CRA-OSS]；如果以后对托管同步服务收费，再评估。

---

## 来源

**Apple**
- [Apple-notarize]: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- [Apple-notarize-issues]: https://developer.apple.com/documentation/security/resolving-common-notarization-issues
- [Apple-notarize-workflow]: https://developer.apple.com/documentation/security/customizing-the-notarization-workflow
- [Apple-hardened-runtime]: https://developer.apple.com/documentation/security/hardened-runtime
- [Apple-DevID]: https://developer.apple.com/developer-id/
- [Apple-DevID-support]: https://developer.apple.com/support/developer-id/
- [Apple-TestFlight]: https://developer.apple.com/testflight/
- [Apple-TF-overview]: https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/
- [Apple-forum-TF-mac]: https://developer.apple.com/forums/thread/733942
- [Apple-encryption-export]: https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations
- [Apple-ITSAppUses]: https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption
- [Apple-glossary]: https://developer.apple.com/help/glossary/

（Apple 文档页面是脚本渲染的，本次通过 `https://developer.apple.com/tutorials/data/documentation/<路径>.json` 读取原文。）

**Tauri**
- [Tauri-sign-macos]: https://v2.tauri.app/distribute/sign/macos/
- [Tauri-macos-bundle]: https://v2.tauri.app/distribute/macos-application-bundle/
- [Tauri-schema]: https://schema.tauri.app/config/2 （`bundle.macOS.hardenedRuntime` 默认 true 等默认值）
- [Tauri-updater]: https://v2.tauri.app/plugin/updater/
- [Tauri-GHSA-updater-key]: https://github.com/tauri-apps/tauri/security/advisories/GHSA-2rcp-jvr4-r259
- [Tauri-advisories]: https://github.com/tauri-apps/tauri/security/advisories
- [tauri-action]: https://github.com/tauri-apps/tauri-action
- [Tauri-sign-windows]: https://v2.tauri.app/distribute/sign/windows/
- [Tauri-windows-installer]: https://v2.tauri.app/distribute/windows-installer/
- [Tauri-ms-store]: https://v2.tauri.app/distribute/microsoft-store/
- [Tauri-app-store]: https://v2.tauri.app/distribute/app-store/
- [Tauri-distribute]: https://v2.tauri.app/distribute/
- [Tauri-bundler-1.2]: https://v2.tauri.app/release/tauri-bundler/v1.2.0/
- [Tauri-CSP]: https://v2.tauri.app/security/csp/
- [Tauri-plugins]: https://v2.tauri.app/plugin/
- [Tauri-RC]: https://v2.tauri.app/blog/tauri-2-0-0-release-candidate/
- [Tauri-blog]: https://v2.tauri.app/blog/

**微软 / Windows 签名**
- [MS-signing-options]: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options （2026-08-29 更新）
- [MS-SmartScreen]: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- [SignPath-terms]: https://signpath.org/terms

**Cloudflare**
- [CF-D1-limits]: https://developers.cloudflare.com/d1/platform/limits/
- [CF-D1-timetravel]: https://developers.cloudflare.com/d1/reference/time-travel/
- [CF-D1-migrations]: https://developers.cloudflare.com/d1/reference/migrations/
- [CF-Workers-limits]: https://developers.cloudflare.com/workers/platform/limits/
- [CF-TCP]: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
- [CF-Workers-WS]: https://developers.cloudflare.com/workers/runtime-apis/websockets/
- [CF-DO-WS]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- [CF-DO-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/
- [CF-DO-pricing]: https://developers.cloudflare.com/durable-objects/platform/pricing/
- [CF-ratelimit]: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- [CF-rollbacks]: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/
- [CF-deploy-button]: https://developers.cloudflare.com/workers/platform/deploy-buttons/
- [CF-Workers-logs]: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- [CF-R2-pricing]: https://developers.cloudflare.com/r2/pricing/

**NIST / OpenSSF / SLSA / GitHub**
- [NIST-SSDF]: https://csrc.nist.gov/projects/ssdf
- [NIST-SSDF-pubs]: https://csrc.nist.gov/Projects/ssdf/publications
- [OpenSSF-Scorecard]: https://github.com/ossf/scorecard/blob/main/docs/checks.md
- [OpenSSF-Badge]: https://www.bestpractices.dev/en/criteria/0
- [OpenSSF-Concise]: https://best.openssf.org/Concise-Guide-for-Developing-More-Secure-Software
- [OpenSSF-CVD]: https://github.com/ossf/oss-vulnerability-guide/blob/main/maintainer-guide.md
- [SLSA-levels]: https://slsa.dev/spec/v1.1/levels （页面标注 v1.1 已退役，现行 v1.2）
- [GitHub-attestations]: https://docs.github.com/en/actions/concepts/security/artifact-attestations
- [GitHub-attest-howto]: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
- [GitHub-immutable]: https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/ （用户反馈见 https://github.com/orgs/community/discussions/178351 ）
- [GitHub-PVR]: https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository
- [GitHub-Actions-hardening]: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- [GitHub-latest-release]: https://docs.github.com/en/rest/releases/releases#get-the-latest-release
- [Dependabot-cooldown]: https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference

**版本与发布**
- [SemVer]: https://semver.org/
- [KeepAChangelog]: https://keepachangelog.com/en/1.1.0/

**依赖与安全事件**
- [russh-advisories]: https://github.com/Eugeny/russh/security/advisories （本次用 `gh api repos/Eugeny/russh/security-advisories` 列出，2026 年约 20 条）
- [cargo-deny]: https://embarkstudios.github.io/cargo-deny/
- [ShaiHulud]: https://www.infosecurity-magazine.com/news/supply-chain-worm-hundreds-npm/ （另见 https://www.techradar.com/pro/security/self-replicating-shai-hulud-infects-147-npm-packages-with-over-2-million-downloads-per-week ；二手报道，受影响包数各家说法不一）
- [Terrapin]: https://terrapin-attack.com/patches.html

**GPL 与 App Store、法律**
- [FSF-GNUGo]: https://www.fsf.org/news/2010-05-app-store-compliance
- [VLC-removed]: https://thenextweb.com/news/apple-officially-pulls-vlc-from-the-app-store （另见 https://www.engadget.com/2011-01-09-the-gpl-the-app-store-and-you.html ）
- [VLC-2013]: https://www.videolan.org/press/ios2out.html
- [Signal-exception]: https://scancode-licensedb.aboutcode.org/signal-gpl-3.0-exception.LICENSE （第三方许可证库收录的 Signal 附加许可原文）
- [KDE-Connect-iOS]: https://lxr.kde.org/source/network/kdeconnect-ios/License.md
- [ownCloud-iOS]: https://owncloud.com/contribute/iOS-license-exception/
- [Blink-GitHub]: https://github.com/blinksh/blink （GitHub 识别为 GPL-3.0）
- [USCO-AI]: https://copyright.gov/newsnet/2025/1060.html
- [EU-CRA-OSS]: https://digital-strategy.ec.europa.eu/en/policies/cra-open-source
- [ENISA-CRA]: https://www.enisa.europa.eu/sites/default/files/2026-07/ENISA_CRA_SRP_Factsheet_v1.0_0.pdf

**移动端**
- [Termius-bg]: https://docs.termius.com/help-center/faq/how-can-i-keep-termius-sessions-alive-in-the-background-on-ios-ipados （厂商说法，非 Apple 官方）
- [Android-verification]: https://developer.android.com/developer-verification

**其他**
- [translocation-eclectic]: https://eclecticlight.co/2022/09/06/dont-run-that-app-where-it-landed-how-translocation-can-cause-crashes/
- [translocation-mjtsai]: https://mjtsai.com/blog/2023/05/10/app-translocation-in-ventura
- [OWASP-SSRF]: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- [webdev-PWA]: https://web.dev/articles/what-are-pwas
- [Docker-attestations]: https://docs.docker.com/build/metadata/attestations/
- [Litestream]: https://litestream.io/
- [SQLite-backup]: https://www.sqlite.org/backup.html
- [Fowler-ParallelChange]: https://martinfowler.com/bliki/ParallelChange.html
- [Bitwarden-whitepaper]: https://bitwarden.com/help/bitwarden-security-white-paper/
