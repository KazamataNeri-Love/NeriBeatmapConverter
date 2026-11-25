// 浏览器侧：把本地服务（tools/serve.js）的 /api/encode 接成编码后端。
//
// 为什么不是 ffmpeg.wasm：网页端只是「拿不到 ffmpeg」才不得不用纯 JS 的 lamejs，
// 而本项目的页面本来就是 `npm start` 起的 Node 服务 —— 让那个服务去调系统 ffmpeg，
// 既不用下载 ~32MB wasm，速度也直接等于命令行（libmp3lame ~120× 实时）。
// 没跑该服务（例如用 Live Server 打开）时，probe 会失败，页面自动退回内置 lamejs。
import { registerEncoder, unregisterEncoder } from './index.js';

const DEFAULT_TIMEOUT = 2000;

/** 探一下本地 ffmpeg 接口在不在。永远不抛异常，失败返回 {available:false, error} */
async function probeFfmpegBackend({ base = '', timeoutMs = DEFAULT_TIMEOUT } = {}){
  const url = base + '/api/ffmpeg';
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const r = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if(!r.ok) return { available: false, base, error: 'HTTP ' + r.status };
    const j = await r.json();
    return { available: !!j.available, base, version: j.version || null,
             encoders: j.encoders || [], error: j.error || null };
  } catch(e){
    return { available: false, base, error: '连接不上本地 ffmpeg 接口（' + (e && e.name === 'AbortError' ? '超时' : e.message) + '）' };
  } finally { if(timer) clearTimeout(timer); }
}

/**
 * 把 mp3/ogg 注册成「POST 给本地服务」的后端。
 * 请求体按「左声道字节 ‖ 右声道字节」拼 —— 不做交织，省掉几百万次逐样本赋值。
 */
function registerFfmpegHttpEncoder(base = '', { onStat } = {}){
  const make = (format) => async (pcm, { bitrate } = {}) => {
    const n = pcm.length;
    const body = new Uint8Array(n * 8);
    const L = new Uint8Array(pcm.left.buffer, pcm.left.byteOffset, n * 4);
    const R = new Uint8Array(pcm.right.buffer, pcm.right.byteOffset, n * 4);
    body.set(L, 0);
    body.set(R, n * 4);
    const q = new URLSearchParams({ format, rate: String(pcm.sampleRate) });
    if(format === 'mp3') q.set('bitrate', String(bitrate || 320));
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const r = await fetch(base + '/api/encode?' + q.toString(), { method: 'POST', body });
    if(!r.ok){
      let msg = 'HTTP ' + r.status;
      try { msg = (await r.json()).error || msg; } catch(e){}
      throw new Error('本地 ffmpeg 编码失败：' + msg);
    }
    const buf = await r.arrayBuffer();
    if(onStat) onStat({ format, ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
                        frames: n, bytes: buf.byteLength });
    return new Uint8Array(buf);
  };
  registerEncoder('mp3', make('mp3'));
  registerEncoder('ogg', make('ogg'));
}

function unregisterFfmpegBackends(){
  unregisterEncoder('mp3');
  unregisterEncoder('ogg');
}

export { probeFfmpegBackend, registerFfmpegHttpEncoder, unregisterFfmpegBackends };
