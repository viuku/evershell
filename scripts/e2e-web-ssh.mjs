// 网页版 SSH 的无界面端到端测试：在 Node 里加载 ssh-wasm（Node 22 自带浏览器同款 WebSocket），
// 经中转服务连到 SSH 服务器，跑终端、监控采样和 SFTP。
//
// 用法：
//   RELAY=ws://127.0.0.1:8787 RELAY_TOKEN=dev-token TARGET=127.0.0.1:2222 \
//   SSH_USER=me SSH_KEY=/path/to/key node scripts/e2e-web-ssh.mjs
//
// SFTP 部分在 SFTP_DIR（默认 /tmp）下建临时目录，用完删掉。

import { readFileSync } from 'node:fs';
import init, { WebSession } from '../crates/ssh-wasm/pkg/ssh_wasm.js';

const { RELAY, RELAY_TOKEN, TARGET, SSH_USER, SSH_KEY, SSH_PASSWORD } = process.env;
const SFTP_DIR = (process.env.SFTP_DIR ?? '/tmp').replace(/\/+$/, '');
if (!RELAY || !RELAY_TOKEN || !TARGET || !SSH_USER || !(SSH_KEY || SSH_PASSWORD)) {
  console.error('需要 RELAY、RELAY_TOKEN、TARGET、SSH_USER，以及 SSH_KEY 或 SSH_PASSWORD');
  process.exit(2);
}

const wasm = readFileSync(new URL('../crates/ssh-wasm/pkg/ssh_wasm_bg.wasm', import.meta.url));
await init({ module_or_path: wasm });

const url = `${RELAY}/relay?target=${encodeURIComponent(TARGET)}&token=${encodeURIComponent(RELAY_TOKEN)}`;
const decoder = new TextDecoder();
let output = '';
let exitCode;
// 输出要回执，否则积压到上限（约 256KB）后 WASM 就不再读；这里没有界面要画，收到就回执。
// 连接建好之前到的输出先记着，建好后一并回执
let session;
let unacked = 0;
const ack = (n) => {
  unacked += n;
  if (session) {
    session.ack(unacked);
    unacked = 0;
  }
};
const waitFor = (pred, what, ms = 10_000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - started > ms) return reject(new Error(`等待 ${what} 超时，已收到：${JSON.stringify(output)}`));
      setTimeout(tick, 20);
    };
    tick();
  });
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const t0 = performance.now();
// 先不带指纹记录连一次：应在认证前停下、带回服务器指纹；记下后再正式连
const [targetHost, targetPort] = [TARGET.slice(0, TARGET.lastIndexOf(':')), Number(TARGET.slice(TARGET.lastIndexOf(':') + 1))];
const knownHost = await WebSession.connect(url, targetHost, targetPort, '', SSH_USER, SSH_PASSWORD ?? null, null, null, 80, 24, () => {}, () => {})
  .then(() => {
    throw new Error('没记过的服务器不应直接连上');
  })
  .catch((e) => {
    assert(e?.kind === 'hostKey' && e.problem?.kind === 'unknown', `应是首次连接的指纹确认：${e}`);
    const name = targetPort === 22 ? targetHost : `[${targetHost}]:${targetPort}`;
    return `${name} ${e.problem.key.openssh}`;
  });
console.log('没记过的服务器在认证前停下，拿到指纹');

session = await WebSession.connect(
  url,
  targetHost,
  targetPort,
  knownHost,
  SSH_USER,
  SSH_PASSWORD ?? null,
  SSH_KEY ? readFileSync(SSH_KEY, 'utf8') : null,
  null,
  100,
  30,
  (data) => {
    output += decoder.decode(data, { stream: true });
    ack(data.length);
  },
  (code) => (exitCode = code),
);
ack(0);
console.log(`已连接（${(performance.now() - t0).toFixed(0)}ms），服务器指纹 ${session.hostKeyFingerprint}`);

session.write(new TextEncoder().encode('stty size; echo WEB_$((40+2))\r'));
await waitFor(() => output.includes('WEB_42'), 'WEB_42');
if (!output.includes('30 100')) throw new Error(`PTY 尺寸不对：${JSON.stringify(output)}`);
console.log('命令输出正确，PTY 尺寸 100x30');

session.resize(132, 43);
session.write(new TextEncoder().encode('stty size\r'));
await waitFor(() => output.includes('43 132'), 'resize 后的 43 132');
console.log('resize 生效');

// 连续快速写入，检查顺序
output = '';
for (let i = 0; i < 50; i++) session.write(new TextEncoder().encode(`${i % 10}`));
session.write(new TextEncoder().encode('\r'));
const expected = Array.from({ length: 50 }, (_, i) => i % 10).join('');
await waitFor(() => output.includes(expected), '50 个按键按顺序回显');
console.log('50 次连续写入顺序正确');

// 大量输出吞吐
output = '';
const t1 = performance.now();
session.write(new TextEncoder().encode('head -c 3000000 /dev/zero | base64 | wc -c; echo BULK_DONE\r'));
await waitFor(() => output.includes('BULK_DONE\r\n') || /BULK_DONE\s*$/.test(output), '大输出', 30_000);
session.write(new TextEncoder().encode('head -c 1500000 /dev/zero | base64; echo STREAM_$((1+1))\r'));
await waitFor(() => output.includes('STREAM_2'), '2MB 流式输出', 60_000);
const mb = output.length / 1e6;
console.log(`流式输出 ${mb.toFixed(1)}MB 用时 ${(performance.now() - t1).toFixed(0)}ms`);

