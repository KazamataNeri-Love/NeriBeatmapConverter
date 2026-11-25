// Float32 PCM → MP3（lamejs / LAME）
//
// ★ 性能要点（2026-09-21 实测）
//   lamejs 是纯 JS，编码约 **10× 实时**：104 秒音频要 11.7 秒，而 WAV 只要 71 毫秒（差 165 倍）。
//   更糟的是整段同步循环会把主线程锁死 → 页面完全卡住。
//   所以这里做了两件事：
//     1. 把“每 1152 个采样一块”的过程做成可步进的编码器（makeMp3Encoder）；
//     2. 提供 encodeMp3Async：每累计一小段时间就 await 一个宏任务，让浏览器有机会绘制/响应，
//        并通过 onProgress 回报进度。
//   异步与同步版本的输出**逐字节一致**（块顺序与参数完全相同）。
import { floatToInt16 } from './pcm.js';

const MP3_BITRATES = [128, 320];          // 只留两个标准档：320k（默认）/ 128k（体积优先）
const DEFAULT_BITRATE = 320;
/** MPEG 只支持这几个采样率；传别的进来 lamejs 会静默产出垃圾数据，所以显式拦住 */
const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
// 块大小用 LAME 原生粒度 1152。试过 4608/11520/46080：多轮交错取中位数后**没有可靠差异**
// （波动比差异还大），而小块的好处是进度更细、单片更短（不会一次占用主线程过久）。
const BLOCK = 1152;

// ★ 耗时实情（2026-09-21 实测，5 轮交错取中位数）：
//   lamejs 约 **10~12× 实时** —— 12 秒音频要 ~1.0 秒，4 分钟歌约 **20 秒**；
//   而 WAV 几乎是瞬间（只是内存拷贝，104 秒音频 71ms）。码率 128 vs 320 **没有可靠差异**。
//   我的 float→int16 转换只占 ~2ms/1000ms（0%），所以瓶颈全在 lamejs 的 JS 实现。
//   要大提速只能换后端：系统 ffmpeg CLI（~100× 快）或 ffmpeg.wasm（~32MB 下载）。

let lame = null;
/** 注入 lamejs 实现：浏览器传 globalThis.lamejs，Node 测试用 vm 载入同一份 vendor 文件 */
export function setLameCodec(lib){ lame = lib; }
export function lameReady(){ return !!(lame || (typeof globalThis !== 'undefined' && globalThis.lamejs)); }
function codec(){
  const lib = lame || (typeof globalThis !== 'undefined' ? globalThis.lamejs : null);
  if(!lib || !lib.Mp3Encoder) throw new Error('MP3 编码器未就绪：确认 vendor/lamejs/lame.min.js 已加载');
  return lib;
}
/** Int8Array 视图 → 独立 Uint8Array（lamejs 内部复用同一块缓冲，必须拷贝） */
function toU8(view){
  const out = new Uint8Array(view.length);
  for(let i = 0; i < view.length; i++) out[i] = view[i] & 0xFF;
  return out;
}
function resolveKbps(bitrate){ return MP3_BITRATES.includes(bitrate) ? bitrate : DEFAULT_BITRATE; }
function checkRate(sampleRate){
  if(!MP3_SAMPLE_RATES.includes(sampleRate))
    throw new Error('MP3 不支持 ' + sampleRate + 'Hz 采样率（可用：' + MP3_SAMPLE_RATES.join('/') + '）');
}
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * 可步进的 MP3 编码器。
 *   pcm = {left, right, sampleRate, length}
 * 内部复用两块 scratch 缓冲（每块 1152 采样），避免每块新建 Int16Array
 * —— 一首 4 分钟的歌有 ~9200 块，原来会产生 1.8 万个临时数组。
 */
