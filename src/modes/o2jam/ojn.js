// OJN 解析（对齐 org.open2jam.parsers.OJNParser）
// 由 o2jam2osu.html 的单文件脚本拆分而来（逻辑未改动；从 @/ 分节 2）

import { GENRES, OJN_SIGNATURE, OJX_MAGIC } from "../../core/util.js";

/* =====================================================================
   2. OJN 解析（对齐 org.open2jam.parsers.OJNParser）
   ===================================================================== */
class OjxError extends Error {}

function toArrayBuffer(x){
  return (x instanceof ArrayBuffer) ? x : x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength);
}
function parseOjnHeader(buf){
  buf = toArrayBuffer(buf);
  const u8 = new Uint8Array(buf, 0, Math.min(buf.byteLength, 300));
  const dv = new DataView(buf);
  if(u8.length >= 4 && OJX_MAGIC.every((b,i) => u8[i] === b)) throw new OjxError("OJX1 加密容器");
  if(u8.length < 300) throw new Error("文件不足 300 字节");
  const sig = dv.getInt32(4, true);
  if(sig !== OJN_SIGNATURE) throw new Error("签名不是 'ojn\\0'（读到 0x" + (sig>>>0).toString(16) + "）");
  const sub = (off,len) => u8.subarray(off, off+len);
  const genreIdx = dv.getInt32(12, true);
  return {
    songid: dv.getInt32(0, true),
    encodeVersion: dv.getFloat32(8, true),
    genre: (genreIdx >= 0 && genreIdx <= 10) ? GENRES[genreIdx] : String(genreIdx),
    genreIdx,
    bpm: dv.getFloat32(16, true),
    levels: [dv.getInt16(20,true), dv.getInt16(22,true), dv.getInt16(24,true)],
    noteCounts: [dv.getInt32(0x28,true), dv.getInt32(0x2C,true), dv.getInt32(0x30,true)],
    durations: [dv.getInt32(0x110,true), dv.getInt32(0x114,true), dv.getInt32(0x118,true)],
    noteOffsets: [dv.getInt32(0x11C,true), dv.getInt32(0x120,true), dv.getInt32(0x124,true)],
    coverSize: dv.getInt32(0x10C, true),
    coverOffset: dv.getInt32(0x128, true),
    rawTitle: sub(0x6C,64), rawArtist: sub(0xAC,32), rawNoter: sub(0xCC,32), rawOjm: sub(0xEC,32),
  };
}

/* ---- 音符块：channel → 事件 ----
/* 对应 Event.Channel 枚举序号：NONE=0，NOTE_1..NOTE_7=1..7，TIME_SIGNATURE=17，
   BPM_CHANGE=18，STOP=19，MEASURE=20，BGA=21，AUTO_PLAY=22 */
const CH_NONE = 0;
const CH_TIME_SIGNATURE = 17;
const CH_BPM_CHANGE = 18;
const CH_STOP = 19;
const CH_MEASURE = 20;
const CH_BGA = 21;
const CH_AUTOPLAY = 22;

function parseOjnEvents(u8, start, end){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const events = [];
  let p = start;
  const endIdx = Math.min(end, u8.byteLength);
  while(p + 8 <= endIdx){
    const measure = dv.getInt32(p, true); p += 4;
    const channelNumber = dv.getInt16(p, true); p += 2;
    const eventsCount = dv.getInt16(p, true); p += 2;

    let channel;                       // 与原版 switch 一致：0=拍号 1=BPM 2..8=NOTE_1..7 其它=AUTO_PLAY
    if(channelNumber === 0) channel = CH_TIME_SIGNATURE;
    else if(channelNumber === 1) channel = CH_BPM_CHANGE;
    else if(channelNumber >= 2 && channelNumber <= 8) channel = channelNumber - 1;  // NOTE_1 = 序号 1
    else channel = CH_AUTOPLAY;

    for(let i = 0; i < eventsCount; i++){
      const position = i / eventsCount;
      if(channel === CH_BPM_CHANGE || channel === CH_TIME_SIGNATURE){
        if(p + 4 > endIdx) return events;
        const v = dv.getFloat32(p, true); p += 4;
        if(v === 0) continue;
        events.push({channel, measure, position, value:v, flag:"NONE", volume:1, pan:0});
      } else {
        if(p + 4 > endIdx) return events;
        const rawValue = dv.getUint16(p, true); p += 2;
        const volumePan = dv.getUint8(p); p += 1;
        const rawType = dv.getUint8(p); p += 1;
        if(rawValue === 0) continue;

        // MIN 1~15 MAX，特殊 0 = MAX
        let volume = ((volumePan >> 4) & 0x0F) / 16; if(volume === 0) volume = 1;
        // 1~8 LEFT，8~15 RIGHT，特殊 0 = 8
        let pan = volumePan & 0x0F; if(pan === 0) pan = 8; pan = (pan - 8) / 8;

        let value = rawValue - 1;                 // 转零基（0 是“忽略”值）
        if(rawType % 8 > 3) value += 1000;        // 高位表示 OGG 样本段（1000+）
        const type = rawType % 4;
        let flag = "NONE";
        if(type === 2) flag = "HOLD";             // autoplay 长音也按 HOLD 处理
        else if(type === 3) flag = "RELEASE";     // type 1 保持 NONE（原版注释：未使用）
        events.push({channel, measure, position, value, flag, volume, pan});
      }
    }
  }
  // 与原版 Event.compareTo 一致：按 measure+position 升序，相等时 STOP 排最后
  events.sort((a,b) => {
    const x = a.measure + a.position, y = b.measure + b.position;
    if(x < y) return -1;
    if(x > y) return 1;
    return a.channel === CH_STOP ? 1 : 0;
  });
  return events;
}

export { CH_AUTOPLAY, CH_BGA, CH_BPM_CHANGE, CH_MEASURE, CH_NONE, CH_STOP, CH_TIME_SIGNATURE,
         OjxError, parseOjnEvents, parseOjnHeader, toArrayBuffer };
