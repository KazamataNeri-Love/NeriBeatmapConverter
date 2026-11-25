// 在真实图库上量化「Note 提前」问题：统计每首实际能解析到几个音频对象，
// 以及旧版（单对象时返回 musicOffset = 首样本时间）会把整张图提前多少毫秒。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../src/index.js';

// 图库根：默认项目目录的上一级（可用 OJN_ROOT 环境变量指定）
const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.OJN_ROOT || path.resolve(TOOLS, '..', '..');

function walk(dir, out) {
  out = out || [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/o2jam-to-osu|Failed|SeriousBeatmapConverter|O2Jam-2-osu/.test(e.name)) walk(p, out); }
    else if (/\.ojn$/i.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(root);
console.log('图库里的 .ojn 数量：', files.length);

const stat = { songs: 0, charts: 0, single: 0, singleShifted: 0, multi: 0, noSample: 0, noOjm: 0 };
const worst = [];
for (const f of files) {
  let header, buf;
  try { buf = fs.readFileSync(f); header = C.parseOjnHeader(buf); } catch (e) { continue; }
  const ojmPath = path.join(path.dirname(f), path.basename(f).replace(/\.ojn$/i, '.ojm'));
  if (!fs.existsSync(ojmPath)) { stat.noOjm++; continue; }
  let samples;
  try {
    samples = C.parseOjm(fs.readFileSync(ojmPath), (b) => new TextDecoder('windows-1252').decode(b));
  } catch (e) { stat.noOjm++; continue; }
  if (!samples.size) { stat.noSample++; continue; }
  stat.songs++;
  const u8 = new Uint8Array(buf);
  for (let idx = 0; idx < 3; idx++) {
    if (!header.noteCounts[idx]) continue;
    const evs = C.parseOjnEvents(u8, header.noteOffsets[idx],
      idx < 2 ? header.noteOffsets[idx + 1] : header.coverOffset);
    if (!evs.length) continue;
    const built = C.buildChart(header.bpm, evs, false);
    const used = built.audioObjects.filter(o => samples.has(o.sampleId));
    stat.charts++;
    if (used.length === 1) {
      stat.single++;
      const shift = used[0].time;
      if (shift > 1) {
        stat.singleShifted++;
        const minNote = Math.min(...built.hitObjects.map(h => h.time));
        worst.push({ f: path.basename(f), idx, shift, minNote, oldFirst: minNote - shift,
                     before: built.hitObjects.length });
      }
    } else if (used.length > 1) stat.multi++;
  }
}
worst.sort((a, b) => b.shift - a.shift);
console.log('统计：', JSON.stringify(stat, null, 1));
console.log('\n旧版会被整体提前的难度（按提前量降序，前 12 个）：');
console.log('  文件'.padEnd(16) + '难度   提前(ms)   旧版首note   修正后首note');
for (const w of worst.slice(0, 12)) {
  console.log('  ' + w.f.padEnd(16) + '  ' + ['EX', 'NX', 'HX'][w.idx] + '   ' + String(w.shift.toFixed(0)).padStart(8)
    + '   ' + String(w.oldFirst.toFixed(0)).padStart(10) + '   ' + String(w.minNote).padStart(11)
    + (w.shift > 1000 ? '   ← 提前超过 1 秒' : ''));
}
if (worst.length) {
  const avg = worst.reduce((a, b) => a + b.shift, 0) / worst.length;
  const mx = worst[0];
  console.log('\n受影响难度共 ' + worst.length + ' 个；平均提前 ' + avg.toFixed(0) + 'ms，最大提前 '
    + mx.shift.toFixed(0) + 'ms（' + mx.f + ' ' + ['EX', 'NX', 'HX'][mx.idx] + '）');
  console.log('修正后：musicOffset 恒为 0 → .osu 时间 = 原始谱面时间，与混音音频同一时间轴，不再提前。');
}