// 回压：yes 跑 2 秒后 Ctrl-C，紧跟一行标记，看到标记的时间就是停下来的时间
output = '';
session.write(new TextEncoder().encode('stty -echoctl; yes\r'));
await new Promise((r) => setTimeout(r, 2000));
const pressed = performance.now();
session.write(new Uint8Array([3]));
session.write(new TextEncoder().encode('echo FLOW_$((40+2))_DONE\r'));
await waitFor(() => output.includes('FLOW_42_DONE'), 'Ctrl-C 后的标记', 30_000);
const stopMs = performance.now() - pressed;
assert(stopMs < 1000, `Ctrl-C 后 ${stopMs.toFixed(0)}ms 才停`);
console.log(`yes 2 秒收到 ${(output.length / 1e6).toFixed(1)}MB，Ctrl-C 后 ${stopMs.toFixed(0)}ms 停下`);
output = '';

// 监控：连续两次采样
const snapshots = [];
session.startMonitor(500, (s) => snapshots.push(s));
await waitFor(() => snapshots.length >= 2, '两次监控采样', 30_000);
session.stopMonitor();
const [first, second] = snapshots;
assert(typeof first.latencyMs === 'number', `第一次采样应有延迟：${JSON.stringify(first)}`);
if (second.supported) {
  assert(second.cpuCores > 0 && second.memTotal > 0, `Linux 采样字段不完整：${JSON.stringify(second)}`);
  assert(first.net.length === 0 && second.net.length > 0, '第二次采样应有网速');
  assert(second.cpuPercent >= 0 && second.cpuPercent <= 100, `CPU 百分比越界：${second.cpuPercent}`);
  console.log(
    `监控：${second.cpuCores} 核 CPU ${second.cpuPercent.toFixed(1)}%，内存 ${(second.memUsed / 1e6).toFixed(0)}/${(second.memTotal / 1e6).toFixed(0)}MB，` +
      `网卡 ${second.net.map((n) => `${n.iface} ↓${n.rxPerSec.toFixed(0)}B/s`).join(' ')}，磁盘 ${second.disks.length} 个，进程 ${second.procs.length} 个，延迟 ${second.latencyMs?.toFixed(2)}ms`,
  );
} else {
  console.log(`监控：服务器不是 Linux，supported=false（延迟 ${first.latencyMs?.toFixed(2)}ms / ${second.latencyMs?.toFixed(2)}ms）`);
}
const countAfterStop = snapshots.length;
await new Promise((r) => setTimeout(r, 1200));
assert(snapshots.length === countAfterStop, '停止后不应再有快照');

// SFTP：家目录、列目录、上传、下载、改名、删除
const home = await session.homeDir();
assert(home.startsWith('/'), `家目录应是绝对路径：${home}`);
const dir = `${SFTP_DIR}/web-e2e-${process.pid}`;
const file = `${dir}/upload.bin`;
await session.mkdir(dir);
const parent = await session.listDir(SFTP_DIR);
const mine = parent.find((e) => e.name === dir.split('/').pop());
assert(mine && mine.kind === 'dir' && mine.perm.startsWith('d'), `新目录应出现在列表里：${JSON.stringify(mine)}`);

const data = new Uint8Array(200 * 1024 + 77);
for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24;
const upProgress = [];
await session.upload(file, data, (p) => upProgress.push(p));
assert(upProgress.at(-1)?.done === data.length && upProgress.at(-1)?.total === data.length, `上传进度不对：${JSON.stringify(upProgress.at(-1))}`);
const listed = await session.listDir(dir);
assert(listed.length === 1 && listed[0].name === 'upload.bin' && listed[0].size === data.length, `列目录不对：${JSON.stringify(listed)}`);
assert(listed[0].kind === 'file' && listed[0].perm.startsWith('-rw') && listed[0].owner === SSH_USER, `文件属性不对：${JSON.stringify(listed[0])}`);
assert(Math.abs(listed[0].mtime - Date.now() / 1000) < 120, `mtime 不对：${listed[0].mtime}`);

const downProgress = [];
const back = await session.download(file, (p) => downProgress.push(p));
assert(back.length === data.length && back.every((b, i) => b === data[i]), '下载内容与上传不一致');
assert(downProgress.at(-1)?.done === data.length, `下载进度不对：${JSON.stringify(downProgress.at(-1))}`);

await session.rename(file, `${dir}/renamed.bin`);
assert((await session.listDir(dir)).map((e) => e.name).join() === 'renamed.bin', '改名后列表不对');
let err;
await session.remove(dir, true).catch((e) => (err = e));
assert(err instanceof Error && /目录不为空/.test(err.message), `删非空目录应报中文错误：${err}`);
await session.remove(`${dir}/renamed.bin`, false);
await session.remove(dir, true);
err = undefined;
await session.listDir(dir).catch((e) => (err = e));
assert(err instanceof Error && /不存在/.test(err.message), `列已删目录应报不存在：${err}`);
console.log(`SFTP：家目录 ${home}，上传/下载 ${(data.length / 1024).toFixed(0)}KB 一致，列目录、改名、删除正常`);

session.write(new TextEncoder().encode('exit\r'));
await waitFor(() => exitCode !== undefined, '退出');
console.log(`会话结束，退出码 ${exitCode}`);
console.log('E2E_OK');
process.exit(0);
