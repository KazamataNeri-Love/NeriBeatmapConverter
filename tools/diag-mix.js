// 混音质量诊断：用真实 OJM 样本（ffmpeg 解码）+ 真实谱面事件跑一遍混音，回答三件事：
//   1) 峰值 / 削波比例（“兹拉兹拉”的第一嫌疑人）
//   2) 「键音等效求和」（不做声像、不归一化，也就是 osu 播 Sample/hitSample 时的总效果）与我的混音差多少
//   3) 我的 MP3 用 ffmpeg 解回来与源 PCM 的相关性/误差（对照 ffmpeg libmp3lame）
//   node tools/diag-mix.js [ojn相对路径]      DIFF=0|1|2 选难度
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from '../src/index.js';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(TOOLS, '..');
const ROOT = process.env.OJN_ROOT || path.resolve(PROJ, '..');
const RATE = 44100;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ojn-diag-'));

vm.runInThisContext(fs.readFileSync(path.join(PROJ, 'vendor/lamejs/lame.min.js'), 'utf8'));

const rel = process.argv[2] || 'OfficialBeatmaps/o2ma100.ojn';
const ojnPath = path.join(ROOT, rel);
const ojmPath = ojnPath.replace(/\.ojn$/i, '.ojm');
console.log('谱面：', rel);

const buf = fs.readFileSync(ojnPath);
const header = C.parseOjnHeader(buf);
const samples = C.parseOjm(fs.readFileSync(ojmPath), (b) => new TextDecoder('windows-1252').decode(b));
const u8 = new Uint8Array(buf);
const idx = Number(process.env.DIFF ?? 0);
const evs = C.parseOjnEvents(u8, header.noteOffsets[idx], idx < 2 ? header.noteOffsets[idx + 1] : header.coverOffset);
const built = C.buildChart(header.bpm, evs, false);
const used = built.audioObjects.filter(o => samples.has(o.sampleId));
const uniq = [...new Set(used.map(o => o.sampleId))];
console.log('难度 ' + ['EX', 'NX', 'HX'][idx] + '：物件 ' + built.hitObjects.length + '，音频对象 ' + used.length
  + '，唯一样本 ' + uniq.length + '/' + samples.size);

// ---- ffmpeg 解码样本 ----
const cache = new Map();
let failed = 0;
function decodeWithFfmpeg(id) {
  if (cache.has(id)) return cache.get(id);
  const s = samples.get(id);
  const tmp = path.join(TMP, 's' + id + (path.extname(s.name || '') || '.ogg'));
  fs.writeFileSync(tmp, s.bytes);
  try {
    const out = execFileSync('ffmpeg', ['-v', 'error', '-i', tmp, '-f', 's16le', '-acodec', 'pcm_s16le',
      '-ar', String(RATE), '-ac', '2', '-'], { maxBuffer: 512 * 1024 * 1024 });
    const n = Math.floor(out.length / 4);
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = out.readInt16LE(i * 4) / 32768; R[i] = out.readInt16LE(i * 4 + 2) / 32768; }
    const ab = { length: n, numberOfChannels: 2, sampleRate: RATE, duration: n / RATE,
                 getChannelData: (ch) => (ch === 0 ? L : R) };
    cache.set(id, ab);
    return ab;
  } catch (e) {
    failed++;
    console.log('    （样本 ' + id + ' 解码失败：' + String(e.message).split('\n')[0] + '）');
    cache.set(id, null);
    return null;
  }
}
process.stdout.write('解码样本 ');
for (const id of uniq) decodeWithFfmpeg(id);
console.log('完成（失败 ' + failed + ' 个）');

const fakeCtx = { sampleRate: RATE, decodeAudioData: async (arrayBuf) =>
  decodeWithFfmpeg(new DataView(arrayBuf).getInt32(0, true)) };
const samplesForMix = new Map([...samples].map(([id, s]) =>
  [id, { name: s.name, mime: s.mime, bytes: new Uint8Array(new Int32Array([id]).buffer) }]));