export function makeMp3Encoder(pcm, { bitrate = DEFAULT_BITRATE } = {}){
  checkRate(pcm.sampleRate);
  const lib = codec();
  const enc = new lib.Mp3Encoder(2, pcm.sampleRate, resolveKbps(bitrate));
  const scratchL = new Int16Array(BLOCK), scratchR = new Int16Array(BLOCK);
  const chunks = [];
  let totalBytes = 0, i0 = 0, blocksDone = 0;
  const length = pcm.length;
  const blocksTotal = Math.max(1, Math.ceil(length / BLOCK));

  function stepBlocks(n){
    for(let k = 0; k < n && i0 < length; k++, blocksDone++){
      const n2 = Math.min(BLOCK, length - i0);
      // ★ 必须钳位：直接 `v * 0x7FFF` 写 Int16Array 会 **mod 65536 环绕**（+2.0 → -2，符号翻转）
      //   → 刺耳的“兹拉兹拉”；只有 |v|>1 时触发，所以关掉归一化更明显。
      floatToInt16(pcm.left,  i0, n2, scratchL);
      floatToInt16(pcm.right, i0, n2, scratchR);
      const buf = enc.encodeBuffer(scratchL.subarray(0, n2), scratchR.subarray(0, n2));
      if(buf.length){ const c = toU8(buf); chunks.push(c); totalBytes += c.length; }
      i0 += n2;
    }
    return i0 >= length;
  }
  return {
    BLOCK, blocksTotal,
    get blocksDone(){ return blocksDone; },
    get fraction(){ return Math.min(1, blocksDone / blocksTotal); },
    step: stepBlocks,
    finish(){
      const tail = enc.flush();
      if(tail.length){ const c = toU8(tail); chunks.push(c); totalBytes += c.length; }
      const out = new Uint8Array(totalBytes);
      let p = 0;
      for(const c of chunks){ out.set(c, p); p += c.length; }
      return out;
    },
  };
}

/** 同步编码（测试/小输入用）。大文件请用 encodeMp3Async，否则会卡住主线程。 */
export function encodeMp3(pcm, opts = {}){
  const e = makeMp3Encoder(pcm, opts);
  while(!e.step(256)) { /* 编到结束 */ }
  const out = e.finish();
  if(opts.onProgress) opts.onProgress(1);
  return out;
}

/**
 * 异步编码：保持页面可交互 + 进度回报。输出与 encodeMp3 逐字节一致。
 *   onProgress(fraction)  0→1
 *   budgetMs              每次让出主线程前的连续编码预算（默认 12ms ≈ 一帧）
 *   yieldFn               自定义让出方式（默认 setTimeout 0；测试里可换成同步 fake）
 */
export async function encodeMp3Async(pcm, opts = {}){
  const e = makeMp3Encoder(pcm, opts);
  const budget = opts.budgetMs || 12;
  const yieldFn = opts.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
  const stats = { slices: 0, yields: 0, maxSliceMs: 0 };
  let batch = 4;                                   // 自适应批次（块数）；块≈2.6ms 工作，会自适应到预算附近
  let lastReport = 0;
  for(;;){
    const t0 = now();
    const done = e.step(batch);
    const spent = now() - t0;
    stats.slices++;
    if(spent > stats.maxSliceMs) stats.maxSliceMs = spent;
    // 自适应：明显低于预算就加倍，超预算就减半
    if(spent < budget * 0.5 && batch < 256) batch = Math.min(256, batch * 2);
    else if(spent > budget) batch = Math.max(1, batch >> 1);
    if(opts.onProgress){
      const f = e.fraction;
      if(f >= 1 || f - lastReport >= 0.02){ opts.onProgress(f); lastReport = f; }
    }
    if(done) break;
    stats.yields++;
    await yieldFn();                               // 让浏览器绘制/响应，避免整页卡死
  }
  const out = e.finish();
  if(opts.onProgress) opts.onProgress(1);
  if(opts.onStats) opts.onStats(stats);
  return out;
}

export { MP3_BITRATES, MP3_SAMPLE_RATES, DEFAULT_BITRATE, BLOCK };
