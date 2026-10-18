# 开源与合规

> **管什么**：EverShell 的开源协议带来的义务、加依赖时的协议门槛、vendor 里第三方代码的声明、以后上 App Store 和接受外部贡献要提前定的事。
> **什么时候更新**：加了新协议的依赖或 vendor 代码、所有者定了附加许可或贡献规则、开始对外发布。
> **上次复核**：2026-10-18

EverShell 以 GPL-3.0-or-later 发布（[LICENSE](../../LICENSE)，2026-10-17 定），`vendor/russh` 保留 Apache-2.0。依据见调研 [附录 C 第 6 节](../research/2026-10-appendix-c-ssh-client-concerns.md) 和 [附录 B](../research/2026-10-appendix-b-lifecycle.md) 第 9.3、11 节。这里不是法律意见，对外发布、上架之前所有者可以找懂开源协议的律师确认。

## 现在就要守的

1. **加依赖先看协议**（见下面“依赖的协议”），不兼容的不加。
2. **vendor 里改过的第三方文件要标“已修改”**：Apache-2.0 要求改过的文件带上修改声明。`vendor/russh` 的改动记在 [vendor/README.md](../../vendor/README.md)，改过的源文件开头也要有一行说明（调研发现有的文件还没标，下次动 vendor 时补上）。
3. **不抄协议不明或不兼容的代码**进仓库，哪怕只是一段。参考别的项目的做法可以，照抄要先看协议。
4. **提交里带 AI 署名**：代码由 AI 写，署名是如实说明（[ai-collaboration.md](ai-collaboration.md#分支和提交)）。

## 依赖的协议

可以用（和 GPL-3.0-or-later 兼容）：MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC、Zlib、Unicode-3.0、CC0-1.0、MPL-2.0（按文件生效）、LGPL、GPL-3.0。

不能用：GPL-2.0-only（只认第 2 版）、AGPL、SSPL、旧版 OpenSSL 协议、没写协议的代码。拿不准的先问。

查一个依赖的协议：Rust 看 crates.io 页面或 `cargo metadata`；npm 看 `node_modules/<包名>/package.json` 的 `license`。建 CI 时用 cargo-deny 自动查（[quality.md](quality.md#还没建的)）。

## 发二进制时的义务（对外发布前做）

- 附上获取源码的方式：GitHub Release 页写明源码就是对应的 tag。
- 附上许可证和第三方声明：`.app` 里放 LICENSE 和自动生成的第三方声明（cargo-about、npm 侧的同类工具），应用的“关于”里能打开。
- 网页版的 JS 和 WASM 发到用户浏览器里执行，也算分发，页面上要给源码链接【待核实】。中转如果只作为服务运行，不涉及分发义务；Docker 镜像发布就是分发，镜像里每个组件都要满足各自的协议。

## 要所有者在“第一个外部贡献”之前定的

这两件现在没有外部贡献者，不急，但**合并第一个外人的代码之前必须定**，晚了要逐个追溯贡献者同意：

1. **以后要不要上苹果的 App Store（iOS 版、TestFlight）。** 纯 GPL 和 App Store 的条款冲突（FSF 的立场，VLC 被下架过）。冲突只有版权持有人能主张，所以所有者可以在 LICENSE 里加一条“允许经 App Store 分发”的附加许可，Signal、KDE Connect 这么做过，同样是 GPL 的 SSH 终端 Blink 也在 App Store 上。全部由 AI 写的代码版权状态可能偏弱【待核实】。
2. **贡献者签什么。** 只想纯开源、不上 App Store：用 DCO（贡献者在提交里声明自己有权贡献，社区最容易接受）。以后要上 App Store、换协议或做商业版：用 CLA，或者在贡献条款里写明“贡献同时按 GPL-3.0-or-later 加 App Store 附加许可授权”。DCO 拿不到改协议的权利。

## 以后再写

- 源文件头部加 SPDX 协议标识：调研建议现在就加，但会动到所有源文件，要所有者同意后作为单独的改动做。
- 贡献指南（CONTRIBUTING）、议题和 PR 模板：开放给别人用、或者第一个外部贡献之前写（见总纲的分册索引）。