// ---- 我的混音（默认 = 归一化开）----
const pcm = await C.mixToPcm(fakeCtx, used, samplesForMix, RATE);
console.log('\n混音长度 ' + (pcm.length / RATE).toFixed(1) + ' 秒（' + pcm.length + ' 帧）');
const peakOf = (L, R) => { let p = 0, over = 0; for (let i = 0; i < L.length; i++) {
  const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > p) p = a; if (b > p) p = b;
  if (a > 1) over++; if (b > 1) over++; } return { p, over }; };

// ---- 键音等效求和：按 osu 播 Samples/hitSample 的方式（增益 1、无声像、不归一化）----
const refL = new Float32Array(pcm.length), refR = new Float32Array(pcm.length);
let refPeak = 0, refOver = 0;
for (const u of used) {
  const ab = cache.get(u.sampleId); if (!ab) continue;
  const start = Math.max(0, Math.round(u.time * RATE / 1000));
  const g = (u.volume === undefined ? 1 : u.volume);
  const ch0 = ab.getChannelData(0), ch1 = ab.numberOfChannels === 1 ? ch0 : ab.getChannelData(1);
  for (let i = 0; i < ab.length; i++) { const f = start + i; if (f >= pcm.length) break; refL[f] += ch0[i] * g; refR[f] += ch1[i] * g; }
}
for (let i = 0; i < refL.length; i++) { const a = Math.abs(refL[i]), b = Math.abs(refR[i]);
  if (a > refPeak) refPeak = a; if (b > refPeak) refPeak = b; if (a > 1) refOver++; if (b > 1) refOver++; }

console.log('\n【削波 / 归一化】');
console.log('  归一化前（= 键音等效求和）峰值 ' + refPeak.toFixed(3) + '（' + (20 * Math.log10(refPeak)).toFixed(1)
  + ' dBFS），超过 1.0 的点 ' + refOver + ' / ' + (refL.length * 2)
  + '（' + (refOver / (refL.length * 2) * 100).toFixed(2) + '%）  ← 不归一化就会硬限幅失真');
console.log('  归一化后峰值 ' + pcm.peak.toFixed(3) + '，应用增益 ' + pcm.gain.toFixed(3)
  + '（' + (20 * Math.log10(pcm.gain)).toFixed(1) + ' dB）');
const norm1 = await C.mixToPcm(fakeCtx, used, samplesForMix, RATE, { normalize: false });
console.log('  normalize:false 时峰值 ' + norm1.peak.toFixed(3) + '（应与键音等效求和一致：'
  + (Math.abs(norm1.peak - refPeak) < 0.01 ? '一致 ✔' : '不一致 ✘ 差 ' + Math.abs(norm1.peak - refPeak).toFixed(3)) + '）');

// ---- 与键音等效求和的差异（归一化前后各比一次）----
const cmp = (a, b, label) => {
  let err = 0, cnt = 0, max = 0, sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]); err += d; cnt++;
    if (d > max) max = d;
    sa += a[i] * a[i]; sb += b[i] * b[i]; sab += a[i] * b[i];
  }
  const corr = sab / Math.sqrt(sa * sb);
  console.log('  ' + label + '：相关系数 ' + corr.toFixed(6) + '，平均差 ' + (err / cnt * 100).toFixed(2)
    + '%FS，最大差 ' + (max * 100).toFixed(1) + '%FS');
};
console.log('\n【我的混音 vs 键音等效求和】（内容是否一致；差异来自声像/音量/归一化）');
cmp(refL, norm1.left, '不归一化·左声道');
cmp(refL, pcm.left, '归一化后·左声道');

