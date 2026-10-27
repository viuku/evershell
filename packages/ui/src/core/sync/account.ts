import { SyncClient, classify, messageFor, normalizeAccount, normalizeServer, userError, type PulledRecord } from './client';
import { COLLECTIONS_VERSION, knownHostSnapshot, type SyncStores } from './collections';
import { digest } from './digest';
import { HybridClock, newDeviceId } from './hlc';
import { ledgerSet } from './ledger';
import { planFirstMerge, type CloudRecord, type LocalData } from './merge';
import { SyncError, emptyCounts, type EnableResult, type SyncDevice } from './model';
import { SESSION_SECRET, newState } from './state';
import { aadFor, decodeRecords, syncableSecret, type SyncEngine } from './engine';

// 账号相关的流程（docs/specs/sync.md「第一次同步和合并」「改密码」「重新登录」）：
// 注册、登录（含第一次合并）、重新登录、退出、改密码、设备管理。出错一律抛给用户看的 SyncError。

/** 退出登录时最多等服务器多久，连不上也照样退出 */
const LOGOUT_TIMEOUT_MS = 5_000;

function ensureIdle(engine: SyncEngine): void {
  if (engine.active) throw new SyncError('state', '云同步已开启，请先退出登录');
}

function requireSession(engine: SyncEngine, op: string) {
  const st = engine.session;
  if (!st) throw new SyncError('state', `${op}失败：尚未开启云同步`);
  return st;
}

async function deviceName(engine: SyncEngine): Promise<string> {
  try {
    return (await engine.platform.deviceName()).trim() || '未命名设备';
  } catch {
    return '未命名设备';
  }
}

export async function register(
  engine: SyncEngine,
  opts: { server: string; account: string; password: string; invite?: string },
  onStep: (step: number) => void,
): Promise<EnableResult> {
  ensureIdle(engine);
  const server = normalizeServer(opts.server);
  const account = normalizeAccount(opts.account);
  onStep(0);
  const deviceId = newDeviceId();
  const name = await deviceName(engine);
  let token: string;
  let keyCheck: string | null;
  try {
    const { salt, kdf, authKey } = await engine.platform.derive(opts.password, account);
    const wrappedKey = await engine.platform.wrapKey();
    keyCheck = await engine.platform.keyCheck();
    const invite = opts.invite?.trim();
    ({ token } = await engine.client(server, null).register({
      account,
      ...(invite ? { invite } : {}),
      authKey,
      salt,
      kdf,
      wrappedKey,
      device: { id: deviceId, name, platform: engine.platformName },
    }));
  } catch (e) {
    throw userError('注册', e);
  }
  onStep(1);
  try {
    await engine.activate(newState({ server, account, deviceId, deviceName: name, keyCheck, collectionsVersion: COLLECTIONS_VERSION }), token);
  } catch (e) {
    throw userError('注册', e);
  }
  // 开启以后出的错不算开启失败，同步一轮时会显示在状态里
  await engine.scanAll().catch(() => {});
  const uploaded = engine.pendingCounts();
  onStep(2);
  // 上传失败不算开启失败：同步已经开着，状态栏显示原因，后台照常重试
  await engine.syncNow();
  return { mode: 'register', uploaded, downloaded: emptyCounts(), merged: emptyCounts() };
}

/** 拉下账号里的全部记录；同一条在分页之间变了的留新的 */
async function pullEverything(client: SyncClient): Promise<{ records: PulledRecord[]; cursor: number }> {
  const byKey = new Map<string, PulledRecord>();
  let cursor = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    const res = await client.pull(cursor, 1000);
    for (const r of res.records) {
      if (!r.collection) continue;
      const key = `${r.collection}/${r.id}`;
      const prev = byKey.get(key);
      if (!prev || r.hlc > prev.hlc) byKey.set(key, r);
    }
    const last = res.records[res.records.length - 1];
    if (last) cursor = Math.max(cursor, last.seq);
    if (!res.more || !res.records.length) break;
  }
  return { records: [...byKey.values()], cursor };
}

