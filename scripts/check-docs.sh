#!/bin/sh
# 检查规范体系（CLAUDE.md、docs/handbook/*.md）里写到的东西是否还对得上：
#   - 链接和反引号里的仓库路径还在不在
#   - 链接里的 #锚点 在目标文件里有没有这个标题
# 改名、挪目录、删脚本、改标题之后跑一下，找出该更新的地方。scripts/check.sh docs 也会跑它。
cd "$(dirname "$0")/.."

python3 - CLAUDE.md docs/handbook/*.md <<'EOF'
import os, re, sys

ROOTS = ('apps/', 'packages/', 'crates/', 'scripts/', 'docs/', 'services/', 'vendor/', '.claude/', '.cargo/')
FILES = {'Cargo.toml', 'Cargo.lock', 'package.json', 'README.md', 'CLAUDE.md', 'LICENSE', 'CHANGELOG.md'}

def slug(heading):
    """GitHub 的标题锚点：去掉格式符号和标点，小写，空格换成 -"""
    text = re.sub(r'[`*_]|\[([^\]]*)\]\([^)]*\)', lambda m: m.group(1) or '', heading).strip().lower()
    text = re.sub(r'[^\w\- ]', '', text)
    return text.replace(' ', '-')

anchors = {}
def anchors_of(path):
    if path not in anchors:
        found = set()
        if path.endswith('.md') and os.path.isfile(path):
            in_code = False
            for line in open(path, encoding='utf-8'):
                if line.startswith('```'):
                    in_code = not in_code
                elif not in_code and re.match(r'#{1,6} ', line):
                    found.add(slug(line.lstrip('#').strip()))
        anchors[path] = found
    return anchors[path]

problems = []
checked = 0
for doc in sys.argv[1:]:
    base = os.path.dirname(doc)
    in_code = False
    for n, line in enumerate(open(doc, encoding='utf-8'), 1):
        if line.startswith('```'):
            in_code = not in_code
            continue
        if in_code:
            continue
        for target in re.findall(r'\]\(([^)\s]+)\)', line):
            if re.match(r'[a-z]+:', target):
                continue
            path, _, anchor = target.partition('#')
            path = os.path.normpath(os.path.join(base, path)) if path else doc
            checked += 1
            if not os.path.exists(path):
                problems.append(f'{doc}:{n}  链接的文件不存在：{path}')
            elif anchor and anchor not in anchors_of(path):
                problems.append(f'{doc}:{n}  {path} 里没有标题锚点 #{anchor}')
        for code in re.findall(r'`([^`]+)`', line):
            token = code.split()[0] if code.split() else ''
            if token != code or any(c in token for c in '<>*…$|{}'):
                continue
            token = re.sub(r':\d+(-\d+)?$', '', token).rstrip('/')
            if token.startswith(ROOTS) or token in FILES:
                checked += 1
                if not os.path.exists(token):
                    problems.append(f'{doc}:{n}  写到的路径不存在：{token}')
if problems:
    print('规范体系里这些地方对不上了，更新文档：')
    print('\n'.join(problems))
    sys.exit(1)
print(f'规范体系里的 {checked} 处路径和链接都对得上')
EOF
