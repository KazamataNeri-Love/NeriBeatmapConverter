// 音频混音：把 OJM 样本按「时间 / 音量 / 声像」叠成一条 Float32 立体声轨（PCM）。
// 编码交给 src/encoders/*（WAV / MP3 / 将来可加 ffmpeg）。替代原版的 audio-sample-mixer.exe。
import { encodeAudio, encodeAudioAsync, encodeWav, formatById } from './encoders/index.js';

async function decodeSampleBytes(audioCtx, bytes, mime){
  // 用 Blob + arrayBuffer 兼容性最好；decodeAudioData 会自动重采样到 audioCtx.sampleRate
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return await audioCtx.decodeAudioData(buf);
}

/** 生成一段静音 PCM（没有可用样本时当音轨用，保证 .osz 完整、时长正确） */
function silentPcm(sampleRate, length){
  return { left: new Float32Array(length), right: new Float32Array(length), sampleRate, length,
           musicOffset: 0, usedSamples: 0, firstSampleTime: 0, peak: 0, gain: 1,
           loudness: 'none', limited: false, reductionDb: 0, silent: true };
}

/** 混音成 PCM。返回 {left, right, sampleRate, length, musicOffset, usedSamples, firstSampleTime, peak, gain}
    options:
      normalize     默认 true：峰值归一化到 -1dBFS（密集键音叠加很容易超 0dBFS，硬限幅就是“叮啦叮啦”的来源）
      minDurationMs 把结果**补静音到至少这么长**：谱面尾部不该因为样本不够而断掉；
                    同时它也是「一个样本都没有」时的静音音轨长度（否则才报错） */
