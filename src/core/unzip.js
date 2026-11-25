// ZIP 读取（store / deflate）—— 用于「不解压、不需要解压权限」直接读曲包
//
// 现实痛点：BMS 单曲常以 .zip 分发，一首一首解压很烦，而且不少压缩包所在目录
// 解压还需要管理员权限。这里直接读 ZIP 目录、按需解压单个条目：
//   · 只需要读中央目录（几 KB），样本条目在被真正用到时才解压；
//   · 文件名可能是 UTF-8（有 flag 位）或 Shift-JIS / GBK（老工具打的包）；
//   · 支持 ZIP64（单个条目 >4GB 或条目数 >65535 的包）。
//
// 解压后端：Node 用 zlib.inflateRaw；浏览器用 DecompressionStream('deflate-raw')
// （Chrome/Edge 80+、Safari 16.4+）。没有后端时会明确报错，而不是静默出空数据。

import { detectEncoding, scoreText } from './text.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

const isNode = () => typeof process !== 'undefined' && !!(process.versions && process.versions.node);

/** 内容是不是 ZIP（"PK\x03\x04"；空包是 "PK\x05\x06"） */
export function looksLikeZip(bytes){
  if (!bytes || bytes.length < 4) return false;
  return bytes[0] === 0x50 && bytes[1] === 0x4B &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
}

function decodeWith(bytes, enc){
  try { return new TextDecoder(enc, { fatal: false }).decode(bytes); } catch (e){ return null; }
}

/**
 * 解 ZIP 里的文件名：
 *   ① flag bit 11（0x800）= 官方声明 UTF-8 → 直接 UTF-8；
 *   ② 严格 UTF-8 解得通 → UTF-8（很多工具不置 flag 但确实写的 UTF-8）；
 *   ③ 否则按整包打分在 shift_jis / gb18030 之间选（老工具打的多为这两种）。
 */
function makeNameDecoder(nameBytesList){
  const samples = nameBytesList.filter(b => b.some(x => x >= 0x80));
  let enc = 'utf-8';
  if (samples.length){
    const r = detectEncoding(samples);
    // detectEncoding 平局时偏 gb18030（为 O2Jam 定制的口径）；文件名里若 SJIS 解出的
    // 全是半角片假名那一定是误判，改用 gb18030 之外的选择交给打分本身
    enc = r.encoding;
    if (enc === 'windows-1252') enc = 'shift_jis';
  }
  return (bytes, flags) => {
    if (flags & 0x800) return new TextDecoder('utf-8').decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e){}
    return decodeWith(bytes, enc) || decodeWith(bytes, 'shift_jis') || new TextDecoder('utf-8').decode(bytes);
  };
}

/** 读中央目录；返回 [{name,isDir,encrypted,method,size,compressedSize,localOffset}] */
export function listZipEntries(bytes){
  const u8 = bytes;
  const len = u8.length;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 66000); i--){
    if (dv.getUint32(i, true) === SIG_EOCD){ eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 ZIP（找不到目录结尾）');

  let count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);

  // ZIP64：条目数/偏移是 0xFFFF/0xFFFFFFFF 时走 ZIP64 尾记录
  if (cdOffset === 0xFFFFFFFF || count === 0xFFFF){
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === SIG_EOCD64_LOC){
      const z = Number(dv.getBigUint64(loc + 8, true));
      if (z + 56 <= len && dv.getUint32(z, true) === SIG_EOCD64){
        count = Number(dv.getBigUint64(z + 32, true));
        cdOffset = Number(dv.getBigUint64(z + 48, true));
      }
    }
  }

  // 先收集原始名字字节，统一决定编码
  const raw = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++){
    if (p + 46 > len || dv.getUint32(p, true) !== SIG_CENTRAL) throw new Error('ZIP 中央目录损坏（@' + p + '）');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let compSize = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let localOffset = dv.getUint32(p + 42, true);
    const nameBytes = u8.subarray(p + 46, p + 46 + nameLen);
    const extra = u8.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

    // ZIP64 扩展字段（0x0001）：顺序是 未压缩大小 / 压缩大小 / 本地头偏移
    if (size === 0xFFFFFFFF || compSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF){
      let q = 0;
      while (q + 4 <= extra.length){
        const tag = extra[q] | (extra[q + 1] << 8);
        const sz = extra[q + 2] | (extra[q + 3] << 8);
        if (tag === 0x0001){
          let r = q + 4;
          const rd = () => {
            const v = Number(new DataView(extra.buffer, extra.byteOffset + r, 8).getBigUint64(0, true));
            r += 8; return v;
          };
          if (size === 0xFFFFFFFF) size = rd();
          if (compSize === 0xFFFFFFFF) compSize = rd();
          if (localOffset === 0xFFFFFFFF) localOffset = rd();
          break;
        }
        q += 4 + sz;
      }
    }

    raw.push({ flags, method, compSize, size, localOffset, nameBytes });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const decodeName = makeNameDecoder(raw.map(r => r.nameBytes));
  return raw.map(r => {
    const name = decodeName(r.nameBytes, r.flags).replace(/\\/g, '/');
    return {
      name,
      isDir: /\/$/.test(name),
      encrypted: !!(r.flags & 1),
      method: r.method,
      size: r.size,
      compressedSize: r.compSize,
      localOffset: r.localOffset,
    };
  });
}

