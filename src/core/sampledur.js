// 样本时长解析（纯 JS，不用 ffmpeg）：
//   Ogg Vorbis：时长 = 最后一页的 granule 位置 / 采样率（采样率在 identification header 里）
//   WAV       ：从 fmt/data 块算
// 这样就能对全库几万个样本快速、准确地判断“这条样本能撑多久”。
export function sampleDurationMs(bytes){
  if(!bytes || bytes.length < 32) return null;
  const u8 = bytes;
  const ascii = (o, n) => String.fromCharCode(u8[o], u8[o+1], u8[o+2], u8[o+3]).slice(0, n);
  if(u8[0] === 0x4F && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53) return oggDurationMs(u8);
  if(ascii(0, 4) === 'RIFF') return wavDurationMs(u8);
  return null;
}

function oggDurationMs(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // 1) 第一页里取采样率：packet 以 0x01 "vorbis" 开头，接着 version(4) channels(1) sample_rate(4)
  let p = 0, rate = 0;
  while(p + 27 <= u8.length && u8[p] === 0x4F && u8[p+1] === 0x67 && u8[p+2] === 0x67 && u8[p+3] === 0x53){
    const segs = u8[p + 26];
    const payload = p + 27 + segs;
    if(!rate && payload + 16 < u8.length && u8[payload] === 0x01){
      const sig = String.fromCharCode(u8[payload+1],u8[payload+2],u8[payload+3],u8[payload+4],u8[payload+5],u8[payload+6]);
      if(sig === 'vorbis') rate = dv.getUint32(payload + 12, true);
    }
    if(u8[p + 5] & 0x04) break;                       // EOS 页
    // 跳到下一页：累计 segment table
    let len = 27 + segs;
    for(let i = 0; i < segs; i++) len += u8[p + 27 + i];
    p += len;
  }
  if(!rate) return null;
  // 2) 从文件尾往前找最后一个 "OggS"，取它的 granule 位置
  for(let i = u8.length - 27; i >= 0; i--){
    if(u8[i] === 0x4F && u8[i+1] === 0x67 && u8[i+2] === 0x67 && u8[i+3] === 0x53){
      const lo = dv.getUint32(i + 6, true), hi = dv.getUint32(i + 10, true);
      const granule = hi * 4294967296 + lo;
      if(granule > 0) return granule / rate * 1000;
    }
  }
  return null;
}

function wavDurationMs(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 12, fmt = null, dataLen = 0;
  const str = (o) => String.fromCharCode(u8[o], u8[o+1], u8[o+2], u8[o+3]);
  while(p + 8 <= u8.length){
    const id = str(p), size = dv.getUint32(p + 4, true);
    if(id === 'fmt '){
      fmt = { channels: dv.getUint16(p + 10, true), rate: dv.getUint32(p + 12, true),
              bits: dv.getUint16(p + 22, true) };
    } else if(id === 'data'){ dataLen = size; break; }
    p += 8 + size + (size & 1);
  }
  if(!fmt || !fmt.rate || !dataLen) return null;
  const bps = fmt.channels * fmt.bits / 8;
  return bps > 0 ? (dataLen / bps) / fmt.rate * 1000 : null;
}
