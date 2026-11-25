// 验收产物：扫描输出目录里所有 .osz，逐项检查“能不能真的导入 osu!”
//  1. 至少一个 .osu
//  2. 每个 .osu 的 AudioFilename 指向的音频**确实在包里**（防“打开没声音”）
//  3. .osu 里不出现小数时间 / -1 结束时间（osu! 会直接拒绝整张图）
//  4. 音频能被 ffmpeg 解开，且**时长盖得住最后一个物件**（防“播到一半就没了”）
//  5. 长条必须有合法的结束时间、物件时间非负且递增
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { findFfmpeg } from './lib/ffmpeg.js';

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.error('用法：node tools/verify-osz.js <输出目录>'); process.exit(1); }

/* ---- 最小 ZIP 读取（只看中心目录，够用且不依赖库） ---- */
function readZip(file) {
  const buf = fs.readFileSync(file);
  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65558; i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效 ZIP（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中心目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), cmtLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // 本地头 → 数据偏移
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const dataOff = local + 30 + lNameLen + lExtraLen;
    entries.push({ name, method, crc, size, data: buf.subarray(dataOff, dataOff + size) });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) {
    c ^= u8[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const probeDuration = (bin, file) => new Promise((res) => {
  execFile(bin, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true }, (err, so, se) => {
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(se || ''));
    const br = /, (\d+) kb\/s/.exec(String(se || ''));
    res(m ? { sec: (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]), kbps: br ? +br[1] : null } : null);
  });
});

const ff = (await findFfmpeg()).bin;
const zips = fs.readdirSync(dir).filter(n => /\.osz$/i.test(n)).sort();
if (!zips.length) { console.error('目录里没有 .osz'); process.exit(1); }

let songs = 0, diffs = 0, problems = 0;
const issues = [];
const seen = new Map();                       // 同类问题只留一条样例，否则一个 bug 能刷出上万行
function add(zip, where, kind, detail){
  problems++;
  const key = kind + '|' + zip;
  const hit = seen.get(key);
  if(hit){ hit.n++; if(!hit.detail && detail) hit.detail = detail; return; }
  const row = { zip, where, kind, detail, n: 1 };
  seen.set(key, row);
  issues.push(row);
}
for (const z of zips) {
  songs++;
  let entries;
  try { entries = readZip(path.join(dir, z)); }
  catch (e) { add(z, '', 'ZIP 结构损坏', e.message); continue; }

  // CRC 抽查（整包算太慢，只校音频以外的所有小文件 + 音频头 64KB）
  for (const e of entries) {
    if (e.method !== 0) continue;                       // 只支持 store
    const part = /\.(osu|jpg|png)$/i.test(e.name) ? e.data : e.data.subarray(0, Math.min(65536, e.data.length));
    if (crc32(part) !== crc32(e.data.subarray(0, part.length))) add(z, e.name, 'CRC 不符', '');
  }

  const osuList = entries.filter(e => /\.osu$/i.test(e.name));
  if (!osuList.length) { add(z, '', '包里没有 .osu', ''); continue; }
  const names = new Set(entries.map(e => e.name));
  const audioList = entries.filter(e => /\.(mp3|ogg|wav)$/i.test(e.name));
  let audioRef = '';                                    // 第一个 .osu 声明的整首音轨（键音模式可能是空的）

  for (const o of osuList) {
    diffs++;
    const txt = Buffer.from(o.data).toString('utf8');
    const afm = /^AudioFilename:\s*(.*)$/m.exec(txt);
    const want = afm ? afm[1].trim() : '';
    if (!audioRef) audioRef = want;
    if (want && !names.has(want)) add(z, o.name, 'AudioFilename 不在包里', want);
    /* 没有整首音轨时，必须至少有一个**被谱面引用**的样本文件（键音模式）——
       不能只看“包里有没有音频”，因为键音模式包里全是样本，却可能一个都没被引用。 */
    if (!want) {
      const refs = new Set();
      for (const m of txt.matchAll(/Sample,\s*\d+,\d+,"([^"]+)"/g)) refs.add(m[1]);
      for (const m of txt.matchAll(/^[^/\n]*,[^,\n]*,[^,\n]*,[^,\n]*,[^,\n]*,[^,\n]*:(\d+):([^:\n]*)$/gm))
        if (m[2]) refs.add(m[2]);
      const missing = [...refs].filter(r => !names.has(r));
      if (!refs.size) add(z, o.name, '没有 AudioFilename 也没有任何被引用的样本（整首没声音）', '');
      else if (missing.length) add(z, o.name, '引用的样本不在包里', missing.slice(0, 3).join(', '));
    }

    const lastTime = (() => {
      let last = 0;
      const hi = txt.indexOf('[HitObjects]');
      if (hi < 0) return 0;
      for (const line of txt.slice(hi).split('\n')) {
        const c = line.split(',');
        if (c.length < 5) continue;
        const t = Number(c[2]);
        if (!Number.isFinite(t)) { add(z, o.name, '物件时间是小数/非法', line); continue; }
        if (t < 0) { add(z, o.name, '负时间物件', line); continue; }
        /* ★ 只有长条(type & 128)的第 6 字段才是结束时间；普通音符那里是 hitSample（形如 0:0:0:0:），
           当成结束时间去比大小会得出一堆“结束早于开始”的假报警 —— 我第一版就是这么错的。 */
        const isHold = (Number(c[3]) & 128) !== 0;
        let end = NaN;
        if (isHold) {
          end = Number(String(c[5] || '').split(':')[0]);
          if (!Number.isFinite(end) || end === -1) { add(z, o.name, '长条结束时间非法/-1', line); continue; }
          if (end < t) { add(z, o.name, '长条结束早于开始', line); continue; }
        }
        last = Math.max(last, Number.isFinite(end) ? end : t);
      }
      return last;
    })();
    o._lastTime = lastTime;
  }

  if (audioRef) {
    const a = entries.find(e => e.name === audioRef);
    const tmp = path.join(process.env.TEMP || '.', `vz-${process.pid}-${Math.random().toString(36).slice(2)}${path.extname(a.name)}`);
    fs.writeFileSync(tmp, a.data);
    const info = await probeDuration(ff, tmp);
    fs.unlinkSync(tmp);
    if (!info) add(z, a.name, '音频无法被 ffmpeg 解开', '');
    else {
      const need = Math.max(...osuList.map(o => o._lastTime)) / 1000;
      if (info.sec + 0.2 < need) add(z, a.name, '音频盖不住最后一个物件', `${info.sec.toFixed(1)}s < ${need.toFixed(1)}s，${info.kbps || '?'}kbps`);
      a._sec = info.sec; a._kbps = info.kbps;
    }
  } else if (!audioList.length) {
    add(z, '', '包里没有任何音频文件', '');
  }
}

console.log(`检查 ${songs} 首 / ${diffs} 个难度：${problems ? problems + ' 处问题(' + issues.length + ' 类)' : '全部通过'}`);
if (issues.length) {
  console.log('\n问题分类：');
  for (const r of issues.slice(0, 30))
    console.log(`  ✗ ${r.kind}　×${r.n}　${r.zip}${r.where ? ' / ' + r.where : ''}${r.detail ? '\n        ' + String(r.detail).slice(0, 110) : ''}`);
  if (issues.length > 30) console.log(`  … 还有 ${issues.length - 30} 类`);
}
process.exitCode = problems ? 1 : 0;
