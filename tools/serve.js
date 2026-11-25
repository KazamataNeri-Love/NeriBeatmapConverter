// 零依赖静态服务器：ES 模块必须经 http 加载（file:// 会被 CORS 拦）。
//   npm start            → http://localhost:5173/
//   PORT=8080 npm start  → 换端口
//   NO_FFMPEG_API=1      → 关掉下面的 ffmpeg 接口（用来测“退回 lamejs”那条路）
//
// 另外提供两个本地 API，让**浏览器里的页面也能用系统 ffmpeg**：
//   GET  /api/ffmpeg    → 是否可用 + 版本 + 编码器清单
//   POST /api/encode?format=mp3&bitrate=320&rate=44100
//        请求体 = 左声道 f32le 字节 ‖ 右声道 f32le 字节（**不交织**：省掉浏览器里那圈逐样本循环）
//        响应体 = 音频字节
// 这样网页端不必为了 MP3 去下 32MB 的 ffmpeg.wasm，速度直接等于命令行（libmp3lame ~120× 实时）。
// 没跑这个服务器（比如用 Live Server 打开）时，页面会自动退回内置的 lamejs。
// 以后要接 ffmpeg.wasm 的多线程内核时，把下面两组 COOP/COEP 头打开即可（用环境变量控制）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFfmpeg, hasEncoder, encodePcmFfmpeg } from './lib/ffmpeg.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* PORT=0 表示“让系统随机分配端口”（测试就这么用，免得和正在跑的开发服务器抢）。
   ★ 不能写成 `Number(process.env.PORT) || 5173` —— 0 是 falsy，会被悄悄换成 5173，
   于是测试去抢正式端口并报 EADDRINUSE（真踩过）。 */
const PORT = (process.env.PORT === undefined || process.env.PORT === '') ? 5173 : Number(process.env.PORT);
const COI = process.env.CROSS_ORIGIN_ISOLATION === '1';   // 给 ffmpeg.wasm(mt) 预留
const NO_API = process.env.NO_FFMPEG_API === '1';
const API_MAX_BYTES = 512 * 1024 * 1024;                  // 4 分钟的 f32 立体声约 84MB，给足余量

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

/* ---------------------------------------------------------------- ffmpeg 探测 */

let ffState = { done: false, available: false, version: null, encoders: [], error: null };
let ffPromise = null;

/* ★ 缓存的是 Promise 而不是“已完成”标志：探测要启动 ffmpeg 进程、要几百毫秒，
   如果一开始就把 done 置真，那么启动瞬间到达的请求会读到「还没探测完」的空状态
   并被当成“不可用”永久缓存 —— 网页刚打开就撞上这个竞态，之后一直退回 lamejs。 */
function ffmpegStatus(){
  if(!ffPromise) ffPromise = detectFfmpeg();
  return ffPromise;
}

async function detectFfmpeg(){
  ffState = { done: true, available: false, version: null, encoders: [], error: null };
  if(NO_API){ ffState.error = '服务端以 NO_FFMPEG_API=1 启动，本地 ffmpeg 接口已关闭'; return ffState; }
  try {
    const info = await findFfmpeg();
    ffState.version = info.version;
    ffState.ffmpeg = info.bin;
    for(const name of ['libmp3lame', 'libvorbis'])
      if(await hasEncoder(info.bin, name)) ffState.encoders.push(name);
    ffState.available = ffState.encoders.includes('libmp3lame');   // 没有 lame 就没意义（MP3 是主格式）
    if(!ffState.available) ffState.error = '这个 ffmpeg 没带 libmp3lame';
  } catch (e) {
    ffState.error = e.message;
  }
  return ffState;
}

/* ---------------------------------------------------------------- 小工具 */

function json(res, code, obj){
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length,
                        'Connection': 'close' });
  res.end(b);
}

