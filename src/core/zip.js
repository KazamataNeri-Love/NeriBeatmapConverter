// ZIP（store，无压缩）—— 用于打包 .osz
// 由 o2jam2osu.html 的单文件脚本拆分而来（逻辑未改动；从 @/ 分节 6）

/* =====================================================================
   6. ZIP（store，无压缩）—— 用于打包 .osz
   ===================================================================== */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for(let n = 0; n < 256; n++){ let c = n; for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(u8){
  let c = 0xFFFFFFFF;
  for(let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/** 把一批文件编成 ZIP 的各段字节（不拼接：交给 Blob 一次吃下，省掉一整份同等大小的内存拷贝） */
function makeZipChunks(files, date = new Date()){
  assertUniqueNames(files);
  const all = [];
  for(const a of _buildZipParts(files, date)) all.push(a);
  return all;
}
/**
 * 重名条目必须当场报错，绝不能产出坏包：
 * osu! 的 ZipArchiveReader.GetStream 用 SingleOrDefault 找条目，重名会抛
 * "Sequence contains more than one matching element"，导入直接失败（且日志只说 Model creation failed）。
 * 真实踩过的例子：一首歌的 SP 与 DP 版本共用同一个 #DIFFICULTY（都是 ANOTHER），
 * 生成的 .osu 同名 → zip 里两条同名条目。
 */
function assertUniqueNames(files){
  const seen = new Map();
  for(const f of files){
    const k = String(f.name).toLowerCase();
    if(seen.has(k))
      throw new Error('ZIP 里有重名条目："' + f.name + '"（osu! 会拒绝导入：Sequence contains more than one matching element）');
    seen.set(k, 1);
  }
}
/** 兼容写法：拼成单个 Uint8Array（Node 测试与需要整块时用） */
function makeZip(files, date = new Date()){
  const parts = makeZipChunks(files, date);
  const total = parts.reduce((a,b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for(const a of parts){ out.set(a, p); p += a.length; }
  return out;
}

function* _buildZipParts(files, date){
  const enc = new TextEncoder();
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2))) & 0xFFFF;
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF;
  const parts = [], central = [];
  let offset = 0;
  for(const f of files){
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true); lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, f.data.length, true); lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, f.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, f.data.length, true); cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length + f.data.length;
  }
  const cdSize = central.reduce((a,b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  for(const a of parts) yield a;
  for(const a of central) yield a;
  yield end;
}

export { CRC_TABLE, crc32, makeZip, makeZipChunks };
