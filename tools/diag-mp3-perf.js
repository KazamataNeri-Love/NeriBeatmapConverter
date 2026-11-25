// 严谨一点的 MP3 编码基准：多轮交错 + 取中位数（机器噪声大会让单轮结论乱跳），
// 并拆分出「我的 float→int16 转换」与「lamejs encodeBuffer」各占多少。
//   node tools/diag-mp3-perf.js [轮数，默认 3]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { floatToInt16 } from '../src/core/encoders/pcm.js';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(PROJ, 'vendor/lamejs/lame.min.js'), 'utf8'));
const lamejs = globalThis.lamejs;

const RATE = 44100, SEC = 12, N = RATE * SEC;
const L = new Float32Array(N), R = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const t = i / RATE;
  L[i] = 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.25 * Math.sin(2 * Math.PI * 660 * t) + 0.15 * Math.sin(2 * Math.PI * 1760 * t);
  R[i] = 0.35 * Math.sin(2 * Math.PI * 330 * t) + 0.2 * Math.sin(2 * Math.PI * 990 * t);
}
const ROUNDS = Number(process.argv[2] || 3);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

function encodeOnce(block, kbps) {
  const enc = new lamejs.Mp3Encoder(2, RATE, kbps);
  const l = new Int16Array(block), r = new Int16Array(block);
  let bytes = 0, p = 0;
  const t0 = performance.now();
  while (p < N) {
    const n = Math.min(block, N - p);
    floatToInt16(L, p, n, l);
    floatToInt16(R, p, n, r);
    bytes += enc.encodeBuffer(l.subarray(0, n), r.subarray(0, n)).length;
    p += n;
  }
  bytes += enc.flush().length;
  return performance.now() - t0;
}
/** 只做我的转换（不调 lamejs），看它占多少 */
function convertOnly(block) {
  const l = new Int16Array(block), r = new Int16Array(block);
  let p = 0;
  const t0 = performance.now();
  while (p < N) { const n = Math.min(block, N - p); floatToInt16(L, p, n, l); floatToInt16(R, p, n, r); p += n; }
  return performance.now() - t0;
}

encodeOnce(1152, 320); encodeOnce(1152, 320); convertOnly(1152);   // 预热（让 V8 JIT 完成）

const configs = [];
for (const block of [1152, 11520]) for (const kbps of [128, 320]) configs.push({ block, kbps });
const res = new Map(configs.map(c => [c.block + '/' + c.kbps, []]));
for (let round = 0; round < ROUNDS; round++)
  for (const c of configs) res.get(c.block + '/' + c.kbps).push(encodeOnce(c.block, c.kbps));
const convRuns = [];
for (let i = 0; i < ROUNDS; i++) convRuns.push(convertOnly(11520));

console.log('输入 ' + SEC + ' 秒 44.1kHz 立体声；' + ROUNDS + ' 轮交错，取中位数\n');
console.log('配置        中位耗时    相对实时   4 分钟歌约');
for (const c of configs) {
  const m = median(res.get(c.block + '/' + c.kbps));
  console.log(('块' + c.block + '/' + c.kbps + 'k').padEnd(12)
    + (m.toFixed(0) + 'ms').padStart(10) + (SEC * 1000 / m).toFixed(0).padStart(10) + '×'
    + (m / SEC * 240 / 1000).toFixed(1).padStart(11) + 's');
}
const cv = median(convRuns);
const base320 = median(res.get('1152/320'));
console.log('\n拆分：我的 float→int16 转换中位 ' + cv.toFixed(0) + 'ms，占总体 '
  + (cv / base320 * 100).toFixed(0) + '%；其余是 lamejs');
console.log('\n原始值（看波动范围，判断差异是否只是噪声）：');
for (const c of configs) console.log('  ' + (c.block + '/' + c.kbps).padEnd(12)
  + res.get(c.block + '/' + c.kbps).map(m => m.toFixed(0)).join(', '));
