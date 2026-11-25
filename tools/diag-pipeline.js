// 用真实文件跑完整转换管线（convertOneSong），把浏览器里才会出的问题在 Node 里复现出来。
// 音频解码用系统 ffmpeg 冒充 AudioContext.decodeAudioData（与 diag-mix.js 同一套做法）。
//   node tools/diag-pipeline.js OfficialBeatmaps/o2ma3991.ojn [wav|mp3|keysound|none]
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ojn-pipe-'));
vm.runInThisContext(fs.readFileSync(path.join(PROJ, 'vendor/lamejs/lame.min.js'), 'utf8'));

const rel = process.argv[2] || 'OfficialBeatmaps/o2ma3991.ojn';
const mode = process.argv[3] || 'wav';          // wav | mp3 | keysound | none | shared
const noSamples = process.argv.includes('--no-samples');   // 模拟 OJM 缺失/解析失败
const ojnPath = path.join(ROOT, rel);
const ojmPath = ojnPath.replace(/\.ojn$/i, '.ojm');

const ojnBuf = fs.readFileSync(ojnPath);
const header = C.parseOjnHeader(ojnBuf);
const decodeText = C.makeTextDecoder(C.detectEncoding([header.rawTitle, header.rawArtist, header.rawNoter]).encoding);
const samples = noSamples ? new Map()
  : C.parseOjm(fs.readFileSync(ojmPath), (b) => new TextDecoder('windows-1252').decode(b));
console.log('谱面 ' + rel + '　模式 ' + mode + (noSamples ? '　【模拟 OJM 不可用】' : ''));
console.log('  OJM 样本 ' + samples.size + ' 个' + (noSamples ? '' : '，' + (fs.statSync(ojmPath).size / 1048576).toFixed(1) + ' MB'));

// ffmpeg 解码缓存（同一份样本跨难度复用）
const cache = new Map();
let decFail = 0;
function decodeId(id) {
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
  } catch (e) { decFail++; cache.set(id, null); return null; }
}
const fakeCtx = { sampleRate: RATE, decodeAudioData: async (arrayBuf) => decodeId(new DataView(arrayBuf).getInt32(0, true)) };
// 冒充样本：前 4 字节塞 sampleId
const samplesForMix = new Map([...samples].map(([id, s]) =>
  [id, { name: s.name, mime: s.mime, bytes: new Uint8Array(new Int32Array([id]).buffer) }]));

const song = {
  ojnFile: { name: path.basename(ojnPath), arrayBuffer: async () => ojnBuf.buffer.slice(ojnBuf.byteOffset, ojnBuf.byteOffset + ojnBuf.length) },
  ojmFile: { name: path.basename(ojmPath) },
  decode: decodeText,
  samples: samplesForMix,
};

const opts = {
  diffs: [0, 1, 2], od: NaN, hp: 8.2, serverTag: '', useSV: false, autoRepair: true, lnMaxBeats: 0,
  audioMode: (mode === 'keysound') ? 'keysound' : (mode === 'shared' ? 'shared' : (mode === 'none' ? 'none' : 'per-diff')),
  audioFormat: mode === 'mp3' ? 'mp3' : 'wav', mp3Kbps: 320, sampleRate: RATE, normalize: true,
  suffixMode: 'auto', zipPerSong: true, tagMode: 'keep', tagTemplate: '',
};

const t0 = Date.now();
const res = await C.convertOneSong(song, opts, fakeCtx, null);
console.log('\n耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒；解不开的样本 ' + decFail + ' 个');
console.log('\n产出文件：');
let audio = 0;
for (const f of res.files) {
  const isAudio = /\.(wav|mp3|ogg)$/i.test(f.name);
  if (isAudio) audio++;
  console.log('  ' + (isAudio ? '♪ ' : '  ') + f.name.padEnd(64) + (f.data.length / 1048576).toFixed(2) + ' MB');
}
console.log('\n警告（' + res.warnings.length + '）：');
for (const w of res.warnings) console.log('  ⚠ ' + w);
const osuCount = res.files.filter(f => /\.osu$/i.test(f.name)).length;
console.log('\n.osu ' + osuCount + ' 个，音频 ' + audio + ' 个 → ' + (audio >= osuCount ? '每个难度都有音频 ✔' : '有难度缺音频 ✘'));
// 关键校验：.osu 里写的 AudioFilename 必须真的在产出里（否则 .osz 打开就是“没有音频”）
for (const f of res.files.filter(x => /\.osu$/i.test(x.name))) {
  const text = new TextDecoder().decode(f.data);
  const m = /^AudioFilename: (.+)$/m.exec(text);
  const want = m ? m[1].trim() : '';
  if (!want) { console.log('  ' + f.name + '：没有 AudioFilename（合法，仅限没有 BGM 的情况）'); continue; }
  const ok = res.files.some(x => x.name === want);
  console.log('  ' + f.name + ' → AudioFilename ' + JSON.stringify(want) + (ok ? ' 存在 ✔' : ' 不存在 ✘（.osz 里会缺音频！）'));
}
if (res.preview) {
  const head = res.preview.text.split('\n').filter(l => /^(AudioFilename|Version|Tags):/.test(l));
  console.log('\n' + res.preview.name + ' 头部：');
  for (const l of head) console.log('  ' + l);
}
console.log('\n临时目录：' + TMP);
