// 网页版 SSH 的 TCP 中转（自建部署版）。
// 只做 WebSocket ↔ TCP 字节转发，SSH 协议在浏览器里跑，这里看不到明文。
//
// 协议：GET /relay?target=<host>:<port>&token=<RELAY_TOKEN>，升级为 WebSocket 后双向透传二进制帧。
// 与 services/relay-worker 保持一致。

import { createServer } from 'node:http';
import { connect } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.RELAY_TOKEN;
if (!TOKEN) {
  console.error('必须设置 RELAY_TOKEN，否则任何人都能把这个中转当代理用');
  process.exit(1);
}

// TCP 发不过来时先暂停读 WebSocket 的阈值
const HIGH_WATER = 1 << 20;

function tokenOk(token) {
  const a = Buffer.from(token ?? '');
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseTarget(raw) {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(raw ?? '');
  if (!m) return null;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1] ?? m[2], port };
}

const http = createServer((_, res) => {
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ noServer: true });

http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const target = parseTarget(url.searchParams.get('target'));
  if (url.pathname !== '/relay' || !target || !tokenOk(url.searchParams.get('token'))) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => relay(ws, target));
});

function relay(ws, { host, port }) {
  const tcp = connect({ host, port, noDelay: true });
  let connected = false;

  tcp.on('connect', () => {
    connected = true;
  });
  tcp.on('data', (chunk) => {
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > HIGH_WATER) {
      tcp.pause();
      waitDrain(ws, () => tcp.resume());
    }
  });
  tcp.on('end', () => ws.close(1000, 'eof'));
  tcp.on('error', (err) => {
    // close reason 最多 123 字节，只放错误码
    ws.close(1011, connected ? `tcp ${err.code ?? 'error'}` : `connect ${err.code ?? 'failed'}`);
  });
  tcp.on('close', () => {
    if (ws.readyState === ws.OPEN) ws.close(1000, 'eof');
  });

  // 连接建立前收到的数据由 net.Socket 自己缓存，按顺序发出
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (!tcp.write(data)) {
      ws.pause();
      tcp.once('drain', () => ws.resume());
    }
  });
  ws.on('close', () => tcp.destroy());
  ws.on('error', () => tcp.destroy());
}

function waitDrain(ws, done) {
  const timer = setInterval(() => {
    if (ws.bufferedAmount < HIGH_WATER / 2 || ws.readyState !== ws.OPEN) {
      clearInterval(timer);
      done();
    }
  }, 20);
}

http.listen(PORT, () => {
  console.log(`relay listening on :${PORT}`);
});