export async function login(
  engine: SyncEngine,
  opts: { server: string; account: string; password: string },
  onStep: (step: number) => void,
): Promise<EnableResult> {
  ensureIdle(engine);
  const server = normalizeServer(opts.server);
  const account = normalizeAccount(opts.account);
  onStep(0);
  const deviceId = newDeviceId();
  const name = await deviceName(engine);
  const client = engine.client(server, null);
  let wrappedKey: string;
  try {
    const pre = await client.prelogin(account);
    const { authKey } = await engine.platform.derive(opts.password, account, pre.salt, pre.kdf);
    const r = await client.login({ account, authKey, device: { id: deviceId, name, platform: engine.platformName } });
    client.token = r.token;
    wrappedKey = r.wrappedKey;
  } catch (e) {
    throw userError('登录', e);
  }
  const token = client.token!;

  // 到这一步之前本机什么都没动；之后出错把刚拿到的令牌吊销掉
  const abandon = async (e: unknown): Promise<never> => {
    await client.logout(LOGOUT_TIMEOUT_MS).catch(() => {});
    throw userError('登录', e);
  };

  onStep(1);
  let records: PulledRecord[] = [];
  let cursor = 0;
  let keyCheck: string | null = null;
  try {
    // 第 1 步：换成云端的保险箱钥匙（本机条目用它重新加密），之后才解得开云端的记录
    await engine.platform.adoptKey(wrappedKey);
    keyCheck = await engine.platform.keyCheck();
    ({ records, cursor } = await pullEverything(client));
  } catch (e) {
    return abandon(e);
  }

  // 第 2 步：解密。解不开的跳过，开启后状态显示同步失败
  let bad = 0;
  const cloud: CloudRecord[] = [];
  const plain = records.filter((r) => r.collection !== 'secret');
  try {
    const values = await decodeRecords(engine.platform, account, plain, engine.byName);
    plain.forEach((r, i) => {
      const v = values[i];
      if (v === 'skip') return;
      if (v === null) bad++;
      else cloud.push({ collection: r.collection, id: r.id, hlc: r.hlc, deleted: r.deleted, value: r.deleted ? null : v, data: '' });
    });
    for (const r of records) {
      if (r.collection === 'secret' && syncableSecret(r.id)) {
        cloud.push({ collection: r.collection, id: r.id, hlc: r.hlc, deleted: r.deleted, value: null, data: r.data });
      }
    }
  } catch (e) {
    return abandon(e);
  }

  onStep(2);
  // 第 3～5 步：去重、同 id 比较，算出合并后的本机数据
  const clock = new HybridClock(deviceId, { ms: 0, c: 0 }, engine.now);
  let maxSeen: string | null = null;
  for (const r of records) {
    if (!r.hlc) continue;
    clock.observe(r.hlc);
    if (!maxSeen || r.hlc > maxSeen) maxSeen = r.hlc;
  }
  const s = engine.stores;
  let plan: ReturnType<typeof planFirstMerge>;
  // 出错时把本机恢复原样：挪过的机密挪回去，新写进来的云端机密删掉，写过的数据换回合并前的。
  // 恢复不了的两样（删掉本机重复的机密、用云端的覆盖本机同 id 的机密）放到开启成功以后再做
  const movedSecrets: { from: string; to: string }[] = [];
  const createdSecrets: string[] = [];
  const appliedSecrets: CloudRecord[] = [];
  let laterSecrets: CloudRecord[] = [];
  let tokenSaved = false;
  let knownHostsWritten = false;
  let before: { stores: StoresSnapshot; knownHosts: string[] } | null = null;
  try {
    const knownHostLines = await engine.knownHosts.lines();
    const knownHosts = new Map<string, string>();
    for (const [id, v] of await knownHostSnapshot(engine.knownHosts)) knownHosts.set(id, v.line);
    const local: LocalData = {
      ...snapshotStores(s),
      knownHosts,
      secretIds: Object.keys(await engine.platform.secretDigests()).filter(syncableSecret),
    };
    plan = planFirstMerge(local, cloud, deviceId);
    const localSecrets = new Set(local.secretIds);

    // 登录令牌先存：存不进保险箱就什么都还没动
    await engine.secrets.set(SESSION_SECRET, token);
    tokenSaved = true;

    // 机密先挪（在平台那一头做完，原文不经过前端），再写前端数据
    for (const m of plan.secretMoves) {
      await engine.platform.moveSecret(m.from, m.to);
      movedSecrets.push(m);
    }

    // 写进本机。同步还没开（没有同步状态），写入不会被当成本机改动
    before = { stores: snapshotStores(s), knownHosts: knownHostLines };
    s.hosts.set(plan.hosts);
    s.keys.set(plan.keys);
    s.snippets.set(plan.snippets);
    s.groups.set(plan.groups);
    s.history.set(plan.history);
    s.recents.set(plan.recents);
    if (plan.knownHostsAdd.length || plan.knownHostsDrop.length) {
      const drop = new Set(plan.knownHostsDrop);
      knownHostsWritten = true;
      await engine.knownHosts.editLines((lines) => {
        const out = lines.filter((l) => !drop.has(l));
        for (const l of plan.knownHostsAdd) if (!out.includes(l)) out.push(l);
        return out;
      });
    }
    // 本机没有的云端机密现在写；本机同 id 已有的（会被覆盖或删掉）等开启成功以后
    laterSecrets = plan.secretsFromCloud.filter((c) => localSecrets.has(c.id));
    for (const c of plan.secretsFromCloud) {
      if (localSecrets.has(c.id)) continue;
      if (await engine.platform.openSecret(c.id, aadFor(account, 'secret', c.id, c.hlc, c.deleted), c.data)) {
        appliedSecrets.push(c);
        if (!c.deleted) createdSecrets.push(c.id);
      } else bad++;
    }

    // 账本照云端记录建：写进本机的和云端一致，不会再推；本机赢的、本机独有的照常比出来成为待上传
    const state = newState({ server, account, deviceId, deviceName: name, keyCheck, collectionsVersion: COLLECTIONS_VERSION });
    state.cursor = cursor;
    state.marks = { ...plan.marks };
    state.maxSeen = maxSeen;
    for (const c of cloud) {
      if (c.collection === 'secret') continue;
      ledgerSet(state.ledger, c.collection, c.id, [c.hlc, c.deleted ? null : digest(c.value)]);
    }
    // 机密的摘要是平台用钥匙算的，换钥匙、写入以后重新取
    const digests = await engine.platform.secretDigests();
    for (const c of appliedSecrets) ledgerSet(state.ledger, 'secret', c.id, [c.hlc, c.deleted ? null : (digests[c.id] ?? null)]);
    state.clock = clock.snapshot();
    await engine.activate(state, token);
  } catch (e) {
    if (before) {
      restoreStores(s, before.stores);
      const lines = before.knownHosts;
      if (knownHostsWritten) await engine.knownHosts.editLines(() => lines).catch(() => {});
    }
    for (const id of createdSecrets) await engine.secrets.remove(id).catch(() => {});
    for (const m of movedSecrets.reverse()) await engine.platform.moveSecret(m.to, m.from).catch(() => {});
    if (tokenSaved) await engine.secrets.remove(SESSION_SECRET).catch(() => {});
    return abandon(e);
  }

  // 开启成功以后：云端覆盖本机同 id 的机密（云端赢）、删掉本机重复的机密。出错不算登录失败，下一轮照常比
  try {
    const applied: CloudRecord[] = [];
    for (const c of laterSecrets) {
      if (await engine.platform.openSecret(c.id, aadFor(account, 'secret', c.id, c.hlc, c.deleted), c.data)) applied.push(c);
      else bad++;
    }
    await engine.recordSecretsApplied(applied);
    for (const id of plan.secretDrops) await engine.secrets.remove(id);
  } catch (e) {
    console.warn('[sync] 开启后写入机密失败', e);
  }
  await engine.scanAll().catch(() => {});
  const uploaded = engine.pendingCounts();
  if (bad) engine.flagUndecryptable();
  await engine.syncNow();
  return { mode: 'login', uploaded, downloaded: plan.downloaded, merged: plan.merged };
}

