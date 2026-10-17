import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { desEcbDecrypt, desEcbEncrypt, pkcs5Pad, pkcs5Unpad } from '../des';
import { decryptFinalShellPassword, deriveFinalShellKey, encryptFinalShellPassword } from '../finalshell-crypto';
import { JavaRandom } from '../java-random';
import { md5, toHex } from '../md5';

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const utf8 = (s: string) => new TextEncoder().encode(s);

describe('md5', () => {
  // RFC 1321 附录 A.5 的测试向量
  it('matches RFC 1321 vectors', () => {
    expect(toHex(md5(utf8('')))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(toHex(md5(utf8('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(toHex(md5(utf8('message digest')))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(toHex(md5(utf8('12345678901234567890123456789012345678901234567890123456789012345678901234567890')))).toBe(
      '57edf4a22be3c955ac49da2e2107b67a',
    );
  });

  it('handles inputs around the block boundary', () => {
    // 64 字节输入要多出一个填充块；和 node:crypto 对照
    for (const n of [55, 56, 63, 64, 65, 119, 120, 128]) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
      expect(toHex(md5(data))).toBe(createHash('md5').update(data).digest('hex'));
    }
  });
});

describe('DES', () => {
  // Grabbe《The DES Algorithm Illustrated》里的经典向量
  it('encrypts the classic test vector', () => {
    const out = desEcbEncrypt(hex('0123456789ABCDEF'), hex('133457799BBCDFF1'));
    expect(toHex(out)).toBe('85e813540f0ab405');
    expect(toHex(desEcbDecrypt(out, hex('133457799BBCDFF1')))).toBe('0123456789abcdef');
  });

  // FIPS 81 附录：密钥 0123456789ABCDEF，明文 "Now is the time for all "
  it('encrypts the FIPS 81 ECB example', () => {
    const out = desEcbEncrypt(utf8('Now is the time for all '), hex('0123456789ABCDEF'));
    expect(toHex(out)).toBe('3fa40e8a984d48156a271787ab8883f9893d51ec4b563b53');
  });

  // 三把相同密钥的 3DES 等价于单 DES，用 node:crypto 交叉验证随机数据
  it('agrees with node 3DES for random blocks', () => {
    for (let i = 0; i < 20; i++) {
      const key = crypto.getRandomValues(new Uint8Array(8));
      const data = crypto.getRandomValues(new Uint8Array(8 * (1 + (i % 4))));
      const c = createCipheriv('des-ede3-ecb', Buffer.concat([key, key, key]), null);
      c.setAutoPadding(false);
      const expected = Buffer.concat([c.update(data), c.final()]).toString('hex');
      expect(toHex(desEcbEncrypt(data, key))).toBe(expected);
      expect(toHex(desEcbDecrypt(desEcbEncrypt(data, key), key))).toBe(toHex(data));
    }
  });

  it('pads and unpads PKCS#5', () => {
    expect(Array.from(pkcs5Pad(utf8('abc')))).toEqual([97, 98, 99, 5, 5, 5, 5, 5]);
    expect(pkcs5Pad(new Uint8Array(8)).length).toBe(16);
    expect(Array.from(pkcs5Unpad(pkcs5Pad(utf8('abc'))))).toEqual([97, 98, 99]);
    expect(() => pkcs5Unpad(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 9]))).toThrow();
    expect(() => pkcs5Unpad(Uint8Array.from([1, 2, 3, 4, 5, 6, 2, 3]))).toThrow();
  });
});

describe('JavaRandom', () => {
  // 广为流传的 JDK 输出：new Random(0).nextInt() / nextLong()，new Random(42).nextInt()
  it('reproduces known JDK outputs', () => {
    expect(new JavaRandom(0).nextInt()).toBe(-1155484576);
    expect(new JavaRandom(0).nextLong()).toBe(-4962768465676381896n);
    expect(new JavaRandom(42).nextInt()).toBe(-1170105035);
  });

  it('nextInt(bound) stays in range and handles power-of-two bounds', () => {
    const r = new JavaRandom(7);
    for (let i = 0; i < 200; i++) {
      const a = r.nextInt(127);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(127);
      const b = r.nextInt(16);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(16);
    }
  });
});

describe('FinalShell password', () => {
  // FinalShellDecodePass（jas502n）README 给出的真实样例：两段不同随机头的密文都对应同一明文
  it('decrypts the published samples', () => {
    expect(decryptFinalShellPassword('OGNqLj1Le11Br3AIelAiPaDJpfhBzmEN')).toBe('beac3d85988e');
    expect(decryptFinalShellPassword('UU8hWV51DmVNgmX/pUd0LlaEo53VTa6s')).toBe('beac3d85988e');
  });

  it('derives an 8-byte key and round-trips our own ciphertext', () => {
    expect(deriveFinalShellKey(Uint8Array.from([0x10, 1, 2, 3, 4, 5, 6, 7])).length).toBe(8);
    for (const plain of ['', 'p@ss word', '密码123', 'x'.repeat(40)]) {
      expect(decryptFinalShellPassword(encryptFinalShellPassword(plain))).toBe(plain);
    }
    // 固定头，结果可复现；头字节带符号（0xF0 → -16）也要能走通
    const head = Uint8Array.from([0xf0, 0x81, 0x02, 0xff, 0x04, 0x85, 0x06, 0x7f]);
    const enc = encryptFinalShellPassword('secret', head);
    expect(encryptFinalShellPassword('secret', head)).toBe(enc);
    expect(decryptFinalShellPassword(enc)).toBe('secret');
  });

  it('rejects garbage', () => {
    expect(() => decryptFinalShellPassword('AAAA')).toThrow();
    expect(() => decryptFinalShellPassword('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toThrow();
  });
});
