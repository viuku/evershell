// Cloudflare Workers 入口：D1 存数据。部署步骤见 docs/handbook/sync-service.md。
// 配置缺了不能像 Node 版那样拒绝启动，只能每个请求都回 500 并写明原因，
// 部署后用 curl 打一下 /v1/info 就能看出来。

import { createApp, readConfig, type ConfigVars } from './app.ts';
import { d1Store } from './store-d1.ts';

interface Env extends ConfigVars {
  DB: D1Database;
}

const app = createApp<Env>((env) => {
  const cfg = readConfig(env);
  if (!cfg.ok) return cfg;
  return { ok: true, deps: { store: d1Store(env.DB), config: cfg.config } };
});

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;
