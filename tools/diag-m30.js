// 对比正常/异常 M30 的头结构与样本条目，找出解析断链的原因。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OJN_ROOT || path.resolve(TOOLS, '..', '..');

for (const rel of process.argv.slice(2)) {
  const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const b = fs.readFileSync(p);
  console.log('── ' + path.basename(p) + '  ' + b.length + ' 字节');
  const h = {
    magic: b.subarray(0, 4).toString('ascii').replace(/\0/g, '.'),
    version: b.readInt32LE(4),
    encFlag: b.readInt32LE(8),
    sampleCount: b.readInt32LE(12),
    sampleOffset: b.readInt32LE(16),
    payloadSize: b.readInt32LE(20),
    padding: b.readInt32LE(24),
  };
  console.log('   头: ' + JSON.stringify(h));
  console.log('   28 + 52*count = ' + (28 + 52 * h.sampleCount) + '；文件长 ' + b.length
    + ' → 剩余 ' + (b.length - 28 - 52 * h.sampleCount) + ' 字节当样本数据');

  // 按 52 字节步进扫描前几条，看每条的“样本大小”是否合理
  let p2 = 28;
  for (let i = 0; i < Math.min(6, h.sampleCount); i++) {
    if (p2 + 52 > b.length) { console.log('   第 ' + i + ' 条越界'); break; }
    const name = b.subarray(p2, p2 + 32).toString('latin1').replace(/\0.*$/, '');
    const size = b.readInt32LE(p2 + 32);
    const codec = b.readInt16LE(p2 + 36), codec2 = b.readInt16LE(p2 + 38);
    const musicFlag = b.readInt32LE(p2 + 40);
    const ref = b.readInt16LE(p2 + 44), unk = b.readInt16LE(p2 + 46);
    const pcm = b.readInt32LE(p2 + 48);
    console.log('   #' + i + ' @' + p2 + '  name=' + JSON.stringify(name) + ' size=' + size
      + ' codec=' + codec + ',' + codec2 + ' music=' + musicFlag + ' ref=' + ref + ',' + unk + ' pcm=' + pcm
      + (size <= 0 || p2 + 52 + size > b.length ? '   ← 大小不合理' : ''));
    if (size <= 0 || p2 + 52 + size > b.length) { console.log('      在此断链'); break; }
    p2 += 52 + size;
  }
  console.log('');
}
