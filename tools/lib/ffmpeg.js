// Node 专用：用系统 ffmpeg 做两件事，替掉浏览器里那两条慢路径
//   1) 解码 OJM 样本（Vorbis/WAV）—— 批量：一次进程解几十个，比逐个快一个数量级
//   2) 编码 PCM → MP3/OGG —— libmp3lame 比 lamejs（纯 JS）快约两个数量级
// 浏览器不会 import 这个文件（它用 node:child_process / node:fs）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { registerEncoder } from '../../src/core/encoders/index.js';

/* ------------------------------------------------------------------ 定位 ffmpeg */

let cachedBin = null;

/** 分阶段耗时累加（全局）：用来回答“这几秒到底花在哪了” */
const FFSTATS = { decodeMs: 0, decodeSpawns: 0, decodeFiles: 0, encodeMs: 0, encodes: 0, encInFrames: 0 };
export function ffmpegStats(){ return { ...FFSTATS }; }

/** 找 ffmpeg：显式路径 → 环境变量 FFMPEG → PATH。找到会真正跑一次 -version 验证。 */
export async function findFfmpeg(explicit){
  const candidates = [explicit, process.env.FFMPEG, process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean);
  for(const c of candidates){
    try {
      const v = await run([c, ['-hide_banner', '-version']], { quiet: true });
      const first = String(v.stdout || '').split('\n')[0].trim();
      cachedBin = c;
      return { bin: c, version: first };
    } catch(e){ /* 试下一个 */ }
  }
  throw new Error('找不到可用的 ffmpeg。装一个（winget install Gyan.FFmpeg / scoop install ffmpeg / brew install ffmpeg），'
                + '或用 --ffmpeg <path> 指定，或设置环境变量 FFMPEG。');
}

export function ffmpegBin(){ return cachedBin || process.env.FFMPEG || 'ffmpeg'; }

/** 检查 ffmpeg 是否带某个编码器（libmp3lame / libvorbis），没有就早失败，别等转一半才报 */
export async function hasEncoder(bin, name){
  try {
    const r = await run([bin || ffmpegBin(), ['-hide_banner', '-encoders']], { quiet: true });
    return new RegExp('\\b' + name + '\\b').test(String(r.stdout || ''));
  } catch(e){ return false; }
}

/* ------------------------------------------------------------------ 进程封装 */

function run([bin, args], { quiet } = {}){
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1 << 30, windowsHide: true }, (err, stdout, stderr) => {
      if(err) reject(new Error(quiet ? err.message : (String(stderr || '').trim().split('\n').slice(-3).join('\n') || err.message)));
      else resolve({ stdout, stderr });
    });
  });
}

