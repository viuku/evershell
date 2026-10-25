import { describe, expect, it } from 'vitest';
import { sendTo, toTerminalInput, type CommandSender } from '../commands-panel';

/** 记下发了什么，connected 是已连接的会话 */
function fakeSender(connected: string[]) {
  const sent: { to: string; cmd: string; enter?: false }[] = [];
  // 不按回车的才记 enter: false，其余用例照旧只比 to 和 cmd
  const record = (to: string, cmd: string, enter = true) => sent.push(enter ? { to, cmd } : { to, cmd, enter: false });
  const sender: CommandSender = {
    sendCommand(id, cmd, enter) {
      if (!connected.includes(id)) return false;
      record(id, cmd, enter);
      return true;
    },
    sendToAll(cmd, enter) {
      for (const id of connected) record(id, cmd, enter);
      return connected.length;
    },
  };
  return { sender, sent };
}

describe('toTerminalInput', () => {
  it('换行统一成回车，去掉首尾空行', () => {
    expect(toTerminalInput('cd /opt/app\ngit pull\r\ndocker compose up -d\n\n')).toBe('cd /opt/app\rgit pull\rdocker compose up -d');
    expect(toTerminalInput('\n  \nls\n')).toBe('ls');
  });

  it('中间的空行和缩进保留', () => {
    expect(toTerminalInput('if true; then\n  echo hi\n\nfi')).toBe('if true; then\r  echo hi\r\rfi');
  });

  it('全是空白得到空字符串', () => {
    expect(toTerminalInput(' \n\t\n')).toBe('');
  });
});

describe('sendTo', () => {
  it('发到当前会话，提示带上快捷命令的名字', () => {
    const { sender, sent } = fakeSender(['s1', 's2']);
    expect(sendTo(sender, 's1', 'current', 'df -h', { name: '查看磁盘' })).toEqual({ ok: true, text: '已将「查看磁盘」发送到当前会话' });
    expect(sendTo(sender, 's1', 'current', 'a\nb')).toEqual({ ok: true, text: '已发送到当前会话' });
    expect(sent).toEqual([
      { to: 's1', cmd: 'df -h' },
      { to: 's1', cmd: 'a\rb' },
    ]);
  });

  it('当前会话未连接', () => {
    const { sender, sent } = fakeSender(['s2']);
    expect(sendTo(sender, 's1', 'current', 'ls')).toEqual({ ok: false, text: '当前会话未连接' });
    expect(sent).toEqual([]);
  });

  it('发到全部会话', () => {
    const { sender, sent } = fakeSender(['s1', 's2', 's3']);
    expect(sendTo(sender, 's1', 'all', 'uptime', { name: '负载' })).toEqual({ ok: true, text: '已发送到 3 个会话' });
    expect(sent).toHaveLength(3);
    expect(sendTo(fakeSender([]).sender, 's1', 'all', 'uptime')).toEqual({ ok: false, text: '没有已连接的会话' });
  });

  it('空内容什么都不发', () => {
    const { sender, sent } = fakeSender(['s1']);
    expect(sendTo(sender, 's1', 'current', '  \n ')).toBeNull();
    expect(sendTo(sender, 's1', 'all', '')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('不自动回车：末尾不按回车，提示写明没按', () => {
    const { sender, sent } = fakeSender(['s1', 's2']);
    expect(sendTo(sender, 's1', 'current', 'kill -9 ', { name: '杀进程', noEnter: true })).toEqual({
      ok: true,
      text: '已将「杀进程」填入当前会话，未发送回车',
    });
    expect(sendTo(sender, 's1', 'all', 'docker exec -it ', { noEnter: true })).toEqual({ ok: true, text: '已填入 2 个会话，未发送回车' });
    expect(sent).toEqual([
      { to: 's1', cmd: 'kill -9 ', enter: false },
      { to: 's1', cmd: 'docker exec -it ', enter: false },
      { to: 's2', cmd: 'docker exec -it ', enter: false },
    ]);
  });

  it('不自动回车的多行命令：前面几行照样带回车，只有最后一行等用户按', () => {
    const { sender, sent } = fakeSender(['s1']);
    sendTo(sender, 's1', 'current', 'cd /srv/app\ngit checkout ', { noEnter: true });
    expect(sent).toEqual([{ to: 's1', cmd: 'cd /srv/app\rgit checkout ', enter: false }]);
  });
});
