// OJM 解析（对齐 org.open2jam.parsers.OJMParser）
// 由 o2jam2osu.html 的单文件脚本拆分而来（逻辑未改动；从 @/ 分节 3）

import { toArrayBuffer } from "./ojn.js";

/* =====================================================================
   3. OJM 解析（对齐 org.open2jam.parsers.OJMParser）
   ===================================================================== */
const M30_SIGNATURE = 0x0030334D, OMC_SIGNATURE = 0x00434D4F, OJM_SIGNATURE = 0x004D4A4F;
const MASK_NAMI = [0x6E,0x61,0x6D,0x69];
const MASK_0412 = [0x30,0x34,0x31,0x32];
const REARRANGE_TABLE = [
  0x10,0x0E,0x02,0x09,0x04,0x00,0x07,0x01,
  0x06,0x08,0x0F,0x0A,0x05,0x0C,0x03,0x0D,
  0x0B,0x07,0x02,0x0A,0x0B,0x03,0x05,0x0D,
  0x08,0x04,0x00,0x0C,0x06,0x0F,0x0E,0x10,
  0x01,0x09,0x0C,0x0D,0x03,0x00,0x06,0x09,
  0x0A,0x01,0x07,0x08,0x10,0x02,0x0B,0x0E,
  0x04,0x0F,0x05,0x08,0x03,0x04,0x0D,0x06,
  0x05,0x0B,0x10,0x02,0x0C,0x07,0x09,0x0A,
  0x0F,0x0E,0x00,0x01,0x0F,0x02,0x0C,0x0D,
  0x00,0x04,0x01,0x05,0x07,0x03,0x09,0x10,
  0x06,0x0B,0x0A,0x08,0x0E,0x00,0x04,0x0B,
  0x10,0x0F,0x0D,0x0C,0x06,0x05,0x07,0x01,
  0x02,0x03,0x08,0x09,0x0A,0x0E,0x03,0x10,
  0x08,0x07,0x06,0x09,0x0E,0x0D,0x00,0x0A,
  0x0B,0x04,0x05,0x0C,0x02,0x01,0x0F,0x04,
  0x0E,0x10,0x0F,0x05,0x08,0x07,0x0B,0x00,
  0x01,0x06,0x02,0x0C,0x09,0x03,0x0A,0x0D,
  0x06,0x0D,0x0E,0x07,0x10,0x0A,0x0B,0x00,
  0x01,0x0C,0x0F,0x02,0x03,0x08,0x09,0x04,
  0x05,0x0A,0x0C,0x00,0x08,0x09,0x0D,0x03,
  0x04,0x05,0x10,0x0E,0x0F,0x01,0x02,0x0B,
  0x06,0x07,0x05,0x06,0x0C,0x04,0x0D,0x0F,
  0x07,0x0E,0x08,0x01,0x09,0x02,0x10,0x0A,
  0x0B,0x00,0x03,0x0B,0x0F,0x04,0x0E,0x03,
  0x01,0x00,0x02,0x0D,0x0C,0x06,0x07,0x05,
  0x10,0x09,0x08,0x0A,0x03,0x02,0x01,0x00,
  0x04,0x0C,0x0D,0x0B,0x10,0x05,0x06,0x0F,
  0x0E,0x07,0x09,0x0A,0x08,0x09,0x0A,0x00,
  0x07,0x08,0x06,0x10,0x03,0x04,0x01,0x02,
  0x05,0x0B,0x0E,0x0F,0x0D,0x0C,0x0A,0x06,
  0x09,0x0C,0x0B,0x10,0x07,0x08,0x00,0x0F,
  0x03,0x01,0x02,0x05,0x0D,0x0E,0x04,0x0D,
  0x00,0x01,0x0E,0x02,0x03,0x08,0x0B,0x07,
  0x0C,0x09,0x05,0x0A,0x0F,0x04,0x06,0x10,
  0x01,0x0E,0x02,0x03,0x0D,0x0B,0x07,0x00,
  0x08,0x0C,0x09,0x06,0x0F,0x10,0x05,0x0A,
  0x04,0x00
];