/** 用内容而不是扩展名判断真实格式 —— OJM 里「.wav 其实是 MP3」这类错装很常见，扩展名骗不过 ffmpeg 的探测但会白费一次尝试 */
export function sniffExt(bytes, fallback){
  if(bytes && bytes.length >= 4){
    if(bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'ogg';
    if(bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'wav';
    if(bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'mp3';
    if(bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) return 'mp3';
    if(bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43) return 'flac';
    if(bytes[0] === 0x66 && bytes[1] === 0x4F && bytes[2] === 0x72 && bytes[3] === 0x6D) return 'aiff';
  }
  return fallback === 'audio/wav' ? 'wav' : fallback === 'audio/ogg' ? 'ogg' : 'bin';
}

/* ------------------------------------------------------------------ 样本内容缓存 */

/** 双层 32 位 FNV-1a：碰撞概率足以忽略，但比 BigInt 快得多 */
function contentKey(bytes){
  let h1 = 0x811C9DC5, h2 = 0x01000193;
  for(let i = 0; i < bytes.length; i++){
    const b = bytes[i];
    h1 = ((h1 ^ b) * 0x01000193) >>> 0;
    h2 = ((h2 + b) * 0x85EBCA6B) >>> 0;
  }
  return bytes.length.toString(36) + ':' + h1.toString(36) + h2.toString(36);
}

class SampleCache {
  constructor(maxBytes){ this.max = maxBytes; this.map = new Map(); this.bytes = 0; this.hits = 0; this.misses = 0; }
  get(k){
    const v = this.map.get(k);
    if(v === undefined){ this.misses++; return undefined; }
    this.hits++;
    this.map.delete(k); this.map.set(k, v);          // LRU：命中就挪到队尾
    return v;
  }
  set(k, v, byteSize){
    if(!this.max || v === null) return;              // 失败结果不缓存，下次还能重试
    if(byteSize > this.max / 4) return;              // 超大的（整首 BGM）不值得占坑
    this.map.set(k, v); this.bytes += byteSize;
    while(this.bytes > this.max && this.map.size > 1){
      const oldest = this.map.keys().next().value;
      this.bytes -= this.map.get(oldest).pcmBytes || 0;
      this.map.delete(oldest);
    }
  }
}

/* ------------------------------------------------------------------ 批量解码 */

/* Windows 单条命令行上限 ~32k 字符（CreateProcess）：输入 + 输出两段参数都要算进去。
   实测 300 个样本一次给会直接 spawn ENAMETOOLONG，所以按**真实路径长度**估算每批个数 ——
   固定个数在路径长的时候会翻车，靠估算才不会。 */
function chunkByCmdline(items, tmpDir, bin, maxChars = 28000){
  //  -i <tmpDir>\i0000123.ogg            ≈ tmpDir + 20
  //  -map 12:a -f f32le -ac 2 -ar 44100 -y <tmpDir>\o0000123.raw   ≈ tmpDir + 45
  const per = tmpDir.length * 2 + 65 + 8;
  const n = Math.max(4, Math.min(128, Math.floor((maxChars - (bin || 'ffmpeg').length - 300) / per)));
  const out = [];
  for(let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * 批量把样本解成「类 AudioBuffer」对象。
 * @param items [{id, bytes, mime}]  同 id 只解一次
 * @returns Map<id, {numberOfChannels,length,sampleRate,duration,getChannelData}|null>
 * 单条坏样本不会连累整批：整批失败时会逐条重试，坏的记 null（与浏览器 decodeAudioData 失败同语义）。
 */
async function decodeMany(items, { ffmpeg, sampleRate, tmpDir, seq, cache, batchSize }){
  const out = new Map();
  const todo = [];
  const seen = new Set();
  for(const it of items){
    if(seen.has(it.id)) continue;                    // 同一个 id 出现多次只解一次
    seen.add(it.id);
    const key = cache ? contentKey(it.bytes) : null;
    if(cache){
      const hit = cache.get(key);
      if(hit !== undefined){ out.set(it.id, hit); continue; }
    }
    todo.push({ ...it, key });
  }
  if(!todo.length) return out;

  const chunks = batchSize > 0 ? (() => {
    const a = []; for(let i = 0; i < todo.length; i += batchSize) a.push(todo.slice(i, i + batchSize)); return a;
  })() : chunkByCmdline(todo, tmpDir, ffmpeg);

  const decodeOne = async (it) => {
    const ext = sniffExt(it.bytes, it.mime);
    const inFile = path.join(tmpDir, `i${seq.v++}.${ext}`);
    const outFile = path.join(tmpDir, `o${seq.v++}.raw`);
    try {
      fs.writeFileSync(inFile, it.bytes);
      await run([ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', inFile,
        '-map', '0:a', '-f', 'f32le', '-ac', '2', '-ar', String(sampleRate), outFile]]);
      const ab = readRawStereo(outFile, sampleRate);
      if(cache && it.key) cache.set(it.key, ab, ab.length * 8);
      return ab;
    } catch(e){ return null; }
    finally { try { fs.unlinkSync(inFile); } catch {} try { fs.unlinkSync(outFile); } catch {} }
  };

  for(const chunk of chunks){
    let ok = false;
    if(chunk.length > 1){
      const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
      const inFiles = [], outFiles = [];
      for(const it of chunk){
        const f = path.join(tmpDir, `i${seq.v++}.${sniffExt(it.bytes, it.mime)}`);
        fs.writeFileSync(f, it.bytes);
        inFiles.push(f); args.push('-i', f);
      }
      chunk.forEach((it, k) => {
        const f = path.join(tmpDir, `o${seq.v++}.raw`);
        outFiles.push(f);
        args.push('-map', `${k}:a`, '-f', 'f32le', '-ac', '2', '-ar', String(sampleRate), '-y', f);
      });
      const tDec = performance.now();
      try {
        await run([ffmpeg, args]);                    // maxBuffer 无关（声音都写文件了）
        FFSTATS.decodeMs += performance.now() - tDec;
        FFSTATS.decodeSpawns++;
        FFSTATS.decodeFiles += chunk.length;
        for(let k = 0; k < chunk.length; k++){
          const ab = readRawStereo(outFiles[k], sampleRate);
          out.set(chunk[k].id, ab);
          if(cache && chunk[k].key) cache.set(chunk[k].key, ab, ab.length * 8);
        }
        ok = true;
      } catch(e){ ok = false; }
      finally { for(const f of inFiles.concat(outFiles)) { try { fs.unlinkSync(f); } catch {} } }
    }
    if(!ok){                                          // 整批失败 → 逐条重试，隔离坏样本
      for(const it of chunk) out.set(it.id, await decodeOne(it));
    }
  }
  return out;
}

/** f32le 立体声交织 → {left, right} */
function readRawStereo(file, sampleRate){
  const buf = fs.readFileSync(file);
  const frames = Math.floor(buf.length / 8);
  /* Float32Array 的 byteOffset 必须是 4 的倍数，而 fs 对小块读会返回内存池里的切片。
     不齐时要**拷字节**（ArrayBuffer.slice），不能 new Float32Array(buffer) ——
     后者是按元素转数字，会把每个字节当成一个 float。 */
  const f = (buf.byteOffset % 4 === 0)
    ? new Float32Array(buf.buffer, buf.byteOffset, frames * 2)
    : new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + frames * 8));
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for(let i = 0; i < frames; i++){ left[i] = f[2*i]; right[i] = f[2*i+1]; }
  return { numberOfChannels: 2, length: frames, sampleRate, duration: frames / sampleRate,
           pcmBytes: frames * 8, getChannelData: (i) => (i === 0 ? left : right) };
}

/**
 * 造一个「长得像 AudioContext」的东西交给 src/audio.js 的混音器。
 * 混音器只用到 decodeAudioData / decodeBatch → 其余一律不需要（所以不需要 Web Audio polyfill）。
 */
export async function createFfmpegAudioContext({ sampleRate = 44100, ffmpeg, cacheMb = 256, batchSize = 0, tmpRoot } = {}){
  const bin = ffmpeg || ffmpegBin();
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot || os.tmpdir(), 'o2jam-cli-'));
  const seq = { v: 0 };
  const cache = cacheMb > 0 ? new SampleCache(cacheMb * 1048576) : null;
  const stats = { batches: 0, decoded: 0, singleDecodes: 0, singleFails: 0 };
  const ctx = {
    sampleRate,
    async decodeBatch(items){
      stats.batches++;
      const r = await decodeMany(items, { ffmpeg: bin, sampleRate, tmpDir, seq, cache, batchSize });
      stats.decoded += r.size;
      return r;
    },
    // 兼容单条调用（混音器优先用 decodeBatch，这里只是保底 / 便于单测）
    async decodeAudioData(arrayBuffer){
      const bytes = new Uint8Array(arrayBuffer);
      stats.singleDecodes++;
      const r = await decodeMany([{ id: 0, bytes, mime: 'audio/ogg' }], { ffmpeg: bin, sampleRate, tmpDir, seq, cache, batchSize: 1 });
      const ab = r.get(0);
      if(!ab) { stats.singleFails++; throw new Error('ffmpeg 无法解码该样本'); }
      return ab;
    },
    stats(){ return { ...stats, cacheHits: cache ? cache.hits : 0, cacheMisses: cache ? cache.misses : 0,
                      cacheBytes: cache ? cache.bytes : 0 }; },
    dispose(){ try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){} },
  };
  return ctx;
}

