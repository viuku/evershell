#!/bin/sh
# 检查给 AI 看的说明书（CLAUDE.md、docs/dev/*.md）里写到的文件路径是否都还在。
# 改名、挪目录、删脚本之后跑一下，找出该更新的地方。scripts/check.sh docs 也会跑它。
cd "$(dirname "$0")/.."

python3 - CLAUDE.md docs/dev/*.md <<'EOF'
import os, re, sys

ROOTS = ('apps/', 'packages/', 'crates/', 'scripts/', 'docs/', 'services/', 'vendor/', '.claude/', '.cargo/')
FILES = {'Cargo.toml', 'Cargo.lock', 'package.json', 'README.md', 'CLAUDE.md', 'LICENSE'}
missing = []
for doc in sys.argv[1:]:
    base = os.path.dirname(doc)
    for n, line in enumerate(open(doc, encoding='utf-8'), 1):
        found = []
        for target in re.findall(r'\]\(([^)\s]+)\)', line):
            if re.match(r'[a-z]+:|#', target):
                continue
            found.append(os.path.normpath(os.path.join(base, target.split('#')[0])))
        for code in re.findall(r'`([^`]+)`', line):
            # 只看像仓库路径的：不带空格、通配符、占位符
            token = code.split()[0] if code.split() else ''
            if token != code or any(c in token for c in '<>*…$|{}'):
                continue
            token = re.sub(r':\d+(-\d+)?$', '', token).rstrip('/')
            if token.startswith(ROOTS) or token in FILES:
                found.append(token)
        for path in found:
            if not os.path.exists(path):
                missing.append(f'{doc}:{n}  {path}')
if missing:
    print('这些路径不存在了，更新说明书：')
    print('\n'.join(missing))
    sys.exit(1)
print('说明书里的路径都在')
EOF