type StoresSnapshot = Omit<LocalData, 'knownHosts' | 'secretIds'>;

function snapshotStores(s: SyncStores): StoresSnapshot {
  return {
    hosts: s.hosts.get(),
    keys: s.keys.get(),
    snippets: s.snippets.get(),
    groups: s.groups.get(),
    history: s.history.get(),
    recents: s.recents.get(),
  };
}

function restoreStores(s: SyncStores, snap: StoresSnapshot): void {
  s.hosts.set(snap.hosts);
  s.keys.set(snap.keys);
  s.snippets.set(snap.snippets);
  s.groups.set(snap.groups);
  s.history.set(snap.history);
  s.recents.set(snap.recents);
}

/** 「需重新登录」时用新密码登录，账号、服务器、设备沿用 */
export async function relogin(engine: SyncEngine, password: string): Promise<void> {
  const st = requireSession(engine, '登录');
  const client = engine.client(st.server, null);
  // 换钥匙之前查：保险箱是不是重建过（钥匙或保险箱编号变了、被清空）。查不了就别登录，免得误判
  let resetSecrets: boolean;
  try {
    resetSecrets = await engine.vaultLooksReset();
  } catch (e) {
    throw userError('登录', e);
  }
  let keyCheck: string | null = null;
  try {
    const pre = await client.prelogin(st.account);
    const { authKey } = await engine.platform.derive(password, st.account, pre.salt, pre.kdf);
    const r = await client.login({ account: st.account, authKey, device: { id: st.deviceId, name: st.deviceName, platform: engine.platformName } });
    client.token = r.token;
    // 同一把钥匙时平台什么都不做
    await engine.platform.adoptKey(r.wrappedKey);
    keyCheck = await engine.platform.keyCheck();
  } catch (e) {
    if (e instanceof SyncError && e.code === 'bad_credentials') throw new SyncError(e.code, '登录失败：同步密码不正确');
    if (client.token) await client.logout(LOGOUT_TIMEOUT_MS).catch(() => {});
    throw userError('登录', e);
  }
  if (engine.session !== st) return;
  await engine.resume(client.token!, { keyCheck, resetSecrets });
}