// ---- 写文件 + 用 ffmpeg 解码回来对比 ----
const clampRef = (L, R) => { const n = L.length; const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { a[i] = Math.max(-1, Math.min(1, L[i])); b[i] = Math.max(-1, Math.min(1, R[i])); } return { L: a, R: b }; };
const decodeFile = (file) => {
  try {
    const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-acodec', 'pcm_s16le',
      '-ar', String(RATE), '-ac', '2', '-'], { maxBuffer: 512 * 1024 * 1024 });
    const n = Math.floor(out.length / 4);
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = out.readInt16LE(i * 4) / 32768; R[i] = out.readInt16LE(i * 4 + 2) / 32768; }
    return { L, R, n };
  } catch (e) { console.log('    解码失败：' + String(e.message).split('\n')[0]); return { L: new Float32Array(0), R: new Float32Array(0), n: 0 }; }
};
const corrAt = (a, b, off, from, to) => {
  let sa = 0, sb = 0, sab = 0, n = 0;
  for (let i = from; i < to; i++) { const y = b[i + off]; if (y === undefined) break; sa += a[i] * a[i]; sb += y * y; sab += a[i] * y; n++; }
  return (n > 100 && sa > 0 && sb > 0) ? sab / Math.sqrt(sa * sb) : -1;
};
const cmpMp3 = (ref, dec, label) => {
  if (dec.n === 0) { console.log('  ' + label + '：没有解出任何帧 ✘'); return; }
  const from = Math.min(20000, Math.floor(ref.L.length / 4)), to = Math.min(from + 200000, ref.L.length);
  let best = 0, bestC = -Infinity;
  for (let off = -6000; off <= 6000; off += 4) { const c = corrAt(ref.L, dec.L, off, from, to); if (c > bestC) { bestC = c; best = off; } }
  for (let off = best - 4; off <= best + 4; off++) { const c = corrAt(ref.L, dec.L, off, from, to); if (c > bestC) { bestC = c; best = off; } }
  let err = 0, cnt = 0, max = 0;
  for (let i = 0; i < Math.min(ref.L.length, dec.L.length - best); i++) {
    const d = Math.abs(ref.L[i] - dec.L[i + best]); err += d; cnt++; if (d > max) max = d;
  }
  console.log('  ' + label + '：解码 ' + dec.n + ' 帧，对齐 ' + best + ' 帧，相关系数 ' + bestC.toFixed(5)
    + '，平均误差 ' + (err / cnt * 100).toFixed(3) + '%FS，最大 ' + (max * 100).toFixed(1) + '%FS');
};

const written = clampRef(pcm.left, pcm.right);          // 实际写出的 PCM（已归一化，不应有削波）
const mineMp3 = path.join(TMP, 'mine.mp3');
fs.writeFileSync(mineMp3, C.encodeMp3(pcm, { bitrate: 320 }));
const pcmWav = path.join(TMP, 'pcm.wav');
fs.writeFileSync(pcmWav, C.encodeWav({ left: written.L, right: written.R, sampleRate: RATE, length: pcm.length }));
const ffMp3 = path.join(TMP, 'ff.mp3');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', pcmWav, '-c:a', 'libmp3lame', '-b:a', '320k', ffMp3]);
console.log('\n【MP3 编码质量】同一份 PCM（归一化后）：');
console.log('  lamejs@320 ' + (fs.statSync(mineMp3).size / 1048576).toFixed(2) + ' MB ／ ffmpeg libmp3lame@320 '
  + (fs.statSync(ffMp3).size / 1048576).toFixed(2) + ' MB');
cmpMp3(written, decodeFile(mineMp3), 'lamejs 解码回来');
cmpMp3(written, decodeFile(ffMp3), 'ffmpeg 解码回来');

// 削波版（模拟旧行为）也编一份，看失真差多少
const clipOnly = clampRef(norm1.left, norm1.right);
const clipMp3 = path.join(TMP, 'clip.mp3');
fs.writeFileSync(clipMp3, C.encodeMp3({ left: clipOnly.L, right: clipOnly.R, sampleRate: RATE, length: pcm.length }, { bitrate: 320 }));
console.log('\n【旧行为（不归一化，硬限幅）】削波点 ' + norm1.over + ' 个 → 编出的 MP3 与理想信号的差距：');
cmpMp3(clipOnly, decodeFile(clipMp3), '削波版解码回来');

console.log('\n临时文件：' + TMP);
