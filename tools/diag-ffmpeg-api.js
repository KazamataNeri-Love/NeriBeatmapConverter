// 端到端验证「浏览器 → 本地 ffmpeg」这条路：
//   1. /api/ffmpeg 能探到
//   2. 按浏览器的方式 POST（左声道字节 ‖ 右声道字节）→ 拿到 MP3
//   3. 拿回来的 MP3 用 ffmpeg 解回来，与源正弦相关系数必须 ~1（证明没传错、没被污染）
//   4. 与内置 lamejs 的结果做体积对比
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeMp3 } from '../src/core/encoders/mp3.js';
import { findFfmpeg } from './lib/ffmpeg.js';

// lamejs 在浏览器里是 <script> 加载的，Node 里用 vm 载入同一份 vendor 文件（与测试套件一致）
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(PROJ, 'vendor/lamejs/lame.min.js'), 'utf8'));

const base = process.argv[2] || 'http://localhost:5183';
const FF = (await findFfmpeg()).bin;
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) fails++; };
const corr = (a, b) => {
  const n = Math.min(a.length, b.length);
  let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; sab += a[i] * b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; }
  return (n * sab - sa * sb) / Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
};

// ---- 1. 探测 ----
const t0 = Date.now();
const st = await (await fetch(base + '/api/ffmpeg')).json();
check(st.available === true, `/api/ffmpeg 报告可用（${st.version ? st.version.slice(0, 28) : ''}，${(st.encoders || []).join('/')}）`);
check(Array.isArray(st.encoders) && st.encoders.includes('libmp3lame'), '清单里有 libmp3lame');

// ---- 2. 造一段 PCM，按浏览器的方式上传 ----
const R = 44100, SEC = Number(process.argv[3]) || 30, frames = R * SEC;
const left = new Float32Array(frames), right = new Float32Array(frames);
for (let i = 0; i < frames; i++) {
  left[i] = Math.sin(2 * Math.PI * 440 * i / R) * 0.4;
  right[i] = Math.sin(2 * Math.PI * 660 * i / R) * 0.3 + Math.sin(2 * Math.PI * 97 * i / R) * 0.2;
}
const body = new Uint8Array(frames * 8);
body.set(new Uint8Array(left.buffer, left.byteOffset, frames * 4), 0);
body.set(new Uint8Array(right.buffer, right.byteOffset, frames * 4), frames * 4);

const t1 = Date.now();
const r = await fetch(base + '/api/encode?format=mp3&bitrate=320&rate=' + R, { method: 'POST', body });
check(r.ok, `/api/encode 返回 200（${r.status}，X-Encode-Ms=${r.headers.get('x-encode-ms')}）`);
const mp3 = new Uint8Array(await r.arrayBuffer());
const ms = Date.now() - t1;
check(mp3.length > 100000, `拿到 MP3 ${(mp3.length / 1048576).toFixed(2)} MB，${ms}ms（${SEC / (ms / 1000)}× 实时）`);

// ---- 3. 解回来比相关系数 ----
const tmpMp3 = path.join(os.tmpdir(), `ver-${process.pid}.mp3`);
const tmpRaw = tmpMp3 + '.raw';
fs.writeFileSync(tmpMp3, mp3);
await new Promise((res, rej) => execFile(FF, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', tmpMp3,
  '-f', 'f32le', '-ac', '2', '-ar', String(R), tmpRaw], (e) => (e ? rej(e) : res())));
const raw = fs.readFileSync(tmpRaw);
const back = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
const n = Math.floor(back.length / 2);
const bl = new Float32Array(n), br = new Float32Array(n);
for (let i = 0; i < n; i++) { bl[i] = back[i * 2]; br[i] = back[i * 2 + 1]; }
const cL = corr(left.subarray(0, n), bl), cR = corr(right.subarray(0, n), br);
check(cL > 0.99 && cR > 0.99, `左右声道相关系数 L=${cL.toFixed(5)} R=${cR.toFixed(5)}（声道没串、字节没传错）`);
fs.unlinkSync(tmpMp3); fs.unlinkSync(tmpRaw);

// ---- 4. 与 lamejs 对比 ----
const t2 = Date.now();
const lame = encodeMp3({ left, right, length: frames, sampleRate: R }, { bitrate: 320 });
const lameMs = Date.now() - t2;
check(lame.length > 0, `内置 lamejs 同样输入：${(lame.length / 1048576).toFixed(2)} MB，${lameMs}ms（${(lameMs / ms).toFixed(0)}× 慢）`);
console.log(`\n本地上传+编码共 ${ms}ms，lamejs ${lameMs}ms → 网页端快 ${(lameMs / ms).toFixed(1)} 倍`);

// ---- 5. 错误处理 ----
const bad = await fetch(base + '/api/encode?format=flac', { method: 'POST', body: new Uint8Array(8) });
check(bad.status === 400, `不支持的格式被拒绝（${bad.status}）`);
const odd = await fetch(base + '/api/encode?format=mp3', { method: 'POST', body: new Uint8Array(10) });
check(odd.status === 400, `长度不是 8 的倍数被拒绝（${odd.status}）`);
const getEnc = await fetch(base + '/api/encode');
check(getEnc.status === 405, `GET /api/encode 被拒绝（${getEnc.status}）`);

console.log(fails ? `\n${fails} 项未通过` : '\n全部通过');
process.exitCode = fails ? 1 : 0;
