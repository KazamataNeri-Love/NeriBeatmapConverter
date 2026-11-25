// 探针：验证 ffmpeg 批量解码样本能否把「每样本一次进程启动」的开销摊掉。
// 结论决定了 tools/lib/ffmpeg.js 的设计（单条 vs 批量 -i/-map）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseOjm } from '../src/modes/o2jam/ojm.js';
import { parseOjnHeader } from '../src/modes/o2jam/ojn.js';
import { detectEncoding, makeTextDecoder } from '../src/core/text.js';

const FF = process.env.FFMPEG || 'ffmpeg';
const RATE = 44100;
const ojn = process.argv[2] || 'OfficialBeatmaps/o2ma100.ojn';
const ojm = ojn.replace(/\.ojn$/i, '.ojm');

const run = (args, opts = {}) => new Promise((res, rej) => {
  const t0 = Date.now();
  execFile(FF, args, { maxBuffer: 1 << 30, ...opts }, (err, stdout, stderr) =>
    err ? rej(new Error(err.message + '\n' + stderr)) : res({ ms: Date.now() - t0, stdout, stderr }));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ojn-batch-'));
try {
  const hdr = parseOjnHeader(fs.readFileSync(ojn));
  const dec = makeTextDecoder(detectEncoding([hdr.rawTitle, hdr.rawArtist, hdr.rawNoter]).encoding);
  const samples = parseOjm(fs.readFileSync(ojm), dec);
  const items = [...samples.entries()].map(([id, s]) => ({ id, ext: s.mime === 'audio/wav' ? 'wav' : 'ogg', bytes: s.bytes }))
    .filter(x => x.bytes.length > 44);
  const totalMb = items.reduce((a, x) => a + x.bytes.length, 0) / 1048576;
  console.log(`${path.basename(ojn)}：样本 ${items.length} 个 / ${totalMb.toFixed(1)} MB`);

  // 落盘（两种方案都要写输入文件）
  const tWrite = Date.now();
  for (const it of items) fs.writeFileSync(path.join(tmp, `s${it.id}.${it.ext}`), it.bytes);
  console.log(`写入输入文件 ${Date.now() - tWrite}ms\n`);

  // ---- A. 每样本一次 ffmpeg ----
  if (process.argv.includes('--single')) {
    const t0 = Date.now(); let ok = 0;
    for (const it of items) {
      const out = path.join(tmp, `o${it.id}.raw`);
      try { await run(['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', path.join(tmp, `s${it.id}.${it.ext}`),
                       '-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-y', out]); ok++; } catch {}
    }
    const ms = Date.now() - t0;
    console.log(`A. 每样本一次进程    ：${ms}ms（成功 ${ok}/${items.length}，${(ms / items.length).toFixed(1)}ms/样本）`);
  }

  // ---- B. 批量：一次 ffmpeg、N 个输入 → N 个输出 ----
  for (const B of [16, 48, 128]) {
    const t0 = Date.now(); let spawns = 0, ok = 0, bad = [];
    for (let i = 0; i < items.length; i += B) {
      const chunk = items.slice(i, i + B);
      const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
      for (const it of chunk) args.push('-i', path.join(tmp, `s${it.id}.${it.ext}`));
      chunk.forEach((it, k) => {
        args.push('-map', `${k}:a`, '-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-y', path.join(tmp, `o${it.id}.raw`));
      });
      spawns++;
      try { await run(args); ok += chunk.length; }
      catch { bad.push(chunk.map(c => c.id).join('+')); }
    }
    const ms = Date.now() - t0;
    console.log(`B. 批量=${String(B).padEnd(3)}（${spawns} 次进程）：${ms}ms（成功 ${ok}/${items.length}，${(ms / items.length).toFixed(1)}ms/样本）`
      + (bad.length ? `\n   整批失败 ${bad.length} 批：${bad.slice(0, 3).join(' | ')}` : ''));
    // 清理输出
    for (const it of items) { try { fs.unlinkSync(path.join(tmp, `o${it.id}.raw`)); } catch {} }
  }

  // ---- C. 全量一批 ----
  const t0 = Date.now();
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  for (const it of items) args.push('-i', path.join(tmp, `s${it.id}.${it.ext}`));
  items.forEach((it, k) => {
    args.push('-map', `${k}:a`, '-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-y', path.join(tmp, `o${it.id}.raw`));
  });
  try {
    await run(args, { maxBuffer: 1 << 28 });
    console.log(`C. 一次全解（1 次进程）  ：${Date.now() - t0}ms（${items.length} 个样本，${((Date.now() - t0) / items.length).toFixed(1)}ms/样本）`);
  } catch (e) { console.log(`C. 一次全解失败（命令行太长/单条坏样本连带全废）：${String(e.message).slice(0, 160)}`); }

  // 抽查一个输出是否合理
  const probe = items[0];
  const p = path.join(tmp, `o${probe.id}.raw`);
  if (fs.existsSync(p)) console.log(`\n抽查 id=${probe.id}：raw ${fs.statSync(p).size} 字节 → ${(fs.statSync(p).size / 8 / RATE).toFixed(2)} 秒`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
