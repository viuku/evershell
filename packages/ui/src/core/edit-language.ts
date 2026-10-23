import { basename } from './paths';

// 编辑器按文件名猜语法类型，决定语法颜色。猜不到就是纯文本

export type EditLanguage =
  | 'nginx'
  | 'shell'
  | 'yaml'
  | 'json'
  | 'toml'
  | 'ini'
  | 'dockerfile'
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'xml'
  | 'css'
  | 'plain';

export const LANGUAGE_LABEL: Record<EditLanguage, string> = {
  nginx: 'Nginx 配置',
  shell: 'Shell',
  yaml: 'YAML',
  json: 'JSON',
  toml: 'TOML',
  ini: '配置文件',
  dockerfile: 'Dockerfile',
  python: 'Python',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  xml: 'XML / HTML',
  css: 'CSS',
  plain: '纯文本',
};

const BY_EXT: Record<string, EditLanguage> = {
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  env: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  cnf: 'ini',
  properties: 'ini',
  service: 'ini',
  timer: 'ini',
  socket: 'ini',
  mount: 'ini',
  dockerfile: 'dockerfile',
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'css',
};

const BY_NAME: Record<string, EditLanguage> = {
  dockerfile: 'dockerfile',
  'nginx.conf': 'nginx',
  'mime.types': 'nginx',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  crontab: 'shell',
  sshd_config: 'ini',
  ssh_config: 'ini',
  'my.cnf': 'ini',
};

/** firstLine：文件第一行，用来认 #!/bin/bash 这种 */
export function guessLanguage(path: string, firstLine = ''): EditLanguage {
  const name = basename(path).toLowerCase();
  const byName = BY_NAME[name];
  if (byName) return byName;
  // nginx 的配置不一定叫 .conf：sites-enabled 里常常没有后缀，fastcgi_params 也是
  if (/\/nginx\//.test(path) && !/\.(ya?ml|json|html?|js|css)$/.test(name)) return 'nginx';
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile';
  if (name.startsWith('.env')) return 'shell';
  const dot = name.lastIndexOf('.');
  const byExt = dot > 0 ? BY_EXT[name.slice(dot + 1)] : undefined;
  if (byExt) return byExt;
  if (name.endsWith('.conf')) return 'ini';
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(firstLine);
  if (shebang) {
    const prog = `${shebang[1]} ${shebang[2] ?? ''}`;
    if (/python/.test(prog)) return 'python';
    if (/node|deno|bun/.test(prog)) return 'javascript';
    if (/sh\b/.test(prog)) return 'shell';
  }
  return 'plain';
}
