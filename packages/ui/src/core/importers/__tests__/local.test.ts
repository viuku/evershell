import { describe, expect, it } from 'vitest';
import { firstFound, scanLocalConfigs } from '../local';
import { loadDir, textFile } from './fixtures';

describe('scanLocalConfigs', () => {
  const scan = scanLocalConfigs([
    { source: 'openssh', location: '~/.ssh/config', files: [textFile('config', 'Host *\n  User me\n')], error: null },
    { source: 'putty', location: '~/.putty/sessions', files: [], error: null },
    { source: 'securecrt', location: '~/Library/Application Support/VanDyke/SecureCRT/Config/Sessions', files: [], error: '没有权限读取' },
    { source: 'finalshell', location: '~/Library/FinalShell/conn', files: loadDir('finalshell/conn'), error: null },
    { source: 'termius', location: '~/x', files: [textFile('a', 'b')], error: null },
  ]);

  it('parses found configs the same way as a picked folder', () => {
    const fs = scan.get('finalshell');
    expect(fs?.state).toBe('found');
    if (fs?.state !== 'found') return;
    expect(fs.location).toBe('~/Library/FinalShell/conn');
    expect(fs.result.servers.map((s) => s.name)).toContain('web-01');
    expect(fs.result.servers.some((s) => s.password !== null)).toBe(true);
  });

  it('tells apart empty, missing and unreadable locations', () => {
    expect(scan.get('openssh')).toEqual({ state: 'empty', location: '~/.ssh/config' });
    expect(scan.get('putty')).toEqual({ state: 'missing', location: '~/.putty/sessions' });
    expect(scan.get('securecrt')).toMatchObject({ state: 'error', message: '没有权限读取' });
  });

  it('ignores sources the backend did not check or the ui does not know', () => {
    expect(scan.has('xshell')).toBe(false);
    expect([...scan.keys()]).not.toContain('termius');
  });

  it('selects the first found source in list order', () => {
    expect(firstFound(scan)).toBe('finalshell');
    const ssh = scanLocalConfigs([
      { source: 'openssh', location: '~/.ssh/config', files: [textFile('config', 'Host a\n  HostName 192.0.2.1\n')], error: null },
    ]);
    expect(firstFound(ssh)).toBe('openssh');
    expect(firstFound(scanLocalConfigs([]))).toBeNull();
  });
});