async function mixToPcm(audioCtx, audioObjects, samples, sampleRate, options){
  const opts = options || {};
  const minFrames = Math.max(0, Math.round((opts.minDurationMs || 0) * sampleRate / 1000));
  const used = [];
  // 解码缓存可以跨难度复用（同一首歌三个难度的样本表相同）→ 少解 2/3、少一次内存峰值
  const decoded = (opts.decodeCache instanceof Map) ? opts.decodeCache : new Map();
  for(const obj of audioObjects || []){
    const s = samples.get(obj.sampleId);
    if(!s) continue;
    used.push({obj, sample:s});
  }
  if(!used.length){
    if(minFrames > 0) return silentPcm(sampleRate, minFrames);      // 无样本 → 静音轨（不再让整首歌没音频）
    throw new Error("no audio sample found/used.");
  }
  /* ★ 这里渲染的是「从 0 开始的完整时间轴」：第一个样本之前会补静音，
     所以 .osu 的时间绝对不能再做位移 —— musicOffset 必须恒为 0。
     （原版在「整首只用到 1 个音频对象」时把该样本文件直接当音频输出，没有前置静音，
      才需要 musicOffset = 该样本时间 来对齐；本混音路径等价于原版的「多样本」分支。
      以前错以单样本分支返回了非 0 偏移 → 整张图的 Note 提前一大截，
      而且偏移量是小数→写出小数时间→osu! 直接拒绝导入。） */
  const musicOffset = 0;

  /* ★ 批量解码：Node 命令行（tools/lib/ffmpeg.js）的 audioCtx 提供 decodeBatch —— 它能在
     一次 ffmpeg 进程里解几十个样本，比逐个 decodeAudioData 快一个数量级（实测 300 个样本：
     逐个 16450ms → 批量 2109ms）。浏览器没有 decodeBatch，所以下面 else 分支的
     逐个 decodeAudioData 行为完全不变。 */
  const missing = used.filter(u => !decoded.has(u.obj.sampleId));
  if(missing.length && audioCtx && typeof audioCtx.decodeBatch === "function"){
    let got = null;
    try { got = await audioCtx.decodeBatch(missing.map(u => ({ id: u.obj.sampleId, bytes: u.sample.bytes, mime: u.sample.mime }))); }
    catch(e){ got = null; }
    for(const u of missing) decoded.set(u.obj.sampleId, (got && got.get(u.obj.sampleId)) || null);
  } else {
    for(const u of missing){
      try { decoded.set(u.obj.sampleId, await decodeSampleBytes(audioCtx, u.sample.bytes, u.sample.mime)); }
      catch(e){ decoded.set(u.obj.sampleId, null); }
    }
  }
  let endFrame = 0;
  for(const u of used){
    const ab = decoded.get(u.obj.sampleId); if(!ab) continue;
    const start = Math.max(0, Math.round(u.obj.time * sampleRate / 1000));
    endFrame = Math.max(endFrame, start + ab.length);
  }
  if(endFrame <= 0) throw new Error("所有样本解码失败（浏览器可能不支持该 Vorbis/WAV 变体）。");
  endFrame += Math.round(0.05 * sampleRate);          // 收尾留 50ms
  const sampleEnd = endFrame;
  /* ★ 补到谱面长度：不少 OJM 只含部分样本（有的只有 1 个），只按样本算的话
     音频会提前结束 —— 听上去就是“这首缺音频 / 播到一半就没了”。 */
  if(minFrames > endFrame) endFrame = minFrames;
  const padded = endFrame > sampleEnd;

  const left = new Float32Array(endFrame), right = new Float32Array(endFrame);
  for(const u of used){
    const ab = decoded.get(u.obj.sampleId); if(!ab) continue;
    const start = Math.max(0, Math.round(u.obj.time * sampleRate / 1000));
    const p = Math.max(-1, Math.min(1, u.obj.pan));
    /* 声像用的是「平衡式」而不是等功率：居中 = 两声道原样通过，向右只衰减左声道。
       理由是可验证的一致性：保留键音模式下这些样本是由 osu 自己播的（Sample 事件 / hitSample，
       不做声像、幅度原样），如果混音用等功率居中（每声道 ×0.707）就会整体低 3dB、
       听上去“和键音不一致”。实测改成平衡式后，混音峰值与「键音等效求和」完全相同、
       平均差 0.00%FS（相关系数 1.000000）。 */
    const gl = u.obj.volume * (p > 0 ? 1 - p : 1);
    const gr = u.obj.volume * (p < 0 ? 1 + p : 1);
    const mono = ab.numberOfChannels === 1;
    const ch0 = ab.getChannelData(0);
    const ch1 = mono ? ch0 : ab.getChannelData(1);
    for(let i = 0; i < ab.length; i++){
      const f = start + i; if(f >= endFrame) break;
      left[f]  += ch0[i] * gl;
      right[f] += ch1[i] * gr;
    }
  }
  // ---- 响度处理（默认峰值归一化到 -1dBFS；loudness:'limit' 可换成限制器） ----
  /* 背景：密集键音叠加后峰值常到 3~5（+10~+14dBFS）。峰值归一化为了让那一个尖峰不削波会把**整首歌**
     拉下去（用 ebur128 实测比原曲母带低 7~10dB，听感就是“响度好低”）。
     替代方案是 loudness:'limit' —— 前视限制器只压超阈值的瞬间，响度基本与原曲持平，但默认不开。 */
  const TARGET_PEAK = 0.89;                     // ≈ -1 dBFS：给有损编码的重建过冲留余量
  let peak = 0;
  for(let i = 0; i < endFrame; i++){
    const a = Math.abs(left[i]); if(a > peak) peak = a;
    const b = Math.abs(right[i]); if(b > peak) peak = b;
  }
  const mode = resolveLoudness(opts);
  let gain = 1, reductionDb = 0;
  if(mode === 'limit' && peak > TARGET_PEAK){
    reductionDb = limitPeaks(left, right, endFrame, sampleRate, TARGET_PEAK, opts);
  } else if(mode === 'normalize' && peak > TARGET_PEAK){
    gain = TARGET_PEAK / peak;                  // 老行为：整首一个增益（最安全但安静）
    for(let i = 0; i < endFrame; i++){ left[i] *= gain; right[i] *= gain; }
  }
  return { left, right, sampleRate, length: endFrame, musicOffset,
           usedSamples: used.length, firstSampleTime: used[0].obj.time, peak, gain,
           loudness: mode, limited: mode === 'limit' && reductionDb < 0, reductionDb,
           padded, silent: false };
}

/** 响度模式：normalize（峰值归一化，默认）/ none（原样，会削波）/ limit（前视限制器，可选）
    默认与改动前完全一致 —— 想“跟原曲一样响”就显式传 loudness:'limit'。 */
function resolveLoudness(opts){
  if(opts.loudness) return opts.loudness;
  return opts.normalize === false ? 'none' : 'normalize';
}