function m30Xor(arr, mask){                    // 掩码按 4 字节循环异或
  for(let i = 0; i + 3 < arr.length; i += 4){
    arr[i] ^= mask[0]; arr[i+1] ^= mask[1]; arr[i+2] ^= mask[2]; arr[i+3] ^= mask[3];
  }
}
function omcRearrange(bufEncoded){             // 17 块重排（fuck the person who invented this）
  const length = bufEncoded.length;
  let key = ((length % 17) << 4) + (length % 17);   // = (len%17)*17 + 0，即表里第 (len%17) 行
  const blockSize = Math.floor(length / 17);
  const out = new Uint8Array(bufEncoded);           // 未覆盖的尾巴保持原样
  for(let block = 0; block < 17; block++){
    const src = blockSize * block;
    const dst = blockSize * REARRANGE_TABLE[key];
    const end = Math.min(src + blockSize, length);
    if(end > src && dst + (end - src) <= length) out.set(bufEncoded.subarray(src, end), dst);
    key++;
  }
  return out;
}
function omcXor(buf, state){                   // 滚动 XOR：每 8 字节换一次 keybyte
  let keybyte = state.keybyte, counter = state.counter;
  for(let i = 0; i < buf.length; i++){
    const orig = buf[i];
    if(((keybyte << counter) & 0x80) !== 0) buf[i] = (~orig) & 0xFF;
    counter++;
    if(counter > 7){ counter = 0; keybyte = orig; }   // 原版 acc_keybyte = 加密字节本身
  }
  state.keybyte = keybyte; state.counter = counter;
  return buf;
}
function wavHeaderBytes(h){                    // 对齐 SampleData.WAVHeader.writeHeader
  const b = new Uint8Array(44);
  const dv = new DataView(b.buffer);
  const put = (o, s) => { for(let i=0;i<s.length;i++) b[o+i] = s.charCodeAt(i); };
  put(0,"RIFF"); dv.setUint32(4, (h.chunk_size + 36) >>> 0, true); put(8,"WAVE");
  put(12,"fmt "); dv.setUint32(16, 0x10, true);
  dv.setUint16(20, h.audio_format, true); dv.setUint16(22, h.num_channels, true);
  dv.setUint32(24, h.sample_rate >>> 0, true); dv.setUint32(28, h.bit_rate >>> 0, true);
  dv.setUint16(32, h.block_align, true); dv.setUint16(34, h.bits_per_sample, true);
  put(36,"data"); dv.setUint32(40, h.chunk_size >>> 0, true);
  return b;
}
/** 返回 Map<sampleId, {name, bytes, mime}> */
function parseOjm(buf, decodeText){
  buf = toArrayBuffer(buf);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const samples = new Map();
  const sig = u8.length >= 4 ? dv.getInt32(0, true) : 0;
  const str = (arr) => decodeText(arr).replace(/\0+$/,"");

  if(sig === M30_SIGNATURE){
    const encryptionFlag = dv.getInt32(8, true);
    const sampleCount = dv.getInt32(12, true);
    let p = 28;
    for(let i = 0; i < sampleCount; i++){
      if(u8.length - p < 52) break;
      let name = str(u8.subarray(p, p + 32)); p += 32;
      if(name.lastIndexOf(".") < 0) name += ".ogg";
      const sampleSize = dv.getInt32(p, true); p += 4;
      const codecCode = dv.getInt16(p, true); p += 2;
      /*codecCode2*/ p += 2;
      /*musicFlag*/ p += 4;
      const ref = dv.getInt16(p, true); p += 2;
      /*unkZero*/ p += 2;
      /*pcmSamples*/ p += 4;
      const data = u8.slice(p, p + sampleSize); p += sampleSize;
      if(encryptionFlag === 16) m30Xor(data, MASK_NAMI);
      else if(encryptionFlag === 32) m30Xor(data, MASK_0412);
      let id = ref; if(codecCode === 0) id = 1000 + ref;
      samples.set(id, {name, bytes:data, mime:"audio/ogg"});
    }
    return samples;
  }

  if(sig === OMC_SIGNATURE || sig === OJM_SIGNATURE){
    const decrypt = (sig === OMC_SIGNATURE);
    const wavStart = dv.getInt32(8, true);      // 未使用，仅作记录
    const oggStart = dv.getInt32(12, true);
    const fileSize = dv.getInt32(16, true);
    let p = 20, sampleId = 0;
    const xorState = {keybyte:0xFF, counter:0};  // 跨样本连续
    while(p < oggStart && p + 56 <= u8.length){  // WAV 段（id 0~999）
      let name = str(u8.subarray(p, p + 32)); p += 32;
      if(name.lastIndexOf(".") < 0) name += ".wav";
      const wavH = {
        audio_format:  dv.getUint16(p, true),
        num_channels:  dv.getUint16(p+2, true),
        sample_rate:   dv.getUint32(p+4, true),
        bit_rate:      dv.getUint32(p+8, true),
        block_align:   dv.getUint16(p+12, true),
        bits_per_sample: dv.getUint16(p+14, true),
        data:          dv.getUint32(p+16, true),
        chunk_size:    dv.getUint32(p+20, true),
      };
      p += 24;
      if(wavH.chunk_size === 0){ sampleId++; continue; }
      let data = u8.slice(p, p + wavH.chunk_size); p += wavH.chunk_size;
      if(decrypt){ data = omcRearrange(data); data = omcXor(data, xorState); }
      const head = wavHeaderBytes(wavH);
      const full = new Uint8Array(head.length + data.length);
      full.set(head, 0); full.set(data, head.length);
      samples.set(sampleId, {name, bytes:full, mime:"audio/wav"});
      sampleId++;
    }
    sampleId = 1000;                             // OGG 段（id 1000+）
    while(p < fileSize && p + 36 <= u8.length){
      let name = str(u8.subarray(p, p + 32)); p += 32;
      if(!name.endsWith(".ogg")){
        if(name.lastIndexOf(".") < 0) name += ".ogg";
        else name = name.substring(0, name.lastIndexOf(".")) + ".ogg";
      }
      const sampleSize = dv.getInt32(p, true); p += 4;
      if(sampleSize === 0){ sampleId++; continue; }
      const data = u8.slice(p, p + sampleSize); p += sampleSize;
      samples.set(sampleId, {name, bytes:data, mime:"audio/ogg"});
      sampleId++;
    }
    return samples;
  }
  throw new Error("未知 OJM 签名 0x" + (sig>>>0).toString(16));
}

export { M30_SIGNATURE, MASK_0412, MASK_NAMI, REARRANGE_TABLE, m30Xor, omcRearrange, omcXor, parseOjm, wavHeaderBytes };