/* ------------------------------------------------------------------ 编码 */

const FFMPEG_ENCODERS = {
  mp3:  { codec: 'libmp3lame', args: (bitrate) => ['-b:a', `${bitrate || 320}k`], mime: 'audio/mpeg', ext: '.mp3' },
  ogg:  { codec: 'libvorbis',  args: () => ['-q:a', '6'],                        mime: 'audio/ogg',  ext: '.ogg' },
};

/** PCM（非交织的 left/right）→ 指定格式字节。分块喂 stdin，避免再多一整份交织缓冲。 */
export async function encodePcmFfmpeg(pcm, { format = 'mp3', bitrate, ffmpeg } = {}){
  const spec = FFMPEG_ENCODERS[format];
  if(!spec) throw new Error('ffmpeg 后端不支持输出格式：' + format);
  const bin = ffmpeg || ffmpegBin();
  const frames = pcm.length;
  const outExt = spec.ext;
  const tmpOut = path.join(os.tmpdir(), `o2jam-enc-${process.pid}-${Date.now()}-${(Math.random() * 1e6) | 0}${outExt}`);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'f32le', '-ar', String(pcm.sampleRate), '-ac', '2', '-i', 'pipe:0',
    '-c:a', spec.codec, ...spec.args(bitrate), '-f', outExt.slice(1), tmpOut];
  try {
    const tEnc = performance.now();
    await new Promise((resolve, reject) => {
      const child = execFile(bin, args, { maxBuffer: 1 << 28, windowsHide: true }, (err, so, se) =>
        err ? reject(new Error(String(se || err.message).trim().split('\n').slice(-3).join('\n'))) : resolve());
      child.stdin.on('error', () => {});              // ffmpeg 提前退出时别抛 EPIPE
      const CHUNK = 1 << 16;                           // 65536 帧 ≈ 1.5 秒
      const outBuf = Buffer.allocUnsafe(CHUNK * 8);
      const inter = new Float32Array(outBuf.buffer, outBuf.byteOffset, CHUNK * 2);
      let p = 0;
      const pump = () => {
        while(p < frames){
          const n = Math.min(CHUNK, frames - p);
          for(let i = 0; i < n; i++){ inter[i * 2] = pcm.left[p + i]; inter[i * 2 + 1] = pcm.right[p + i]; }
          /* ★ 必须拷贝：Buffer.from(arrayBuffer,…) 是**视图**，流可能还没把它冲走就被下一轮覆写了
             → 音频会被静默改掉。Buffer.from(Buffer) 才会拷贝（实测这拷贝只值 ~30ms）。 */
          const slice = Buffer.from(outBuf.subarray(0, n * 8));
          p += n;
          if(!child.stdin.write(slice)){ child.stdin.once('drain', pump); return; }
        }
        child.stdin.end();
      };
      pump();
    });
    FFSTATS.encodeMs += performance.now() - tEnc;
    FFSTATS.encodes++;
    FFSTATS.encInFrames += frames;
    const bytes = new Uint8Array(fs.readFileSync(tmpOut));
    return bytes;
  } finally { try { fs.unlinkSync(tmpOut); } catch(e){} }
}