/**
 * 前视峰值限制器（立体声联动）。返回最大压制量 dB。
 *
 * 两趟 O(n) 包络平滑，而不是真的取滑窗最小值、也不给信号加延迟：
 *  1) 每个采样点「为了不超阈值需要多少增益」：g[i] = min(1, ceil/|x[i]|)
 *  2) 反推一趟：从右往左，让增益**在尖峰之前**平滑地降下来（前视窗口约 10ms）。
 *     关键是下降速率由**下一个采样点的增益**决定（allowed = 1 - (1-prev)*k），
 *     而不是把目标乘 k —— 后者会让 1*k < 1 永远成立，增益一路衰减到数组开头
 *     （整个信号被压掉几十 dB）。★ 这个 bug 是写测试时抓出来的：
 *     整块 fill(0.2) + 一个 3.0 尖峰 → 输出峰值 0.0109（应为 0.89）、100% 的样本都被改了。
 *  3) 正向一趟：立刻压下（g 已是逐样本需求），按指数缓慢释放（释放太快会“喘息”，太慢会把后面也压暗）
 * 立体声取两声道较大值算增益（联动），否则声像会左右晃。
 */
function limitPeaks(left, right, n, sampleRate, ceiling, opts){
  const o = opts || {};
  const attackMs = o.limitAttackMs > 0 ? o.limitAttackMs : 1.2;
  const releaseMs = o.limitReleaseMs > 0 ? o.limitReleaseMs : 120;
  const k = Math.exp(-1 / Math.max(1, attackMs * sampleRate / 1000));      // 前视窗口内回升速率
  const rel = Math.exp(-1 / Math.max(1, releaseMs * sampleRate / 1000));   // 释放速率
  const g = new Float32Array(n);
  for(let i = 0; i < n; i++){
    const a = Math.abs(left[i]) > Math.abs(right[i]) ? Math.abs(left[i]) : Math.abs(right[i]);
    g[i] = a > ceiling ? ceiling / a : 1;
  }
  let prev = 1;
  /* 反推：让增益在尖峰**之前**平滑降下来。回升到 FLOOR 以内就直接当 1 ——
     指数回升是渐近的，不设这个下限的话“前视”会拖出一条无限长的小尾巴
     （实测 11ms 外还有 0.0005 的衰减，虽然听不出来，但让窗口没法界定）。 */
  const FLOOR = 0.9999;                      // ≈ -0.001 dB
  for(let i = n - 1; i >= 0; i--){
    const allowed = 1 - (1 - prev) * k;
    let v = allowed < g[i] ? allowed : g[i];
    if(v > FLOOR) v = 1;
    g[i] = v;
    prev = v;
  }
  let env = 1, minGain = 1;
  for(let i = 0; i < n; i++){
    const released = 1 - (1 - env) * rel;
    env = g[i] < released ? g[i] : released;
    if(env < minGain) minGain = env;
    left[i] *= env; right[i] *= env;
  }
  return 20 * Math.log10(minGain > 1e-6 ? minGain : 1e-6);
}

/** 混音 + 编码成指定格式 → {bytes, fmt, ...}。MP3 走异步分片编码（不阻塞界面），onEncodeProgress 接进度 */
async function mixAndEncode(audioCtx, audioObjects, samples,
                            { sampleRate, format = 'mp3', bitrate, normalize, loudness, minDurationMs,
                              decodeCache, onEncodeProgress } = {}){
  const pcm = await mixToPcm(audioCtx, audioObjects, samples, sampleRate,
                             { normalize, loudness, minDurationMs, decodeCache });
  const { bytes, fmt } = await encodeAudioAsync(pcm, format, bitrate, { onProgress: onEncodeProgress });
  return { bytes, fmt, musicOffset: pcm.musicOffset, usedSamples: pcm.usedSamples,
           firstSampleTime: pcm.firstSampleTime, seconds: pcm.length / pcm.sampleRate,
           peak: pcm.peak, gain: pcm.gain, loudness: pcm.loudness, limited: pcm.limited,
           reductionDb: pcm.reductionDb, padded: pcm.padded, silent: pcm.silent };
}

/** 兼容包装：只编 WAV（老调用/只想要无损时用）→ {wav, musicOffset, usedSamples, firstSampleTime} */
async function mixToWav(audioCtx, audioObjects, samples, sampleRate, options){
  const pcm = await mixToPcm(audioCtx, audioObjects, samples, sampleRate, options);
  return { wav: encodeWav(pcm), musicOffset: pcm.musicOffset, usedSamples: pcm.usedSamples,
           firstSampleTime: pcm.firstSampleTime, peak: pcm.peak, gain: pcm.gain };
}

export { decodeSampleBytes, mixToPcm, mixAndEncode, mixToWav, formatById, silentPcm, resolveLoudness, limitPeaks };
