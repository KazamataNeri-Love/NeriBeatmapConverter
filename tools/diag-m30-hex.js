// 十六进制实证：找出异常 M30 的「样本条目步进」到底是多少。
// 做法：从 28 开始扫，找到下一个“看起来像样本名”的偏移，看 delta 规律。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OJN_ROOT || path.resolve(TOOLS, '..', '..');

const looksLikeName = (b, o) => {
  if (o + 3 > b.length) return false;
  let n = 0;
  for (let i = 0; i < 32; i++) {
    const c = b[o + i];
    if (c === 0) break;
    if (c < 0x20 || c > 0x7E) return false;      // 必须是可打印 ASCII
    n++;
  }
  return n >= 3;
};

for (const rel of process.argv.slice(2)) {
  const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const b = fs.readFileSync(p);
  const count = b.readInt32LE(12);
  console.log('── ' + path.basename(p) + '  声明 ' + count + ' 个样本，' + b.length + ' 字节');

  // 28 起 160 字节 hex+ascii
  const from = 28, to = 28 + 160;
  for (let o = from; o < to; o += 16) {
    const row = [...b.subarray(o, o + 16)].map(x => x.toString(16).padStart(2, '0')).join(' ');
    const asc = [...b.subarray(o, o + 16)].map(x => (x >= 0x20 && x < 0x7F ? String.fromCharCode(x) : '.')).join('');
    console.log('   ' + String(o).padStart(8) + '  ' + row.padEnd(48) + ' |' + asc + '|');
  }

  // 在开头 4KB 内列出所有“像名字”的位置
  const hits = [];
  for (let o = 28; o < Math.min(b.length - 32, 28 + 4096); o++) {
    if (looksLikeName(b, o)) {
      const nm = b.subarray(o, o + 32).toString('latin1').replace(/\0.*$/, '');
      hits.push({ o, nm });
      o += 31;
    }
  }
  console.log('   开头 4KB 内疑似样本名：' + hits.slice(0, 8).map(h => h.o + ':"' + h.nm + '"').join('  '));
  if (hits.length >= 2) {
    const d = hits[1].o - hits[0].o;
    const declaredSize = b.readInt32LE(hits[0].o + 32);
    console.log('   第1→第2 条步进 = ' + d + '；若按 52 头 + size 算 = ' + (52 + declaredSize)
      + '  → ' + (d === 52 + declaredSize ? '吻合（52 布局）' : '不吻合 → 头长可能是 ' + (d - declaredSize)));
  }
  console.log('');
}
