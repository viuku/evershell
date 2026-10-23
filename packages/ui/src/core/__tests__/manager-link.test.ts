import { describe, expect, it } from 'vitest';
import { asFromManager, ManagerLink } from '../manager-link';
import { localChannelPair } from '../remote-edit';

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const [main, manager] = localChannelPair();
  let opened = 0;
  const connected: string[] = [];
  const link = new ManagerLink(
    {
      ...main,
      open: async () => {
        opened++;
      },
    },
    async (id) => {
      // 每台连接都要等一会儿（比如弹密码框），后面的排队
      await settle();
      connected.push(id);
    },
  );
  link.start();
  const got: unknown[] = [];
  manager.listen((m) => got.push(m));
  return { link, manager, got, connected, opened: () => opened };
}

describe('ManagerLink', () => {
  it('管理器说 ready 之前的“导入”先攒着', async () => {
    const t = setup();
    await t.link.open(true);
    expect(t.opened()).toBe(1);
    await settle();
    expect(t.got).toEqual([{ type: 'hello' }]);
    t.manager.post({ type: 'ready' });
    await settle();
    expect(t.got).toEqual([{ type: 'hello' }, { type: 'import' }]);
    // 已经 ready 了，直接发
    await t.link.open(true);
    await settle();
    expect(t.got.at(-1)).toEqual({ type: 'import' });
  });

  it('管理器关了以后再要导入，等它重新 ready', async () => {
    const t = setup();
    t.manager.post({ type: 'ready' });
    await settle();
    t.manager.post({ type: 'gone' });
    await settle();
    await t.link.open(true);
    await settle();
    expect(t.got).toEqual([{ type: 'hello' }]);
  });

  it('要连的服务器按顺序一台一台连', async () => {
    const t = setup();
    t.manager.post({ type: 'connect', ids: ['a', 'b'] });
    t.manager.post({ type: 'connect', ids: ['c'] });
    await settle();
    await t.link.idle();
    expect(t.connected).toEqual(['a', 'b', 'c']);
  });

  it('格式不对的消息不理', () => {
    expect(asFromManager({ type: 'connect', ids: [1] })).toBeNull();
    expect(asFromManager({ type: 'connect' })).toBeNull();
    expect(asFromManager({ type: 'whatever' })).toBeNull();
    expect(asFromManager('ready')).toBeNull();
    expect(asFromManager({ type: 'connect', ids: ['x'] })).toEqual({ type: 'connect', ids: ['x'] });
  });
});
