import { describe, expect, it } from 'vitest';
import { formatPerm, parseOctal, parsePerm, toOctal } from '../permissions';

describe('parsePerm / formatPerm', () => {
  it('普通权限来回转', () => {
    expect(parsePerm('drwxr-xr-x')).toBe(0o755);
    expect(parsePerm('-rw-r-----')).toBe(0o640);
    expect(formatPerm(0o755, 'dir')).toBe('drwxr-xr-x');
    expect(formatPerm(0o600, 'file')).toBe('-rw-------');
  });

  it('SUID、SGID、粘滞位落在执行位上，大写表示没有执行权限', () => {
    expect(parsePerm('-rwsr-xr-x')).toBe(0o4755);
    expect(parsePerm('drwxr-sr-x')).toBe(0o2755);
    expect(parsePerm('drwxrwxrwt')).toBe(0o1777);
    expect(parsePerm('-rwSr--r--')).toBe(0o4644);
    expect(formatPerm(0o1777, 'dir')).toBe('drwxrwxrwt');
    expect(formatPerm(0o4644, 'file')).toBe('-rwSr--r--');
  });

  it('认不出来的返回 null', () => {
    expect(parsePerm('')).toBeNull();
    expect(parsePerm('drwxr-xr-?')).toBeNull();
  });
});

describe('toOctal / parseOctal', () => {
  it('有特殊位时写四位', () => {
    expect(toOctal(0o755)).toBe('755');
    expect(toOctal(0o640)).toBe('640');
    expect(toOctal(0o2755)).toBe('2755');
    expect(toOctal(0o7)).toBe('007');
  });

  it('只认三四位八进制数', () => {
    expect(parseOctal('755')).toBe(0o755);
    expect(parseOctal(' 0644 ')).toBe(0o644);
    expect(parseOctal('4755')).toBe(0o4755);
    expect(parseOctal('78')).toBeNull();
    expect(parseOctal('99a')).toBeNull();
    expect(parseOctal('75')).toBeNull();
  });
});