function readBody(req, max = API_MAX_BYTES){
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if(n > max){ reject(new Error('请求体过大（' + n + ' 字节）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* 同时只放 4 个 ffmpeg 进程：网页端一次转一首，但三难度共享模式下仍可能并发，别让它无限堆积 */
let running = 0;
const waiting = [];
async function withSlot(fn){
  if(running >= 4) await new Promise(r => waiting.push(r));
  running++;
  try { return await fn(); }
  finally { running--; const nx = waiting.shift(); if(nx) nx(); }
}

async function handleApi(req, res, urlPath, query){
  if(urlPath === '/api/ffmpeg'){
    const s = await ffmpegStatus();
    json(res, 200, { available: s.available, version: s.version, encoders: s.encoders, error: s.error });
    return;
  }
  /* POST /api/encode：请求体是「左声道字节 ‖ 右声道字节」，
     这样浏览器不用为了交织再跑一遍逐样本循环（那对 4 分钟的歌是几百万次赋值）。 */
  if(req.method !== 'POST'){ json(res, 405, { error: '只能用 POST' }); return; }
  const t0 = Date.now();
  try {
    const st = await ffmpegStatus();
    /* ★ 先把请求体读完再校验参数，否则拒绝时连接里会剩下没读的数据 ——
       keep-alive 复用同一连接的下一个请求就会被这些残留字节污染（实测会变成 ECONNRESET，
       而浏览器的 POST 不会被自动重试，用户看到的就是随机失败）。 */
    const body = await readBody(req);
    if(!st.available) throw new Error('服务端 ffmpeg 不可用：' + (st.error || '未知原因'));
    const format = (query.get('format') || 'mp3').toLowerCase();
    const bitrate = Number(query.get('bitrate') || 320);
    const rate = Number(query.get('rate') || 44100);
    if(!['mp3', 'ogg'].includes(format)) throw new Error('不支持的格式：' + format);
    if(!(rate >= 8000 && rate <= 192000)) throw new Error('采样率不合理：' + rate);
    if(body.length < 8 || body.length % 8 !== 0)
      throw new Error('请求体长度不对（应为两个声道各 f32le，总长是 8 的倍数）：' + body.length);
    const half = body.length / 2;
    const frames = half / 4;
    /* 直接建 Float32Array 视图（byteOffset 是 0 / half，都是 4 的倍数）→ 不拷贝。
       注意 encodePcmFfmpeg 会分块写 stdin，而这些字节在本请求结束前一直有效，所以视图是安全的。 */
    const pcm = { left: new Float32Array(body.buffer, body.byteOffset, frames),
                  right: new Float32Array(body.buffer, body.byteOffset + half, frames),
                  length: frames, sampleRate: rate };
    const bytes = await withSlot(() => encodePcmFfmpeg(pcm, { format, bitrate, ffmpeg: st.ffmpeg }));
    console.log(`  /api/encode ${format}${format === 'mp3' ? '@' + bitrate + 'k' : ''} `
      + `${(frames / rate).toFixed(1)}s → ${(bytes.length / 1048576).toFixed(1)}MB，${Date.now() - t0}ms`);
    res.writeHead(200, {
      'Content-Type': format === 'mp3' ? 'audio/mpeg' : 'audio/ogg',
      'Content-Length': bytes.length,
      'X-Encode-Ms': String(Date.now() - t0),
      'Connection': 'close',   // 编码是大块传输，不复用连接最稳（反正一次转换就几个请求）
    });
    res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  } catch (e) {
    console.log('  /api/encode 失败：' + e.message);
    json(res, 400, { error: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  const [rawPath, rawQuery] = (req.url || '/').split('?');
  const urlPath = decodeURIComponent(rawPath);

  if(urlPath === '/api/ffmpeg' || urlPath === '/api/encode'){
    try { await handleApi(req, res, urlPath, new URLSearchParams(rawQuery || '')); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  const target = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!target.startsWith(ROOT)) { res.writeHead(403).end('403'); return; }   // 防目录穿越
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + urlPath); return; }
    const headers = {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    };
    if (COI) {   // ffmpeg.wasm 多线程内核需要跨源隔离
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    }
    res.writeHead(200, headers);
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, () => {
  const actual = server.address().port;          // PORT=0 时由系统分配 → 打印真实端口（测试靠它拿地址）
  console.log('SeriousBeatmapConverter 已启动： http://localhost:' + actual + '/');
  console.log('（Ctrl+C 停止；跨源隔离 ' + (COI ? '已开启' : '关闭') + '，需要时用 CROSS_ORIGIN_ISOLATION=1 打开）');
  ffmpegStatus().then(s => console.log(s.available
    ? `本地 ffmpeg 接口可用：${s.version}（${s.encoders.join(' / ')}）→ 网页端 MP3 走 ffmpeg`
    : `本地 ffmpeg 不可用（${s.error}）→ 网页端退回内置 lamejs（慢约 10 倍）`));
});

/* 端口被占之类的监听错误要说人话，别让未处理的 'error' 事件把真正原因埋进堆栈里 */
server.on('error', (e) => {
  console.error('无法启动服务：' + e.message
    + (e.code === 'EADDRINUSE' ? `（端口 ${PORT} 已被占用：换一个 PORT=8080 npm start，或先关掉旧的服务器）` : ''));
  process.exit(1);
});