async function inflateRaw(u8){
  if (isNode()){
    const zlib = await import('node:zlib');
    return new Uint8Array(zlib.inflateRawSync(u8));
  }
  if (typeof DecompressionStream === 'undefined')
    throw new Error('这个浏览器不支持 DecompressionStream，无法解压 deflate 条目（请换 Chrome/Edge 80+ 或 Safari 16.4+）');
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 读出一个条目的原始字节（store 直接切片，deflate 现解） */
export async function readZipEntry(bytes, entry){
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.localOffset;
  if (dv.getUint32(p, true) !== SIG_LOCAL) throw new Error('ZIP 本地头损坏：' + entry.name);
  const nameLen = dv.getUint16(p + 26, true);
  const extraLen = dv.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw.slice();
  if (entry.method === 8) return await inflateRaw(raw);
  throw new Error('不支持的压缩方式 ' + entry.method + '（' + entry.name + '）');
}

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

/**
 * 把一个 ZIP 摊平成「File 形状」的虚拟文件（懒解压：只有 arrayBuffer() 被调用才解）。
 * prefix 会拼在 webkitRelativePath 前面，用来区分不同压缩包里的同名目录。
 */
export function expandZip(bytes, prefix, opts = {}){
  const entries = listZipEntries(bytes);
  const files = [];
  const warnings = [];
  let n = 0;
  for (const e of entries){
    if (e.isDir) continue;
    if (++n > (opts.maxEntries || 20000)){
      warnings.push(prefix + '：条目超过 ' + (opts.maxEntries || 20000) + ' 个，剩下的忽略');
      break;
    }
    if (e.encrypted){ warnings.push(prefix + '/' + e.name + ' 加密条目，跳过'); continue; }
    const path = e.name.replace(/^\/+/, '');
    files.push({
      name: baseName(path),
      webkitRelativePath: prefix + '/' + path,
      size: e.size,
      fromZip: prefix,
      arrayBuffer: async () => {
        const u8 = await readZipEntry(bytes, e);
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      },
    });
  }
  return { files, warnings };
}

/** 一批「File 形状」里遇到 .zip 就地摊平（浏览器拖入 / 命令行扫描都走这里） */
export async function expandArchives(files, opts = {}){
  const out = [];
  const warnings = [];
  const archives = [];
  for (const f of files){
    const name = f.name || '';
    if (!/\.zip$/i.test(name)){ out.push(f); continue; }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (!looksLikeZip(bytes)){
        warnings.push(name + ' 不是有效的 ZIP，按普通文件忽略');
        continue;
      }
      const raw = String(f.webkitRelativePath || f.name).replace(/\\/g, '/');
      const prefix = raw.replace(/\.zip$/i, '');
      const r = expandZip(bytes, prefix, opts);
      out.push(...r.files);
      warnings.push(...r.warnings);
      archives.push({ name, prefix, files: r.files.length, bytes: bytes.length });
    } catch (e){
      warnings.push(name + ' 解不开：' + e.message + '（按普通文件忽略）');
    }
  }
  return { files: out, warnings, archives };
}
