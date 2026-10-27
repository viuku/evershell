// 自建版入口：Node 22.18 以上直接运行这个 .ts 文件（Node 自带去类型），数据存 node:sqlite。
// 用 node:http 自己把请求转给 Hono，省掉 @hono/node-server 这个依赖。
//
// 环境变量：PORT（默认 8790）、DB_PATH（默认 /data/sync.db）、PEPPER（必填）、INVITE_CODE、QUOTA_MB，
// 含义见 docs/handbook/sync-service.md。

import { mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { createApp, readConfig } from './app.ts';
import { sqliteStore } from './store-sqlite.ts';

const env = process.env;

const cfg = readConfig(env);
if (!cfg.ok) {
  // 宁可起不来也不用默认值顶上：PEPPER 一旦用起来就不能再换
  console.error(`${cfg.message}，服务未启动`);
  process.exit(1);
}

const port = Number(env.PORT || 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('同步服务配置错误：PORT 必须是 1～65535 之间的整数，服务未启动');
  process.exit(1);
}

const dbPath = env.DB_PATH || '/data/sync.db';
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const db = sqliteStore(dbPath);
const deps = { store: db.store, config: cfg.config };
const app = createApp(() => ({ ok: true, deps }));

async function handle(req: IncomingMessage, res: ServerResponse) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? 'GET';
  let body: ReadableStream<Uint8Array> | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const it = req[Symbol.asyncIterator]();
    body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel() {
        req.destroy();
      },
    });
  }
  // 主机名固定写 localhost：路由只看路径，不让请求里的 Host 头影响任何东西
  const request = new Request(`http://localhost${req.url ?? '/'}`, {
    method,
    headers,
    body,
    duplex: 'half',
  } as RequestInit);
  const response = await app.fetch(request);
  const out = new Uint8Array(await response.arrayBuffer());
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(out);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error(`[sync] 请求处理失败 ${err instanceof Error ? err.name : typeof err}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    }
    res.end(JSON.stringify({ error: 'internal', message: '同步服务内部错误，请稍后重试' }));
  });
});

server.listen(port, () => {
  const { inviteCode } = cfg.config;
  const registration = inviteCode === undefined ? '关闭' : inviteCode === '' ? '开放' : '需要邀请码';
  console.log(`EverShell 同步服务已启动：端口 ${port}，数据库 ${dbPath}，注册${registration}`);
});

// docker stop 发的是 SIGTERM；先停止接新请求，再关库，免得 WAL 留着没合并
const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
