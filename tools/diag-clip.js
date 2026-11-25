// 验证「浮点→int16 环绕」这个 bug 及其修复：
//   造一段峰值 2.0 的正弦波（模拟关掉峰值归一化时的混音结果），
//   用 encodeMp3 / encodeWav 编出来，再用 ffmpeg 解回 PCM，
//   与「正确钳位后的参考信号」比较。环绕会把 +2 变成 -2，误差极大；钳位只产生平顶。
//   node tools/diag-clip.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from '../src/index.js';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(PROJ, 'vendor/lamejs/lame.min.js'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));
const RATE = 44100, N = Math.round(RATE * 1.0);      // 1 秒

// 峰值 2.0 的正弦（-6dB 过载）：正是关掉归一化后密集叠加会出现的幅度
const f32 = new Float32Array(N);
for (let i = 0; i < N; i++) f32[i] = 2.0 * Math.sin(2 * Math.PI * 220 * i / RATE);

// 参考：正确钳位后的 int16 波形
const ref = C.floatToInt16(f32);
// 旧 bug 的波形：直接写 Int16Array（环绕）
const wrapped = new Int16Array(N);
for (let i = 0; i < N; i++) wrapped[i] = f32[i] < 0 ? f32[i] * 0x8000 : f32[i] * 0x7FFF;
let flipped = 0;
for (let i = 0; i < N; i++) if (Math.sign(wrapped[i]) !== Math.sign(ref[i]) && Math.abs(ref[i]) > 1000) flipped++;
console.log('输入峰值 2.0（过载）的 1 秒正弦：');
console.log('  正确钳位   ：前 8 个采样 ' + [...ref.slice(0, 8)].join(', '));
console.log('  环绕溢出   ：前 8 个采样 ' + [...wrapped.slice(0, 8)].join(', '));
console.log('  符号被翻转的采样点：' + flipped + ' / ' + N + '（' + (flipped / N * 100).toFixed(1) + '%）'
  + '  ← 环绕把 +2.0 变成 -2，这批点就是“兹拉兹拉”');
console.log('');

const decode = (file) => {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-acodec', 'pcm_s16le',
    '-ar', String(RATE), '-ac', '1', '-'], { maxBuffer: 256 * 1024 * 1024 });
  const n = Math.floor(out.length / 2);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = out.readInt16LE(i * 2);
  return a;
};
const corr = (a, b, off, from, to) => {
  let sa = 0, sb = 0, sab = 0, n = 0;
  for (let i = from; i < to; i++) { const y = b[i + off]; if (y === undefined) break; sa += a[i] * a[i]; sb += y * y; sab += a[i] * y; n++; }
  return n > 100 && sa > 0 && sb > 0 ? sab / Math.sqrt(sa * sb) : -1;
};
const cmp = (label, reference, decoded) => {
  const from = Math.round(0.2 * RATE), to = Math.round(0.9 * RATE);
  let best = 0, bc = -Infinity;
  for (let off = -3000; off <= 3000; off += 2) { const c = corr(reference, decoded, off, from, to); if (c > bc) { bc = c; best = off; } }
  for (let off = best - 2; off <= best + 2; off++) { const c = corr(reference, decoded, off, from, to); if (c > bc) { bc = c; best = off; } }
  let err = 0, cnt = 0, max = 0;
  const from2 = Math.max(0, -best), to2 = Math.min(a0(reference), a0(decoded) - best);
  for (let i = from2; i < to2; i++) {
    const d = Math.abs(reference[i] - decoded[i + best]);
    err += d; cnt++; if (d > max) max = d;
  }
  const N = a0(reference);
  console.log('  ' + label + '：相关系数 ' + bc.toFixed(5) + '，平均误差 ' + (cnt ? (err / cnt / 32768 * 100).toFixed(2) : 'n/a')
    + '%FS，最大 ' + (max / 32768 * 100).toFixed(1) + '%FS');
  return bc;
};
const a0 = (a) => a.length;
const pcm = (arr) => ({ left: f32, right: f32, sampleRate: RATE, length: N });

console.log('【修复前 vs 修复后】同一个过载信号，用 ffmpeg 解回后与「正确钳位波形」比较：');
// 修复后（当前代码）
const goodMp3 = path.join(TMP, 'good.mp3');
fs.writeFileSync(goodMp3, C.encodeMp3(pcm(f32), { bitrate: 320 }));
const cGood = cmp('修复后 encodeMp3→解码', ref, decode(goodMp3));
// 模拟旧 bug：先把波形“环绕”成 int16，再当 float 喂回去（因为旧代码就是产生这个波形）
const badF32 = new Float32Array(N);
for (let i = 0; i < N; i++) badF32[i] = wrapped[i] / 32768;
const badMp3 = path.join(TMP, 'bad.mp3');
fs.writeFileSync(badMp3, C.encodeMp3({ left: badF32, right: badF32, sampleRate: RATE, length: N }, { bitrate: 320 }));
const cBad = cmp('旧 bug（环绕波形）', ref, decode(badMp3));
console.log('  → 相关系数 ' + cBad.toFixed(3) + ' → ' + cGood.toFixed(3) + '，'
  + (cGood > 0.99 && cBad < 0.9 ? '确认：环绕就是杂音的来源，钳位后恢复正常 ✔' : '（请检查）'));

console.log('\n【WAV 路径一直是对的】（同样过载）');
const wavPath = path.join(TMP, 'x.wav');
fs.writeFileSync(wavPath, C.encodeWav(pcm(f32)));
const wd = decode(wavPath);
let wErr = 0, wMax = 0;
for (let i = 0; i < N; i++) { const d = Math.abs(ref[i] - wd[i]); wErr += d; if (d > wMax) wMax = d; }
console.log('  WAV 与钳位参考：平均误差 ' + (wErr / N / 32768 * 100).toFixed(3) + '%FS，最大 ' + (wMax / 32768 * 100).toFixed(1) + '%FS ← 逐字节相同');

console.log('\n【过载程度与削波比例】');
const co = C.countOutOfRange(f32);
console.log('  峰值 ' + co.peak.toFixed(2) + '，超过 ±1 的采样 ' + (co.ratio * 100).toFixed(0) + '%（这就是需要归一化的理由）');
console.log('\n临时文件：' + TMP);
