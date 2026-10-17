// 网页版 SSH 的 TCP 中转（Cloudflare Workers 版）。
// 协议与 services/relay-node 一致：GET /relay?target=<host>:<port>&token=<RELAY_TOKEN>，
// 升级为 WebSocket 后双向透传二进制帧。SSH 协议在浏览器里跑，这里看不到明文。
//
// Workers 的限制：不能连 Cloudflare 自己的 IP 段，25 端口被封。

import { connect } from 'cloudflare:sockets';

interface Env {
  RELAY_TOKEN?: string;
}

function parseTarget(raw: string | null): { hostname: string; port: number } | null {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(raw ?? '');
  if (!m) return null;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  return { hostname: m[1] ?? m[2], port };
}

async function tokenOk(given: string | null, expected: string): Promise<boolean> {
  // 先各自哈希再比较，长度不同也不会提前返回
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given ?? '')),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/relay') return new Response(null, { status: 404 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    if (!env.RELAY_TOKEN) {
      return new Response('RELAY_TOKEN not configured', { status: 500 });
    }
    const target = parseTarget(url.searchParams.get('target'));
    if (!target || !(await tokenOk(url.searchParams.get('token'), env.RELAY_TOKEN))) {
      return new Response(null, { status: 403 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    // 新兼容日期下二进制消息默认是 Blob，new Uint8Array(blob) 会得到空数组
    server.binaryType = 'arraybuffer';
    relay(server, target);
    return new Response(null, { status: 101, webSocket: client });
  },
} satisfies ExportedHandler<Env>;

function relay(ws: WebSocket, target: { hostname: string; port: number }) {
  const tcp = connect(target);
  const writer = tcp.writable.getWriter();
  const reader = tcp.readable.getReader();
  let connected = false;
  let finished = false;
  tcp.closed.catch(() => {});
  writer.closed.catch(() => {});

  // 任何一端结束都走这里，两边都关掉。不能留下挂起的 read，
  // 否则运行时会判定 Worker 卡死并记一条异常。
  const finish = (code: number, reason: string) => {
    if (finished) return;
    finished = true;
    try {
      ws.close(code, reason);
    } catch {}
    reader.cancel().catch(() => {});
    tcp.close().catch(() => {});
  };

  // 写入按调用顺序排队，不需要等上一个完成
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') return;
    writer.write(new Uint8Array(e.data)).catch(() => {});
  });
  ws.addEventListener('close', () => finish(1000, 'closed'));
  ws.addEventListener('error', () => finish(1011, 'websocket error'));

  (async () => {
    try {
      await tcp.opened;
      connected = true;
      for (;;) {
        const { value, done } = await reader.read();
        if (done || finished) break;
        ws.send(value);
      }
      finish(1000, 'eof');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // close reason 最多 123 字节
      finish(1011, `${connected ? 'tcp' : 'connect'} ${msg}`.slice(0, 120));
    }
  })();
}