/** 退出登录：先吊销令牌（最多等 5 秒，连不上也照样退出），再清掉本机的同步状态和令牌。本机数据保留 */
export async function logout(engine: SyncEngine): Promise<void> {
  const st = engine.session;
  const token = engine.sessionToken;
  if (st && token) await engine.client(st.server, token).logout(LOGOUT_TIMEOUT_MS).catch(() => {});
  await engine.deactivate();
}

export async function changePassword(engine: SyncEngine, password: string): Promise<void> {
  const st = requireSession(engine, '修改同步密码');
  if (password.length < 8) throw new SyncError('invalid', '同步密码至少需要 8 位');
  if (engine.needsRelogin || !engine.sessionToken) throw new SyncError('unauthorized', '修改同步密码失败：登录已失效，请重新登录');
  try {
    // 新盐、默认参数；包裹的还是同一把保险箱钥匙，所以数据不用重新加密
    const { salt, kdf, authKey } = await engine.platform.derive(password, st.account);
    const wrappedKey = await engine.platform.wrapKey();
    await engine.client().changePassword({ authKey, salt, kdf, wrappedKey });
  } catch (e) {
    throw handle(engine, '修改同步密码', e);
  }
}

/** 接口出错：令牌没了顺便把状态改成「需重新登录」 */
function handle(engine: SyncEngine, op: string, e: unknown): SyncError {
  if (classify(e) === 'relogin') engine.markRelogin();
  return userError(op, e);
}

export async function listDevices(engine: SyncEngine): Promise<SyncDevice[]> {
  const st = requireSession(engine, '获取设备列表');
  try {
    const info = await engine.client().account();
    return info.devices.map((d) => ({ ...d, current: d.current || d.id === st.deviceId }));
  } catch (e) {
    throw handle(engine, '获取设备列表', e);
  }
}

export async function removeDevice(engine: SyncEngine, id: string): Promise<void> {
  const st = requireSession(engine, '移除设备');
  if (id === st.deviceId) throw new SyncError('invalid', '无法移除本机，如需停止同步，请使用「退出登录」');
  try {
    await engine.client().removeDevice(id);
  } catch (e) {
    throw handle(engine, '移除设备', e);
  }
}

export async function renameDevice(engine: SyncEngine, name: string): Promise<void> {
  requireSession(engine, '重命名');
  const trimmed = name.trim();
  if (!trimmed) throw new SyncError('invalid', '请输入本机名称');
  try {
    await engine.client().renameDevice(trimmed);
  } catch (e) {
    throw handle(engine, '重命名', e);
  }
  engine.setDeviceName(trimmed);
}

/** 同步服务器要不要邀请码；连不上一律写「无法连接同步服务器：原因」 */
export async function serverInfo(fetchFn: typeof fetch, server: string): Promise<{ registration: 'invite' | 'open' | 'closed' }> {
  try {
    return await new SyncClient(normalizeServer(server), fetchFn).info();
  } catch (e) {
    const msg = messageFor('连接', e);
    throw new SyncError(e instanceof SyncError ? e.code : 'network', msg.startsWith('无法连接') ? msg : `无法连接同步服务器：${msg.replace(/^连接失败：/, '')}`);
  }
}
