// 查清「OJM 只有 4 个样本」这类是真缺资源，还是配对错了。
// 关键：OJN 头 0xEC 处存着真正的 OJM 文件名，不能想当然地用同名 .ojm。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../src/index.js';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OJN_ROOT || path.resolve(TOOLS, '..', '..');

const targets = process.argv.slice(2);
if (!targets.length) targets.push('OfficialBeatmaps/o2ma2712.ojn');

for (const rel of targets) {
  const ojnPath = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const dir = path.dirname(ojnPath);
  const buf = fs.readFileSync(ojnPath);
  const h = C.parseOjnHeader(buf);
  const dec = C.makeTextDecoder(C.detectEncoding([h.rawTitle, h.rawArtist]).encoding);
  const ojmName = dec(h.rawOjm);
  console.log('── ' + path.basename(ojnPath) + '  ' + dec(h.rawArtist) + ' - ' + dec(h.rawTitle));
  console.log('   头部声明 OJM 文件名：' + JSON.stringify(ojmName)
    + '   封面 ' + h.coverSize + 'B   三个难度音符数 ' + JSON.stringify(h.noteCounts));

  // 目录里有哪些 ojm
  const ojms = fs.readdirSync(dir).filter(f => /\.ojm$/i.test(f));
  console.log('   目录里的 .ojm（' + ojms.length + ' 个）：' + ojms.slice(0, 8).join(', ')
    + (ojms.length > 8 ? ' …' : ''));
  const sameBase = path.basename(ojnPath).replace(/\.ojn$/i, '.ojm');
  const byField = ojmName ? path.join(dir, ojmName) : '';
  console.log('   同名 .ojm 存在：' + fs.existsSync(path.join(dir, sameBase))
    + '  头部指定名存在：' + (byField ? fs.existsSync(byField) : 'n/a')
    + (byField && ojmName !== sameBase ? '  ← 两者不同！' : ''));

  // 逐个 OJM 解析，看哪个才配得上
  const cands = [...new Set([byField && fs.existsSync(byField) ? byField : null,
                             fs.existsSync(path.join(dir, sameBase)) ? path.join(dir, sameBase) : null].filter(Boolean))];
  for (const p of cands) {
    const raw = fs.readFileSync(p);
    const sig = raw.subarray(0, 4).toString('ascii').replace(/\0/g, '.');
    let n = -1, declared = null;
    if (raw[0] === 0x4D && raw[1] === 0x33 && raw[2] === 0x30) declared = raw.readInt32LE(12);
    try { n = C.parseOjm(raw, (b) => new TextDecoder('windows-1252').decode(b)).size; } catch (e) { n = 'ERROR ' + e.message; }
    console.log('   ' + path.basename(p).padEnd(18) + sig.padEnd(8)
      + (raw.length / 1048576).toFixed(1) + ' MB   解析出 ' + n + ' 个样本'
      + (declared !== null ? '（M30 头声明 ' + declared + '）' : ''));
  }

  // 谱面引用的样本 id 范围
  const u8 = new Uint8Array(buf);
  const ids = new Set();
  for (let idx = 0; idx < 3; idx++) {
    if (!h.noteCounts[idx]) continue;
    const evs = C.parseOjnEvents(u8, h.noteOffsets[idx], idx < 2 ? h.noteOffsets[idx + 1] : h.coverOffset);
    for (const e of evs) if (e.channel >= 2 && e.channel <= 9) ids.add(e.value);
  }
  const arr = [...ids].sort((a, b) => a - b);
  console.log('   谱面引用的样本 id：' + ids.size + ' 个，范围 ' + arr[0] + ' ~ ' + arr[arr.length - 1]
    + '（前 12 个：' + arr.slice(0, 12).join(',') + '）');
  console.log('');
}
