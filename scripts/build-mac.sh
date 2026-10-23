#!/bin/sh
# 打 Mac 正式版：签名编译出 EverShell.app，放进仓库根目录的 build/（不打 dmg，不公证）。
# 签名证书见 apps/desktop/src-tauri/tauri.macos.conf.json；没有证书时：
#   APPLE_SIGNING_IDENTITY=- scripts/build-mac.sh
set -e
cd "$(dirname "$0")/.."

npm run tauri -w @evershell/desktop -- build

mkdir -p build
rm -rf build/EverShell.app
# ditto 是 macOS 自带的复制工具，原样保留签名和扩展属性
ditto target/release/bundle/macos/EverShell.app build/EverShell.app
codesign --verify --deep --strict build/EverShell.app
# 中间产物删掉：所有者在访达、聚焦搜索里只该看到 build/ 这一份
rm -rf target/release/bundle/macos/EverShell.app
echo "已生成 build/EverShell.app"
