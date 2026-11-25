// 音频编码器注册表：新增格式（如 future 的 ffmpeg → OGG/Opus）只需在格式表里加一行。
import { encodeWav } from './wav.js';
import { encodeMp3, encodeMp3Async, makeMp3Encoder, MP3_BITRATES, MP3_SAMPLE_RATES, DEFAULT_BITRATE,
         setLameCodec, lameReady } from './mp3.js';
import { floatToInt16, countOutOfRange } from './pcm.js';

/** 可选输出格式（UI 的下拉框直接读这张表） */
export const AUDIO_FORMATS = [
  {
    id: 'mp3', label: 'MP3（体积约 WAV 的 1/8）', ext: '.mp3', mime: 'audio/mpeg',
    bitrates: MP3_BITRATES, defaultBitrate: DEFAULT_BITRATE,
    note: '320k ≈ 9.2MB / 128k ≈ 3.7MB（4 分钟）；lamejs 纯 JS 编码，无需额外下载',
  },
  {
    id: 'wav', label: 'WAV（无损，体积大）', ext: '.wav', mime: 'audio/wav',
    bitrates: [], defaultBitrate: 0,
    note: 'osu! 原生支持，但 4 分钟约 40MB',
  },
  {
    id: 'ogg', label: 'OGG Vorbis（仅命令行 + ffmpeg）', ext: '.ogg', mime: 'audio/ogg',
    bitrates: [], defaultBitrate: 0, nodeOnly: true,
    note: '体积与 320k MP3 相近，仅 tools/cli.js 配合系统 ffmpeg 可用',
  },
];

export function formatById(id){
  return AUDIO_FORMATS.find(f => f.id === id) || AUDIO_FORMATS[0];
}

/** 把 PCM 编成指定格式：返回 {bytes, fmt}（同步；MP3 大文件会阻塞主线程，请用 encodeAudioAsync） */
export function encodeAudio(pcm, formatId, bitrate){
  const fmt = formatById(formatId);
  const bytes = fmt.id === 'mp3' ? encodeMp3(pcm, { bitrate }) : encodeWav(pcm);
  return { bytes, fmt };
}

/* ---- 可插拔的后端：Node 命令行（tools/cli.js）用它把 mp3/ogg 换成 ffmpeg ----
   浏览器永远不注册 → 走的还是 lamejs / 纯 JS WAV，行为不变。
   注册函数的签名：async (pcm, {bitrate, format}) => Uint8Array（格式与 fmt 一致） */
const BACKENDS = new Map();
export function registerEncoder(formatId, fn, meta){
  const fmt = formatById(formatId);
  if(meta) Object.assign(fmt, meta);                 // 可顺带补 ext/mime/note
  BACKENDS.set(fmt.id, fn);
  return fmt;
}
export function encoderBackend(formatId){ return BACKENDS.get(formatById(formatId).id) || null; }
export function unregisterEncoder(formatId){ return BACKENDS.delete(formatById(formatId).id); }
export function clearEncoders(){ BACKENDS.clear(); }

/** 异步版：优先用注册的后端（Node/ffmpeg）；否则 MP3 分片编码 + 定时让出主线程，onProgress(0→1) 接进度条 */
export async function encodeAudioAsync(pcm, formatId, bitrate, { onProgress } = {}){
  const fmt = formatById(formatId);
  const backend = BACKENDS.get(fmt.id);
  if(backend){
    const bytes = await backend(pcm, { bitrate, format: fmt });
    if(onProgress) onProgress(1);
    return { bytes, fmt };
  }
  const bytes = fmt.id === 'mp3'
    ? await encodeMp3Async(pcm, { bitrate, onProgress })
    : encodeWav(pcm);
  return { bytes, fmt };
}

export { encodeWav, encodeMp3, encodeMp3Async, makeMp3Encoder, setLameCodec, lameReady,
         MP3_BITRATES, MP3_SAMPLE_RATES, DEFAULT_BITRATE, floatToInt16, countOutOfRange };
