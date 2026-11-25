// 验证 ffmpeg 音频路径的正确性（三条独立不变量）：
//   A. 解码：WAV 样本用 ffmpeg 解出来的 PCM，必须与纯 JS 手工解析的 PCM 逐样本一致
//   B. 编码：正弦 PCM → ffmpeg MP3 → 再解回，与源波形相关系数必须 ~1
//        （这一条专门盯住“交给 stdin 的缓冲被复用覆写”那类静默损坏）
//   C. 端到端：同一首歌，批量解码路径与逐条解码路径产出的 .osu 文本必须逐字节一致
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseOjnHeader } from '../src/modes/o2jam/ojn.js';
import { parseOjm } from '../src/modes/o2jam/ojm.js';
import { detectEncoding, makeTextDecoder } from '../src/core/text.js';
import { convertOneSong } from '../src/modes/o2jam/pipeline.js';
import { setLogSink } from '../src/core/util.js';
import { createFfmpegAudioContext, encodePcmFfmpeg, findFfmpeg, sniffExt } from './lib/ffmpeg.js';

setLogSink(() => {});                       // 静默：只看结论
let fails = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? '✔' : '✘'} ${label}${extra ? '　' + extra : ''}`);
  if (!ok) fails++;
};
const corr = (a, b) => {
  const n = Math.min(a.length, b.length);
  let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; sab += a[i] * b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; }
  const num = n * sab - sa * sb;
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
  return den === 0 ? 0 : num / den;
};

const FF = (await findFfmpeg()).bin;
const ojnPath = process.argv[2] || '../OfficialBeatmaps/o2ma100.ojn';
const ojmPath = ojnPath.replace(/\.ojn$/i, '.ojm');

/* ---------- A. WAV 解码：ffmpeg vs 纯 JS ----------
   注意要用**样本原生采样率**去解：否则 ffmpeg 会做重采样，两者不可能逐样本相等。
   原生采样率下 aresample 退化成空操作，于是可以严格比对，证明 ffmpeg 没偷偷改增益/格式。 */
function parseWavJs(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, false) !== 0x52494646) return null;
  let p = 12, fmt = null, data = null;
  while (p + 8 <= bytes.length) {
    const id = dv.getUint32(p, false), size = dv.getUint32(p + 4, true);
    if (id === 0x666D7420) fmt = { tag: dv.getUint16(p + 8, true), channels: dv.getUint16(p + 10, true),
                                   rate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
    else if (id === 0x64617461) { data = { off: p + 8, size: Math.min(size, bytes.length - p - 8) }; break; }
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.tag !== 1) return null;
  const bytesPer = fmt.bits / 8, frameBytes = bytesPer * fmt.channels;
  if (bytesPer !== 1 && bytesPer !== 2) return null;               // 只比 8/16bit（24/32 少见到不值得写）
  const read = (off) => bytesPer === 1
    ? (bytes[off] - 128) / 128                                      // 8bit 是无符号偏移 128
    : dv.getInt16(off, true) / 32768;
  const n = Math.floor(data.size / frameBytes);
  const left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = read(data.off + i * frameBytes);
    left[i] = l;
    right[i] = fmt.channels > 1 ? read(data.off + i * frameBytes + bytesPer) : l;
  }
  return { ...fmt, left, right, frames: n };
}

const hdr = parseOjnHeader(fs.readFileSync(ojnPath));
const dec = makeTextDecoder(detectEncoding([hdr.rawTitle, hdr.rawArtist, hdr.rawNoter]).encoding);
const samples = parseOjm(fs.readFileSync(ojmPath), dec);
let wavPick = null;
for (const [id, s] of samples) {
  if (sniffExt(s.bytes, s.mime) !== 'wav' || s.bytes.length < 200) continue;
  const js = parseWavJs(s.bytes);
  if (js && js.frames > 100) { wavPick = { id, s, js }; break; }
}
if (!wavPick) {
  console.log('（这首歌没有可比的 8/16bit PCM WAV 样本，跳过 A）');
} else {
  const { s, js } = wavPick;
  const ctxA = await createFfmpegAudioContext({ sampleRate: js.rate, ffmpeg: FF, cacheMb: 0 });
  const got = (await ctxA.decodeBatch([{ id: 1, bytes: s.bytes, mime: 'audio/wav' }])).get(1);
  ctxA.dispose();
  const n = Math.min(js.frames, got.length);
  let maxErr = 0, bad = 0;
  const gl = got.getChannelData(0), gr = got.getChannelData(1);
  for (let i = 0; i < n; i++) {
    for (const [a, b] of [[js.left[i], gl[i]], [js.right[i], gr[i]]]) {
      const e = Math.abs(a - b);
      if (e > maxErr) maxErr = e;
      if (e > 1e-6) bad++;
    }
  }
  check(bad === 0, `A. WAV 解码与纯 JS 严格一致（${n} 帧，${s.name}，${js.bits}bit ${js.channels}ch ${js.rate}Hz）`,
    `最大误差 ${maxErr.toExponential(2)}，${bad} 个样本不符`);
}

/* ---------- B. MP3 编码：编回来相关系数 ---------- */
{
  const R = 44100, frames = R * 20;                      // 20 秒足够暴露缓冲覆写
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = Math.sin(2 * Math.PI * 440 * i / R) * 0.4;
    right[i] = Math.sin(2 * Math.PI * 660 * i / R) * 0.35 + Math.sin(2 * Math.PI * 137 * i / R) * 0.2;
  }
  const mp3 = await encodePcmFfmpeg({ left, right, length: frames, sampleRate: R }, { format: 'mp3', bitrate: 320, ffmpeg: FF });
  const tmp = path.join(os.tmpdir(), `verify-${process.pid}.mp3`);
  const rawOut = tmp + '.raw';
  fs.writeFileSync(tmp, mp3);
  await new Promise((res, rej) => execFile(FF, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', tmp,
    '-f', 'f32le', '-ac', '2', '-ar', String(R), rawOut], (e) => (e ? rej(e) : res())));
  const raw = fs.readFileSync(rawOut);
  const back = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  const n = Math.floor(back.length / 2);
  const bl = new Float32Array(n), br = new Float32Array(n);
  for (let i = 0; i < n; i++) { bl[i] = back[i * 2]; br[i] = back[i * 2 + 1]; }
  const cL = corr(left.subarray(0, n), bl), cR = corr(right.subarray(0, n), br);
  check(cL > 0.99 && cR > 0.99, 'B. ffmpeg MP3 编解码往返（缓冲覆写检测）',
    `${(mp3.length / 1048576).toFixed(1)} MB，相关系数 L=${cL.toFixed(5)} R=${cR.toFixed(5)}`);
  fs.unlinkSync(tmp); fs.unlinkSync(rawOut);
}

/* ---------- C. 端到端：批量解码 vs 逐条解码 → .osu 文本一致 ---------- */
{
  const ojnBuf = fs.readFileSync(ojnPath);
  const mk = (ctx) => ({
    ojnFile: { name: path.basename(ojnPath), arrayBuffer: async () => ojnBuf.buffer.slice(ojnBuf.byteOffset, ojnBuf.byteOffset + ojnBuf.length) },
    ojmFile: { name: path.basename(ojmPath) }, decode: dec, samples,
  });
  const opts = { diffs: [0, 1, 2], od: NaN, hp: 8.2, serverTag: '', useSV: false, audioMode: 'shared',
    audioFormat: 'wav', mp3Kbps: 320, normalize: true, sampleRate: 44100, suffixMode: 'auto',
    tagMode: 'keep', tagTemplate: '', autoRepair: true, sampleFallback: true, lnMaxBeats: 0 };
  const batchCtx = await createFfmpegAudioContext({ sampleRate: 44100, ffmpeg: FF, cacheMb: 0 });
  const singleCtx = await createFfmpegAudioContext({ sampleRate: 44100, ffmpeg: FF, cacheMb: 0 });
  delete singleCtx.decodeBatch;                          // 强制走逐条 decodeAudioData 分支
  const a = await convertOneSong(mk(batchCtx), opts, batchCtx, null);
  const b = await convertOneSong(mk(singleCtx), opts, singleCtx, null);
  batchCtx.dispose(); singleCtx.dispose();
  const osuOf = (r) => r.files.filter(f => /\.osu$/.test(f.name)).map(f => f.name + '\n' + new TextDecoder().decode(f.data)).join('\n@@\n');
  const wavOf = (r) => r.files.filter(f => /\.wav$/.test(f.name)).map(f => f.data);
  const ta = osuOf(a), tb = osuOf(b);
  const wa = wavOf(a), wb = wavOf(b);
  check(ta === tb, 'C. 批量解码与逐条解码的 .osu 完全一致', `${a.files.length} 个产出文件`);
  let worst = 0, nDif = 0;
  if (wa.length && wb.length && wa[0].length === wb[0].length) {
    for (let i = 0; i < wa[0].length; i += 2) {           // 抽样比对音频（f32 每 2 字节看一次即可）
      const x = wa[0][i] - wb[0][i];
      if (x !== 0) { nDif++; if (Math.abs(x) > worst) worst = Math.abs(x); }
    }
  }
  check(nDif === 0, 'C. 批量解码与逐条解码的音频 PCM 完全一致', `${wa.length ? wa[0].length + ' 字节' : '无音频'}，${nDif} 处差异（最大 ${worst}）`);
}

console.log(fails ? `\n${fails} 项未通过` : '\n全部通过');
process.exitCode = fails ? 1 : 0;