/** 把 mp3（以及 ogg）后端注册成 ffmpeg 实现 —— 命令行工具启动时调一次 */
export function registerFfmpegEncoders(opts = {}){
  for(const id of Object.keys(FFMPEG_ENCODERS))
    registerEncoder(id, (pcm, { bitrate }) => encodePcmFfmpeg(pcm, { format: id, bitrate, ffmpeg: opts.ffmpeg }));
}

/** 直接喂**已交织**的 f32le 字节流（本地 HTTP API 用，浏览器那边就不用再写一遍交织循环） */
export async function encodeInterleavedFfmpeg(interleaved, { frames, sampleRate, format = 'mp3', bitrate, ffmpeg } = {}){
  const spec = FFMPEG_ENCODERS[format];
  if(!spec) throw new Error('ffmpeg 后端不支持输出格式：' + format);
  const bin = ffmpeg || ffmpegBin();
  const tmpOut = path.join(os.tmpdir(), `o2jam-http-${process.pid}-${Date.now()}-${(Math.random() * 1e6) | 0}${spec.ext}`);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'f32le', '-ar', String(sampleRate), '-ac', '2', '-i', 'pipe:0',
    '-c:a', spec.codec, ...spec.args(bitrate), '-f', spec.ext.slice(1), tmpOut];
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(bin, args, { maxBuffer: 1 << 28, windowsHide: true }, (err, so, se) =>
        err ? reject(new Error(String(se || err.message).trim().split('\n').slice(-3).join('\n'))) : resolve());
      child.stdin.on('error', () => {});
      const CHUNK = 1 << 22;                  // 4MB 一次；buffer 直接来自调用方且不重用 → 不需要再拷
      let p = 0;
      const pump = () => {
        while(p < interleaved.length){
          const n = Math.min(CHUNK, interleaved.length - p);
          const slice = Buffer.from(interleaved.buffer, interleaved.byteOffset + p, n);
          p += n;
          if(!child.stdin.write(slice)){ child.stdin.once('drain', pump); return; }
        }
        child.stdin.end();
      };
      pump();
    });
    return new Uint8Array(fs.readFileSync(tmpOut));
  } finally { try { fs.unlinkSync(tmpOut); } catch(e){} }
}

export { FFMPEG_ENCODERS };
