// 扫全库的 OJM 样本：统计容器指纹（OggS / RIFF / 其它）、可疑文件用 ffmpeg 试着解一下，
// 顺便统计「按难度算，有多少个难度的样本全不可解」——那正是“WAV 输出缺音频”的成因。
//   node tools/scan-audio.js [最多扫多少首]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from '../src/index.js';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OJN_ROOT || path.resolve(TOOLS, '..', '..');
const LIMIT = Number(process.argv[2] || 300);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ojn-audio-'));

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/o2jam-to-osu|BmsToOsu|SeriousBeatmapConverter|O2Jam-2-osu|node_modules|Failed/.test(e.name)) walk(p, out); }
    else if (/\.ojn$/i.test(e.name)) out.push(p);
  }
  return out;
}
const magicOf = (u8) => {
  const ascii = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  if (ascii(0, 4) === 'OggS') return 'OggS';
  if (ascii(0, 4) === 'RIFF') return 'RIFF';
  if (ascii(0, 3) === 'ID3') return 'ID3(mp3)';
  if (ascii(0, 4) === 'fLaC') return 'fLaC';
  if (ascii(0, 3) === 'FMT') return 'FMT?';
  return 'other:' + u8.subarray(0, 4).toString('hex');
};

const files = walk(ROOT).slice(0, LIMIT);
const magics = new Map();
const ojmKinds = new Map();
let songs = 0, charts = 0, chartsNoAudio = 0, chartsPartial = 0;
let used0 = 0, used1 = 0, usedFew = 0, usedMany = 0, noEvents = 0;
let shortAudio = 0, veryShortAudio = 0;
const shortList = [];
const badSamples = [];
const songsMissing = [];

for (const f of files) {
  const ojmPath = path.join(path.dirname(f), path.basename(f).replace(/\.ojn$/i, '.ojm'));
  if (!fs.existsSync(ojmPath)) continue;
  const head = fs.readFileSync(ojmPath).subarray(0, 4).toString('hex');
  ojmKinds.set(head, (ojmKinds.get(head) || 0) + 1);
  let samples;
  try { samples = C.parseOjm(fs.readFileSync(ojmPath), (b) => new TextDecoder('windows-1252').decode(b)); }
  catch (e) { continue; }
  songs++;
  const buf = fs.readFileSync(f);
  let header; try { header = C.parseOjnHeader(buf); } catch (e) { continue; }
  const u8 = new Uint8Array(buf);

  // 每个样本的容器指纹
  for (const [id, s] of samples) {
    const m = magicOf(s.bytes);
    magics.set(m, (magics.get(m) || 0) + 1);
    if (!/^(OggS|RIFF|ID3\(mp3\))$/.test(m) && badSamples.length < 12)
      badSamples.push({ file: path.basename(f), id, name: s.name, m, size: s.bytes.length });
  }

  for (let idx = 0; idx < 3; idx++) {
    if (!header.noteCounts[idx]) continue;
    const evs = C.parseOjnEvents(u8, header.noteOffsets[idx], idx < 2 ? header.noteOffsets[idx + 1] : header.coverOffset);
    if (!evs.length) continue;
    const built = C.buildChart(header.bpm, evs, false);
    const used = built.audioObjects.filter(o => samples.has(o.sampleId));
    if (!used.length) {
      used0++;
      continue;                                  // 完全没有可解样本：现在会挂（参考实现直接抛错）
    }
    charts++;
    // 音频能覆盖多长？= 最后一个可解样本的结束时间
    let spanMs = 0;
    for (const u of used) {
      const d = (samples.get(u.sampleId).bytes.length / 16000) * 1000;   // 用体积粗估时长（仅用于统计）
      spanMs = Math.max(spanMs, u.time + d);
    }
    const declaredMs = (header.durations[idx] || 0) * 1000;
    const lastNote = built.hitObjects.reduce((m, h) => Math.max(m, h.time, h.endTime > 0 ? h.endTime : 0), 0);
    const need = Math.max(declaredMs, lastNote + 1500);
    if (used.length === 1) used1++; else if (used.length <= 5) usedFew++; else usedMany++;
    if (need > 0 && spanMs < need * 0.5) {
      shortAudio++;
      if (spanMs < need * 0.15) veryShortAudio++;
      if (shortList.length < 12) shortList.push(path.basename(f) + '#' + ['EX','NX','HX'][idx]
        + ' 可解样本 ' + used.length + ' 个，音频只能到 ' + (spanMs/1000).toFixed(1) + 's，谱面需要 '
        + (need/1000).toFixed(0) + 's（头部声明 ' + (declaredMs/1000).toFixed(0) + 's）');
    }
    const ids = [...new Set(used.map(o => o.sampleId))];
    const ok = ids.filter(id => /^(OggS|RIFF|ID3\(mp3\))$/.test(magicOf(samples.get(id).bytes)));
    if (ok.length === 0) { chartsNoAudio++; if (songsMissing.length < 12) songsMissing.push(path.basename(f) + '#' + ['EX','NX','HX'][idx] + ' (' + ids.length + ' 个样本全是未知容器)'); }
    else if (ok.length < ids.length) chartsPartial++;
  }
}

console.log('扫描 ' + songs + ' 首 / ' + charts + ' 个有音频事件的难度\n');
console.log('OJM 容器分布（前 4 字节 hex）：');
for (const [k, v] of [...ojmKinds].sort((a, b) => b[1] - a[1]))
  console.log('  ' + k + ' → ' + v + ' 首   ' + ({ '4d333000': 'M30', '4f4d4300': 'OMC', '4f4a4d00': 'OJM' }[k] || ''));
console.log('\n样本容器指纹分布：');
for (const [k, v] of [...magics].sort((a, b) => b[1] - a[1])) console.log('  ' + k.padEnd(14) + v);
if (badSamples.length) {
  console.log('\n非标准容器的样本（例）：');
  for (const b of badSamples) console.log('  ' + b.file + ' sampleId=' + b.id + ' "' + b.name + '" ' + b.size + 'B → ' + b.m);
}
console.log('\n按难度统计（样本可解性）：');
console.log('  全部样本都是 OggS/RIFF/MP3：' + (charts - chartsNoAudio - chartsPartial) + ' 个难度');
console.log('  部分样本容器可疑（浏览器可能解不出）：' + chartsPartial + ' 个难度');
console.log('  所有样本容器都可疑 → 混音会失败/无音频：' + chartsNoAudio + ' 个难度');
for (const s of songsMissing) console.log('    ' + s);

console.log('\n【音频内容是否够长】（“WAV 输出缺音频”的直接原因）');
console.log('  完全没有任何可解样本 → 目前会直接报错、连音频都没有：' + used0 + ' 个难度');
console.log('  可解样本数：1 个 = ' + used1 + '，2~5 个 = ' + usedFew + '，>5 个 = ' + usedMany);
console.log('  音频只能盖住谱面不到一半：' + shortAudio + ' 个难度（其中不到 15%：' + veryShortAudio + '）');
for (const s of shortList) console.log('    ' + s);
console.log('\n临时目录：' + TMP);
