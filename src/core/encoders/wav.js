// Float32 立体声 PCM → 16bit PCM WAV
import { floatToInt16 } from './pcm.js';

/** pcm = {left, right, sampleRate, length} → Uint8Array */
export function encodeWav(pcm){
  const { left, right, sampleRate, length } = pcm;
  const bytes = new Uint8Array(44 + length * 4);
  const dv = new DataView(bytes.buffer);
  const put = (o, s) => { for(let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  put(0, "RIFF"); dv.setUint32(4, 36 + length * 4, true); put(8, "WAVE");
  put(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);              // PCM / 双声道
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 4, true);
  dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  put(36, "data"); dv.setUint32(40, length * 4, true);
  const L = floatToInt16(left, 0, length), R = floatToInt16(right, 0, length);
  let o = 44;
  for(let i = 0; i < length; i++){
    dv.setInt16(o, L[i], true); o += 2;
    dv.setInt16(o, R[i], true); o += 2;
  }
  return bytes;
}
