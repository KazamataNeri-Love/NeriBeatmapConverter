// 性能诊断：分阶段计时，并量化“补静音到谱面长度”让音频总时长涨了多少。
//   node tools/diag-perf.js [ojn相对路径 ...]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from '../src/index.js';
import { sampleDurationMs } from '../src/core/sampledur.js';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.OJN_ROOT || path.resolve(PROJ, '..');
vm.runInThisContext(fs.readFileSync(path.join(PROJ, 'vendor/lamejs/lame.min.js'), 'utf8'));
const RATE = 44100;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-'));

const heap = () => (process.memoryUsage().heapUsed / 1048576).toFixed(0) + 'MB';
const ms = (t) => (performance.now() - t).toFixed(0) + 'ms';
async function time(label, fn) { const t = performance.now(); const r = await fn(); console.log('    ' + label.padEnd(26) + ms(t)); return r; }

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : ['OfficialBeatmaps/o2ma100.ojn', 'OfficialBeatmaps/o2ma2712.ojn', 'OfficialBeatmaps/o2ma2517.ojn'];

for (const rel of files) {
  const ojnPath = path.join(ROOT, rel);
  const ojmPath = ojnPath.replace(/\.ojn$/i, '.ojm');
  if (!fs.existsSync(ojmPath)) { console.log('跳过（缺 OJM）：' + rel); continue; }
  console.log('── ' + path.basename(rel) + '  （堆 ' + heap() + '）');

  let header, samples, ojnBuf;
  await time('读文件 + 解析头', async () => {
    ojnBuf = fs.readFileSync(ojnPath);
    header = C.parseOjnHeader(ojnBuf);
    samples = C.parseOjm(fs.readFileSync(ojmPath), (b) => new TextDecoder('windows-1252').decode(b));
  });
  console.log('     OJM ' + samples.size + ' 个样本，'
    + (fs.statSync(ojmPath).size / 1048576).toFixed(1) + 'MB；三个难度音符数 ' + JSON.stringify(header.noteCounts));

  const idx = C.buildSampleIndex(samples);
  await time('buildSampleNames', () => C.buildSampleNames(samples));
  await time('buildSampleIndex', () => C.buildSampleIndex(samples));
  await time('样本时长解析（全部样本）', () => { for (const [, s] of samples) sampleDurationMs(s.bytes); });

  // 用 ffmpeg 冒充解码（只对真正用到的样本，且缓存）
  const cache = new Map();
  const decodeId = (id) => {
    if (cache.has(id)) return cache.get(id);
    const s = samples.get(id);
    const tmp = path.join(TMP, 's' + id + (path.extname(s.name || '') || '.ogg'));
    fs.writeFileSync(tmp, s.bytes);
    try {
      const out = execFileSync('ffmpeg', ['-v', 'error', '-i', tmp, '-f', 's16le', '-acodec', 'pcm_s16le',
        '-ar', String(RATE), '-ac', '2', '-'], { maxBuffer: 256 * 1024 * 1024 });
      const n = Math.floor(out.length / 4);
      const L = new Float32Array(n), R = new Float32Array(n);
      for (let i = 0; i < n; i++) { L[i] = out.readInt16LE(i * 4) / 32768; R[i] = out.readInt16LE(i * 4 + 2) / 32768; }
      const ab = { length: n, numberOfChannels: 2, sampleRate: RATE, duration: n / RATE, getChannelData: (c) => (c === 0 ? L : R) };
      cache.set(id, ab); return ab;
    } catch (e) { cache.set(id, null); return null; }
  };
  const ctx = { sampleRate: RATE, decodeAudioData: async (ab) => decodeId(new DataView(ab).getInt32(0, true)) };
  const samplesForMix = new Map([...samples].map(([id, s]) =>
    [id, { name: s.name, mime: s.mime, bytes: new Uint8Array(new Int32Array([id]).buffer) }]));

  const u8 = new Uint8Array(ojnBuf);
  const d0 = 2;   // 用 HX（音符最多）
  let evs, built;
  await time('parseOjnEvents(HX)', () => { evs = C.parseOjnEvents(u8, header.noteOffsets[d0], header.coverOffset); });
  await time('buildChart(HX)', () => { built = C.buildChart(header.bpm, evs, false); });
  const used = built.audioObjects.filter(o => samples.has(o.sampleId));
  console.log('     物件 ' + built.hitObjects.length + '，音频对象 ' + built.audioObjects.length
    + '（可播 ' + used.length + '），唯一样本 ' + new Set(used.map(o => o.sampleId)).size);

  const lastObj = built.hitObjects.reduce((m, h) => Math.max(m, h.time, h.endTime > 0 ? h.endTime : 0), 0);
  const needMs = Math.max((header.durations[d0] || 0) * 1000, lastObj + 1500);
  let pcmNoPad, pcmPad;
  await time('mixToPcm（不补静音）', async () => { pcmNoPad = await C.mixToPcm(ctx, used, samplesForMix, RATE, { normalize: true }); });
  const cache2 = new Map();
  await time('mixToPcm（补到谱面长度）', async () => {
    pcmPad = await C.mixToPcm(ctx, used, samplesForMix, RATE, { normalize: true, minDurationMs: needMs, decodeCache: cache2 });
  });
  const secNoPad = pcmNoPad.length / RATE, secPad = pcmPad.length / RATE;
  console.log('     音频时长：不补 ' + secNoPad.toFixed(1) + 's → 补 ' + secPad.toFixed(1) + 's'
    + '（谱面需要 ' + (needMs / 1000).toFixed(0) + 's，膨胀 ' + ((secPad / secNoPad - 1) * 100).toFixed(0) + '%）');

  await time('encodeWav（补后）', () => C.encodeWav(pcmPad));
  await time('encodeMp3@320（补后）', () => C.encodeMp3(pcmPad, { bitrate: 320 }));
  console.log('');
}
