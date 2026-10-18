import type { HostKeyInfo, HostKeyProblem, SecretStore } from '../types';
import { readText, writeText } from './storage';

// 服务器指纹记录。内容就是 OpenSSH 的 known_hosts 格式，可以把 ~/.ssh/known_hosts 原样导进来。
// 校验在 Rust 内核里做（crates/ssh-core/src/known_hosts.rs），这里只负责存取和增删行。
//
// 桌面端存进加密的保险箱：防止别的程序悄悄改记录、把冒充的服务器写成“认识的”。
// 网页端没有保险箱，存在浏览器里。

/** 保险箱里的条目名 */
const SECRET_ID = 'known_hosts';
/** 网页端存在 localStorage 的键 */
const LOCAL_KEY = 'evershell.knownHosts';

/** known_hosts 里查这台服务器用的名字，和 Rust 的 host_name 一致 */
export function hostName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** 新记一把钥匙时加的那一行 */
export function lineFor(host: string, port: number, key: HostKeyInfo): string {
  return `${hostName(host, port)} ${key.openssh}`;
}

/** 主机密钥没通过时用户的决定：trust 接受并保存、once 只接受本次、update 核实后换成新密钥、cancel 不连 */
export type HostKeyDecision = 'trust' | 'once' | 'update' | 'cancel';
/** 要问用户的情况；被吊销的密钥直接拒绝，不问 */
export type AskableHostKeyProblem = Extract<HostKeyProblem, { kind: 'unknown' | 'changed' }>;

/** 按用户的决定处理：记下或换掉密钥后重连，或者只放行这一次（`trustOnce` 是临时加进记录的一行，不保存）。
 *  `retry` 为 false 表示不连了 */
export async function applyHostKeyDecision(
  store: KnownHostsStore,
  problem: HostKeyProblem,
  decision: HostKeyDecision,
): Promise<{ retry: true; trustOnce: string } | { retry: false }> {
  if (problem.kind === 'unknown' && decision === 'trust') {
    await store.trust(problem.host, problem.port, problem.key);
    return { retry: true, trustOnce: '' };
  }
  if (problem.kind === 'unknown' && decision === 'once') {
    return { retry: true, trustOnce: lineFor(problem.host, problem.port, problem.key) };
  }
  if (problem.kind === 'changed' && decision === 'update') {
    await store.replace(problem);
    return { retry: true, trustOnce: '' };
  }
  return { retry: false };
}

/** 连接时交给后端的记录：保存的记录，加上“只接受本次”临时放行的那一行 */
export function withTrustOnce(knownHosts: string, trustOnce: string): string {
  return trustOnce ? `${knownHosts}\n${trustOnce}\n` : knownHosts;
}

export class KnownHostsStore {
  // 两个标签同时确认指纹时，读改写要排队，免得后写的覆盖先写的
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly secrets: SecretStore) {}

  /** 读不出来（比如钥匙串拒绝访问）时当作空记录：每台服务器都会再问一次，但不会放过对不上的指纹 */
  async load(): Promise<string> {
    if (!this.secrets.available) return readText(LOCAL_KEY) ?? '';
    try {
      return (await this.secrets.get(SECRET_ID)) ?? '';
    } catch (err) {
      console.error('[known-hosts] 读取指纹记录失败', err);
      return '';
    }
  }

  /** 第一次连接时用户点了信任 */
  trust(host: string, port: number, key: HostKeyInfo): Promise<void> {
    return this.modify((text) => appendLine(text, lineFor(host, port, key)));
  }

  /** 指纹变了、用户核实后点了更新：删掉只属于这台服务器的旧行，记下新的。
   *  带通配的旧行不删（会影响别的服务器），新行在前面匹配上就算认识，不受它影响 */
  replace(problem: Extract<HostKeyProblem, { kind: 'changed' }>): Promise<void> {
    const stale = new Set(problem.recorded.filter((r) => r.exact).map((r) => r.line));
    return this.modify((text) =>
      appendLine(
        text
          .split('\n')
          .filter((l) => !stale.has(l))
          .join('\n'),
        lineFor(problem.host, problem.port, problem.key),
      ),
    );
  }

  private modify(edit: (text: string) => string): Promise<void> {
    const next = this.chain.then(async () => this.save(edit(await this.load())));
    this.chain = next.catch(() => {});
    return next;
  }

  private async save(text: string): Promise<void> {
    if (this.secrets.available) await this.secrets.set(SECRET_ID, text);
    else writeText(LOCAL_KEY, text);
  }
}

function appendLine(text: string, line: string): string {
  const body = text.replace(/\n+$/, '');
  return body ? `${body}\n${line}\n` : `${line}\n`;
}
