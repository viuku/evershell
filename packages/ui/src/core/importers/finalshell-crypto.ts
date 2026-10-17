import { desEcbDecrypt, desEcbEncrypt, pkcs5Pad, pkcs5Unpad } from './des';
import { JavaRandom } from './java-random';
import { md5 } from './md5';

// FinalShell 保存的密码：Base64( 8 字节随机头 + DES-ECB/PKCS5 密文 )。
// DES 密钥由随机头经 java.util.Random 派生再取 MD5 前 8 字节。
// 算法依据：FinalshellDecoderX（XLevon）、FinalShellDecodePass（jas502n）两个公开实现，
// 以及博客园上对 FinalShell 原 Java 代码的分析；三者给出的派生步骤一致。

/** Java 的 byte 是带符号的，派生时所有头字节都按带符号值参与 */
function signedByte(b: number): number {
  return (b << 24) >> 24;
}

/** 由 8 字节随机头派生 DES 密钥（8 字节） */
export function deriveFinalShellKey(head: Uint8Array): Uint8Array {
  if (head.length !== 8) throw new Error('随机头必须是 8 字节');
  const hb = (i: number) => signedByte(head[i]!);
  const divisor = new JavaRandom(hb(5)).nextInt(127);
  if (divisor === 0) throw new Error('随机头不合法（派生时除零）');
  const ks = 3680984568597093857n / BigInt(divisor);
  const random = new JavaRandom(ks);
  const skip = hb(0);
  for (let i = 0; i < skip; i++) random.nextLong();
  const n = random.nextLong();
  const r2 = new JavaRandom(n);
  const longs: bigint[] = [BigInt(hb(4)), r2.nextLong(), BigInt(hb(7)), BigInt(hb(3)), r2.nextLong(), BigInt(hb(1)), random.nextLong(), BigInt(hb(2))];
  const buf = new Uint8Array(64);
  const view = new DataView(buf.buffer);
  longs.forEach((v, i) => view.setBigInt64(i * 8, v));
  return md5(buf).subarray(0, 8);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 解出明文；密文损坏或算法不匹配时抛错 */
export function decryptFinalShellPassword(encoded: string): string {
  const bytes = base64ToBytes(encoded);
  if (bytes.length < 16 || (bytes.length - 8) % 8 !== 0) throw new Error('密文长度不合法');
  const key = deriveFinalShellKey(bytes.subarray(0, 8));
  const plain = pkcs5Unpad(desEcbDecrypt(bytes.subarray(8), key));
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}

/** 按同一算法加密，供测试和样例文件使用；head 不传则随机生成 */
export function encryptFinalShellPassword(plain: string, head?: Uint8Array): string {
  let h: Uint8Array;
  if (head) h = head;
  else {
    const random = new Uint8Array(8);
    do crypto.getRandomValues(random);
    while (new JavaRandom(signedByte(random[5]!)).nextInt(127) === 0);
    h = random;
  }
  const key = deriveFinalShellKey(h);
  const data = desEcbEncrypt(pkcs5Pad(new TextEncoder().encode(plain)), key);
  const out = new Uint8Array(8 + data.length);
  out.set(h);
  out.set(data, 8);
  return bytesToBase64(out);
}
