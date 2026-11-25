#!/usr/bin/env node
// O2Jam → osu! 批量转换命令行（Node + 系统 ffmpeg）
//
// 与浏览器版共用同一套解析/转换/混音/打包代码（src/*），只是把两条慢路径换成 ffmpeg：
//   样本解码：一次 ffmpeg 进程批量解几十个（逐个 decodeAudioData 要 55ms/样本，批量 ~7ms/样本）
//   MP3 编码：libmp3lame 替代 lamejs（纯 JS），快约两个数量级
//
// 典型用法：
//   node tools/cli.js --in ..\OfficialBeatmaps --out ..\osz --jobs 6
//   node tools/cli.js --in <dir> --diffs hx --format keysound
//   node tools/cli.js --in <dir> --limit 5 --verbose      # 试跑 5 首，看每步日志
//
// 说明：--audio 默认 shared（三难度共用一份混音），浏览器版默认 per-diff；
//       批量转整库时 shared 省 2/3 的混音/编码时间与体积。要完全对齐浏览器版就显式加 --audio per-diff。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { parseOjnHeader } from '../src/modes/o2jam/ojn.js';
import { parseOjm } from '../src/modes/o2jam/ojm.js';
import { detectEncoding, makeTextDecoder } from '../src/core/text.js';
import { convertOneSong } from '../src/modes/o2jam/pipeline.js';
import { prepareSong, groupFiles } from '../src/modes/bms/song.js';
import { convertBmsSong } from '../src/modes/bms/pipeline.js';
import { expandZip, looksLikeZip } from '../src/core/unzip.js';
import { extractArchive, findExtractor } from './lib/archives.js';
import { makeZip } from '../src/core/zip.js';
import { DIFFS, sanitizeFilename, setLogSink } from '../src/core/util.js';
import { AUDIO_FORMATS, formatById, MP3_SAMPLE_RATES } from '../src/core/encoders/index.js';
import { findFfmpeg, hasEncoder, createFfmpegAudioContext, registerFfmpegEncoders, ffmpegStats } from './lib/ffmpeg.js';

/* ================================================================== 参数 */

const USAGE = `
SeriousBeatmapConverter —— 音游谱面 → osu! mania 批量转换（Node + 系统 ffmpeg）

用法
  node tools/cli.js [模式] --in <dir> --out <dir> [选项]
  [模式] = o2jam（默认，.ojn/.ojm）| bms（.bms/.bme/.bml/.bmx）| auto（按扩展名分派）
  老命令（不带模式）等价于 auto：输入里只有 .ojn 就只跑 O2Jam，只有 .bms 就只跑 BMS。

输入输出
  --in <dir>            输入目录（递归扫描）*** 必填 ***
                        压缩包可直接读：.zip 在内存里摊平；.rar/.7z 调用 7-Zip/UnRAR 解到临时目录
                        （都只读源包，不需要在旁边写文件；可用环境变量 SBC_7Z 指定 7z.exe）
  --out <dir>           输出目录（默认 <in>/../O2Jam-osz 或 BMS-osz）
  --no-zip              不打包 .osz，改成输出同名文件夹（方便直接看内容）
  --skip-existing       已存在同名 .osz 就跳过（断点续跑）
  --limit <n>           只转前 n 首（配合 --verbose 试跑）
  --filter <regex>      只转文件名匹配的（不区分大小写）
  --jobs <n>            并行曲目数（默认 ${Math.max(1, Math.min(6, (os.cpus().length || 4) - 1))}；ffmpeg 本身也吃多核，开太多反而慢）

O2Jam 模式（.ojn/.ojm）
  --diffs <list>        all | hx | ex,nx,hx | ex …（默认 all）
  --sv                  保留 SV 变速（默认关）
  --suffix <mode>       auto | all | none（难度后缀，默认 auto 与原版一致）
  --no-repair           关闭异常 Note 自动修复（默认开）
  --ln-max-beats <n>    超长面条压到 n 拍（默认 0=关）
  --no-fallback         关闭样本 id 兜底（±1000 / 单主音频，默认开）

BMS 模式（.bms/.bme/.bml/.bmx）
  --plate <mode>        column（皿占一列：1P 最左 / 2P 最右，默认，旧名 8k）| sample | drop
  --keys <k>            auto（默认，按通道猜）| 5k | 5k1s | 7k | 7k1s | 10k | 10k2s | 14k | 14k2s
  --no-stop             不把 STOP 计入时间轴（默认计入）
  --random <n>          #RANDOM 取第 n 支（默认 1 = 第一支）

通用谱面选项
  --od <n> / --auto-od  OD 固定值 / 按等级推导（默认按等级）
  --hp <n>              HP（默认 8.2）
  --server <tag>        服务器标记，如 [国服]（默认空）
  --tags <mode>         keep | append | replace（默认 keep）
  --template <text>     自定义 tag 内容，占位符 {noter} {songid} {server} {title} {artist} {diff} {level} {file}

音频
  --format <id>         ${AUDIO_FORMATS.map(f => f.id).join(' | ')} | keysound | none（默认 mp3）
                         （--format keysound 等价于 --audio keysound）
  --audio <mode>        shared | per-diff | keysound | none（默认 shared）
  --kbps <n>            MP3 码率（默认 320）
  --rate <n>            采样率（默认 44100）
  --no-normalize        关闭峰值归一化（默认开；关了密集键音会削波）

ffmpeg
  --ffmpeg <path>       ffmpeg 可执行文件路径（默认自动找 PATH / $FFMPEG）
  --decode-batch <n>    每次 ffmpeg 解几个样本（默认按命令行长度自动算，约 100~128）
  --sample-cache <mb>   跨曲目复用的解码缓存（默认 256，0=关）

输出/日志
  --report <file>       JSON 报告（默认 <out>/_report.json，加 --no-report 关闭）
  --verbose             打印每首的逐行日志
  --quiet               只打印最终汇总
  -h, --help            看这份帮助

例：
  node tools/cli.js --in ..\\OfficialBeatmaps --out ..\\osz --jobs 6
  node tools/cli.js bms --in "D:\\BMS" --out ..\\bms-osz --format keysound
  node tools/cli.js auto --in ..\\Packs --limit 3 --verbose --no-zip
`;

const ALIAS = { h: 'help', '?': 'help' };
function parseArgs(argv){
  const o = { _: [], diffs: 'all', audio: 'shared', format: 'mp3', kbps: 320, rate: 44100,
              hp: 8.2, suffix: 'auto', tags: 'keep', jobs: Math.max(1, Math.min(6, (os.cpus().length || 4) - 1)),
              sampleCache: 256, decodeBatch: 0, report: true, verbose: false, quiet: false, zip: true,
              repair: true, normalize: true, fallback: true, sv: false, lnMaxBeats: 0,
              plate: 'column', keys: 'auto', stops: true, random: 1 };
  const need = (k, i) => {
    if(i + 1 >= argv.length) throw new Error(`--${k} 后面要跟一个值`);
    return argv[i + 1];
  };
  for(let i = 0; i < argv.length; i++){
    let a = argv[i];
    if(!a.startsWith('--') && a !== '-h' && a !== '-?'){ o._.push(a); continue; }
    const neg = a.startsWith('--no-');
    const key = (neg ? a.slice(5) : a.replace(/^--?/, ''));
    const k = ALIAS[key] || key;
    if(neg){
      if(['zip', 'repair', 'normalize', 'fallback', 'report'].includes(k)){ o[k] = false; continue; }
      if(k === 'stop'){ o.stops = false; continue; }
      throw new Error(`不认识的反向开关：--no-${k}`);
    }
    if(k === 'help'){ o.help = true; continue; }
    if(['sv', 'verbose', 'quiet', 'skip-existing', 'auto-od'].includes(k)){ o[k] = true; continue; }
    const v = need(k, i); i++;
    switch(k){
      case 'in': case 'out': case 'filter': case 'report': o[k] = v; break;
      case 'ffmpeg': o.ffmpeg = v; break;
      case 'diffs': parseDiffs(v); o.diffs = v; break;          // 立即校验：写错了当场报，不要转到一半才失败
      case 'audio':
        if(!['shared', 'per-diff', 'keysound', 'none'].includes(v))
          throw new Error(`--audio 只能是 shared / per-diff / keysound / none（收到 "${v}"）`);
        o.audio = v; break;
      case 'format': o.format = v; break;
      case 'suffix': o.suffix = v; break;
      case 'tags': o.tags = v; break;
      case 'template': o.template = v; break;
      case 'server': o.server = v; break;
      case 'od': o.od = parseFloat(v); break;
      case 'hp': o.hp = parseFloat(v); break;
      case 'kbps': o.kbps = parseInt(v, 10); break;
      case 'rate': o.rate = parseInt(v, 10); break;
      case 'plate': {
        const norm = v === '8k' ? 'column' : v;      // 旧写法 8k 等价于「占一列」
        if(!['column', 'sample', 'drop'].includes(norm))
          throw new Error(`--plate 只能是 column(8k) / sample / drop（收到 "${v}"）`);
        o.plate = norm; break;
      }
      case 'keys': {
        const NAMED = { '5k': 5, '5k1s': 6, '7k': 7, '7k1s': 8, '10k': 10, '10k2s': 12, '14k': 14, '14k2s': 16 };
        const raw = String(v).toLowerCase();
        if(raw === 'auto'){ o.keys = 'auto'; break; }
        const n = NAMED[raw] !== undefined ? NAMED[raw] : Number(raw);
        if(![5, 6, 7, 8, 10, 12, 14, 16].includes(n))
          throw new Error(`--keys 只能是 auto / 5k / 5k1s / 7k / 7k1s / 10k / 10k2s / 14k / 14k2s（收到 "${v}"）`);
        o.keys = String(n); break;
      }
      case 'random': o.random = Math.max(1, parseInt(v, 10) || 1); break;
      case 'jobs': o.jobs = Math.max(1, parseInt(v, 10) || 1); break;
      case 'limit': o.limit = parseInt(v, 10); break;
      case 'ln-max-beats': o.lnMaxBeats = parseFloat(v) || 0; break;
      case 'sample-cache': o.sampleCache = parseFloat(v) || 0; break;
      case 'decode-batch': o.decodeBatch = parseInt(v, 10) || 0; break;
      default: throw new Error(`不认识的参数：--${k}`);
    }
  }
  return o;
}

/* ================================================================== 小工具 */

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const fmtMs = (ms) => ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's';
/** 中日韩字符占两列，用它对齐进度输出（否则中文曲名会把后面冲得乱七八糟） */
function padDisplay(s, width){
  s = String(s);
  let w = 0;
  for(const ch of s) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - w));
}
const parseDiffs = (s) => {
  const t = String(s).toLowerCase().trim();
  const map = { ex: 0, nx: 1, hx: 2, 0: 0, 1: 1, 2: 2 };
  if(t === 'all') return [0, 1, 2];
  const out = [];
  for(const part of t.split(/[,\s]+/).filter(Boolean)){
    if(!(part in map)) throw new Error(`--diffs 不认识 "${part}"（可用 all / hx / ex,nx,hx）`);
    if(!out.includes(map[part])) out.push(map[part]);
  }
  if(!out.length) throw new Error('--diffs 一个难度都没选中');
  return out.sort();
};

/** 递归找文件（不跟符号链接，避免环） */
function walk(dir, test, out = []){
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch(e){ return out; }
  for(const e of ents){
    const p = path.join(dir, e.name);
    if(e.isDirectory()) walk(p, test, out);
    else if(e.isFile() && test(e.name)) out.push(p);
  }
  return out;
}

/** 找配套 .ojm：同名优先，否则同目录里唯一同名不同大小写；找不到返回 null */
function findOjm(ojnPath){
  const base = ojnPath.replace(/\.ojn$/i, '');
  for(const ext of ['.ojm', '.OJM']){
    if(fs.existsSync(base + ext)) return base + ext;
  }
  const dir = path.dirname(ojnPath);
  const want = path.basename(base).toLowerCase();
  try {
    const hit = fs.readdirSync(dir).find(n => /\.ojm$/i.test(n) && n.replace(/\.ojm$/i, '').toLowerCase() === want);
    if(hit) return path.join(dir, hit);
  } catch(e){}
  return null;
}

/* ================================================================== 单曲 */

const als = new AsyncLocalStorage();
setLogSink((msg, cls) => {
  const store = als.getStore();
  if(store){ store.push({ cls, msg }); return; }
  if(cls === 'e') console.error(msg);
});

/** 把磁盘上的 .ojn/.ojm 包成 pipeline 期望的 song 对象（与浏览器拖入时形状一致） */
function loadSong(ojnPath, ojmPath){
  const ojnBuf = fs.readFileSync(ojnPath);
  const header = parseOjnHeader(ojnBuf);
  const dec = makeTextDecoder(detectEncoding([header.rawTitle, header.rawArtist, header.rawNoter]).encoding);
  let samples = new Map();
  let ojmError = null;
  if(ojmPath){
    try { samples = parseOjm(fs.readFileSync(ojmPath), dec); }
    catch(e){ ojmError = e.message; }
  }
  const ab = ojnBuf.buffer.slice(ojnBuf.byteOffset, ojnBuf.byteOffset + ojnBuf.length);
  return {
    ojnPath, ojmPath, header, ojmError,
    title: dec(header.rawTitle), artist: dec(header.rawArtist), noter: dec(header.rawNoter),
    song: {
      ojnFile: { name: path.basename(ojnPath), arrayBuffer: async () => ab },
      ojmFile: ojmPath ? { name: path.basename(ojmPath) } : null,
      decode: dec, samples,
    },
  };
}

async function convertSong(meta, opts, audioCtx){
  const logs = [];
  let out, err = null;
  const t0 = performance.now();
  await als.run(logs, async () => {
    try { out = await convertOneSong(meta.song, opts, audioCtx, null); }
    catch(e){ err = e; out = { files: [], warnings: [] }; }
  });
  const ms = performance.now() - t0;
  return { out, err, logs, ms };
}

/* ================================================================== 主流程 */

const audioFormatIds = AUDIO_FORMATS.map(f => f.id).join(' / ');

async function runO2Jam(o){
  if(o.help || !o.in){ console.log(USAGE.trim()); process.exit(o.in ? 0 : 1); }

  /* Ctrl-C：把 ffmpeg 留下的临时文件清掉（不然一次中断会在 %TEMP% 里留几百 MB 的 raw） */
  const ctxRef = { ctx: null };
  process.on('SIGINT', () => {
    console.log('\n已中断，清理临时文件…');
    if(ctxRef.ctx) ctxRef.ctx.dispose();
    process.exit(130);
  });

  const inDir = path.resolve(o.in);
  if(!fs.existsSync(inDir)) throw new Error('输入目录不存在：' + inDir);
  const outDir = path.resolve(o.out || path.join(inDir, '..', 'O2Jam-osz'));
  fs.mkdirSync(outDir, { recursive: true });

  // --format keysound / none 是 --audio 的简写
  let audioFormat = o.format, audioMode = o.audio;
  if(audioFormat === 'keysound'){ audioMode = 'keysound'; audioFormat = 'wav'; }
  else if(audioFormat === 'none'){ audioMode = 'none'; audioFormat = 'wav'; }
  if(audioMode === 'keysound' || audioMode === 'none') audioFormat = 'wav';   // 这两种模式不产音频
  const fmt = formatById(audioFormat);
  if(fmt.id !== audioFormat) throw new Error(`--format 不认识 "${audioFormat}"（可用 ${audioFormatIds} / keysound / none）`);
  if(fmt.id === 'mp3' && !MP3_SAMPLE_RATES.includes(o.rate))
    throw new Error(`MP3 不支持 ${o.rate}Hz，请改 --rate（可用 ${MP3_SAMPLE_RATES.join('/')}）`);
  const diffs = parseDiffs(o.diffs);

  const needAudio = audioMode !== 'none' && audioMode !== 'keysound';
  let ffmpegInfo = null;
  if(needAudio){
    ffmpegInfo = await findFfmpeg(o.ffmpeg);
    for(const need of [fmt.id === 'mp3' ? 'libmp3lame' : fmt.id === 'ogg' ? 'libvorbis' : null].filter(Boolean))
      if(!await hasEncoder(ffmpegInfo.bin, need))
        throw new Error(`这个 ffmpeg 没有 ${need} 编码器：${ffmpegInfo.version}\n换一个完整构建（如 gyan.dev / BtbN 的 full build）。`);
    registerFfmpegEncoders({ ffmpeg: ffmpegInfo.bin });
  }

  // ---- 扫描 ----
  const inIsFile = fs.statSync(inDir).isFile();
  let files = inIsFile
    ? (/\.ojn$/i.test(inDir) ? [inDir] : [])
    : walk(inDir, n => /\.ojn$/i.test(n)).sort();
  const inRoot = inIsFile ? path.dirname(inDir) : inDir;

  // .zip / .rar / .7z 里的 .ojn/.ojm：解到系统临时目录再走原流程。
  // （BMS 是整包内存直读；O2Jam 这边沿用「按路径读文件」的老实现，临时目录用户可写，不需要对源目录有解压权限）
  const tempRoots = [];
  if(!inIsFile){
    const archivesFound = walk(inDir, n => /\.(zip|rar|7z)$/i.test(n));
    if(archivesFound.length){
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbc-ojn-'));
      tempRoots.push(tmp);
      let got = 0, failed = 0, usedExtractor = null;
      for(const zp of archivesFound){
        const rel = path.relative(inRoot, zp).split(path.sep).join('/').replace(/\.(zip|rar|7z)$/i, '');
        try {
          if(/\.zip$/i.test(zp)){
            const buf = fs.readFileSync(zp);
            const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
            if(!looksLikeZip(u8)){ failed++; continue; }
            const r = expandZip(u8, rel);
            for(const f of r.files){
              if(!/\.(ojn|ojm)$/i.test(f.name)) continue;
              const dest = path.join(tmp, ...f.webkitRelativePath.split('/'));
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, Buffer.from(await f.arrayBuffer()));
              got++;
            }
          } else {
            const ex = usedExtractor || (usedExtractor = findExtractor());
            if(!ex) throw new Error('没找到 7-Zip / UnRAR（装一个，或用环境变量 SBC_7Z 指定）');
            const dest = path.join(tmp, ...rel.split('/'));
            await extractArchive(ex, zp, dest);
            got += walk(dest, n => /\.(ojn|ojm)$/i.test(n)).length;
          }
        } catch(e){
          console.log(`  ⚠ ${path.basename(zp)} 解不开：${e.message}`);
          failed++;
        }
      }
      if(got) console.log(`  压缩包 ${archivesFound.length} 个里取到 ${got} 个 .ojn/.ojm${failed ? `（${failed} 个包失败）` : ''}`);
      files = files.concat(walk(tmp, n => /\.ojn$/i.test(n))).sort();
    }
  }

  if(o.filter){
    let re; try { re = new RegExp(o.filter, 'i'); } catch(e){ throw new Error('--filter 不是合法正则：' + e.message); }
    files = files.filter(f => re.test(path.basename(f)));
  }
  if(o.limit) files = files.slice(0, o.limit);
  if(!files.length) throw new Error('没找到 .ojn 文件（压缩包里也没有）：' + inDir);

  console.log(`O2Jam → osu! 批量转换`);
  console.log(`  输入    ${inDir}（${files.length} 个 .ojn）`);
  console.log(`  输出    ${outDir}`);
  console.log(`  难度    ${diffs.map(i => DIFFS[i].name).join(' / ')}　音频 ${audioMode}${needAudio ? ' / ' + fmt.id.toUpperCase() + (fmt.id === 'mp3' ? '@' + o.kbps + 'k' : '') : ''}　${o.rate}Hz`);
  console.log(`  并行    ${o.jobs} 首${ffmpegInfo ? '　ffmpeg ' + ffmpegInfo.version.replace(/^ffmpeg version /, '').split(' ')[0] : ''}`);
  console.log('');

  const audioCtx = needAudio
    ? await createFfmpegAudioContext({ sampleRate: o.rate, ffmpeg: ffmpegInfo.bin, cacheMb: o.sampleCache, batchSize: o.decodeBatch })
    : null;
  ctxRef.ctx = audioCtx;

  const pipelineOpts = {
    diffs, od: o.od === undefined ? NaN : o.od, hp: o.hp,
    serverTag: o.server || '', useSV: !!o.sv,
    audioMode, audioFormat: fmt.id, mp3Kbps: o.kbps,
    normalize: o.normalize, sampleRate: o.rate,
    suffixMode: o.suffix, tagMode: o.tags, tagTemplate: o.template || '',
    autoRepair: o.repair, sampleFallback: o.fallback, lnMaxBeats: o.lnMaxBeats || 0,
  };

  const usedNames = new Set();
  const uniqueName = (base, songid) => {
    let n = base, k = 2;
    if(usedNames.has(n.toLowerCase())) n = `${base} [${songid}]`;
    while(usedNames.has(n.toLowerCase())) n = `${base} [${songid}] (${k++})`;
    usedNames.add(n.toLowerCase());
    return n;
  };

  const report = [];
  const t0 = performance.now();
  let done = 0, okCount = 0, skipCount = 0, failCount = 0, totalBytes = 0;

  const onDone = (row) => {
    done++;
    if(row.ok) okCount++; else if(row.skipped) skipCount++; else failCount++;
    totalBytes += row.bytes || 0;
    const el = performance.now() - t0;
    const per = el / done;
    const left = (files.length - done) * per;
    if(!o.quiet){
      const tag = row.ok ? '✓' : row.skipped ? '·' : '✗';
      const extra = row.ok
        ? `${row.diffs.length} 难度 / ${mb(row.bytes)} / ${fmtMs(row.ms)}`
        : row.skipped ? row.reason : (row.error || '失败');
      console.log(`${tag} [${String(done).padStart(String(files.length).length)}/${files.length}] `
        + `${padDisplay(row.name, 46)} ${extra}`);
      if(o.verbose && row.logs) for(const l of row.logs) console.log('      ' + l.msg);
      if(row.warnings && row.warnings.length && !o.verbose)
        for(const w of row.warnings.slice(0, 2)) console.log('      ⚠ ' + w);
    }
    if(!o.verbose && !o.quiet && done % 25 === 0)
      console.log(`      ⋯ 已用 ${fmtMs(el)}，平均 ${fmtMs(per)}/首，剩余约 ${fmtMs(left)}`);
  };

  let guard = 0;
  const worker = async () => {
    while(true){
      const i = guard++;
      if(i >= files.length) return;
      const ojnPath = files[i];
      const row = { file: path.relative(inRoot, ojnPath), ok: false, skipped: false };
      try {
        const meta = loadSong(ojnPath, findOjm(ojnPath));
        row.songid = meta.header.songid;
        row.title = meta.title; row.artist = meta.artist; row.noter = meta.noter;
        row.levels = diffs.map(d => meta.header.levels[d]);
        row.notes = diffs.map(d => meta.header.noteCounts[d]);
        row.diffs = diffs.map(d => DIFFS[d].name);
        row.ojm = meta.ojmPath ? path.relative(inRoot, meta.ojmPath) : null;
        row.samples = meta.song.samples.size;
        if(meta.ojmError) row.ojmError = meta.ojmError;

        const base = sanitizeFilename(meta.artist + ' - ' + meta.title.replace(/\.+$/, ''))
                     .replace(/[/\\:*?"<>|]/g, '').trim() || path.basename(ojnPath, path.extname(ojnPath));
        const name = uniqueName(base, meta.header.songid);
        row.name = name;
        row.osz = name + '.osz';

        const zipPath = path.join(outDir, row.osz);
        if(o['skip-existing'] && fs.existsSync(zipPath)){
          row.ok = true; row.skipped = true; row.reason = '输出已存在，跳过';
          row.bytes = fs.statSync(zipPath).size;
          report.push(row); onDone(row); continue;
        }

        const r = await convertSong(meta, pipelineOpts, audioCtx);
        row.ms = r.ms;
        row.logs = o.verbose ? r.logs : undefined;
        const warnings = r.out.warnings.slice();
        if(r.err) warnings.unshift('转换抛异常：' + r.err.message);
        row.warnings = warnings;
        row.files = r.out.files.map(f => ({ name: f.name, size: f.data.length }));
        row.audioBytes = r.out.files.filter(f => /\.(mp3|wav|ogg)$/i.test(f.name))
                                    .reduce((a, f) => a + f.data.length, 0);

        if(!r.out.files.some(f => /\.osu$/i.test(f.name))) throw r.err || new Error('没有产出任何 .osu');

        if(o.zip){
          const bytes = makeZip(r.out.files);
          fs.writeFileSync(zipPath, bytes);
          row.bytes = bytes.length;
        } else {
          const dir = path.join(outDir, name);
          fs.mkdirSync(dir, { recursive: true });
          for(const f of r.out.files) fs.writeFileSync(path.join(dir, f.name), f.data);
          row.bytes = r.out.files.reduce((a, f) => a + f.data.length, 0);
        }
        row.ok = true;
      } catch(e){
        row.error = e.message;
        row.warnings = (row.warnings || []).concat('失败：' + e.message);
      }
      report.push(row); onDone(row);
    }
  };

  await Promise.all(Array.from({ length: Math.min(o.jobs, files.length) }, worker));

  // ---- 汇总 ----
  const el = performance.now() - t0;
  let decodeStats = null;
  if(audioCtx){
    const s = audioCtx.stats();
    const f = ffmpegStats();
    decodeStats = s;
    report.push({ _stats: s });
    if(!o.quiet){
      console.log(`\n样本解码：${s.batches} 次批量调用 / ${s.decoded} 个样本，缓存命中 ${s.cacheHits} 未命中 ${s.cacheMisses}`
        + `（缓存保留 ${(s.cacheBytes / 1048576).toFixed(0)} MB）`);
      /* 注意：并行时这些累计值会**大于**墙钟时间（多首同时在跑），所以只报“花了多少”，
         不做“其余是多少”那种减法 —— 那会算出负数。 */
      console.log(`ffmpeg 累计：解码 ${fmtMs(f.decodeMs)}（${f.decodeSpawns} 次进程 / ${f.decodeFiles} 个输入）`
        + ` + 编码 ${fmtMs(f.encodeMs)}（${f.encodes} 次）＝ ${fmtMs(f.decodeMs + f.encodeMs)}`
        + `　${o.jobs} 路并行，墙钟 ${fmtMs(el)}`);
    }
  }
  const audioTotal = report.filter(r => r.audioBytes).reduce((a, r) => a + r.audioBytes, 0);
  console.log(`\n完成：${okCount} 首成功${skipCount ? `（${skipCount} 首跳过）` : ''}`
    + `${failCount ? ` / ${failCount} 首失败` : ''}　用时 ${fmtMs(el)}　平均 ${fmtMs(el / files.length)}/首`);
  console.log(`体积：共 ${mb(totalBytes)}${audioTotal ? `（其中音频 ${mb(audioTotal)}）` : ''} → ${outDir}`);

  const fails = report.filter(r => r.error);
  if(fails.length){
    console.log('\n失败清单：');
    for(const f of fails) console.log(`  ✗ ${f.file}：${f.error}`);
  }
  const warn = report.filter(r => r.warnings && r.warnings.length && !r.error);
  if(warn.length && !o.verbose){
    const total = warn.reduce((a, r) => a + r.warnings.length, 0);
    console.log(`\n有 ${warn.length} 首带警告（共 ${total} 条）—— 加 --verbose 看详情，或翻报告 JSON。`);
  }

  if(o.report !== false){
    const rp = path.resolve(typeof o.report === 'string' ? o.report : path.join(outDir, '_report.json'));
    const summary = {
      input: inDir, output: outDir, ffmpeg: ffmpegInfo ? ffmpegInfo.version : null,
      diffs: diffs.map(i => DIFFS[i].name), audioMode, format: fmt.id, kbps: o.kbps, rate: o.rate,
      songs: files.length, ok: okCount, skipped: skipCount, failed: failCount,
      totalBytes, audioBytes: audioTotal, ms: Math.round(el),
    };
    if(decodeStats){
      const f = ffmpegStats();
      summary.decode = { ...decodeStats, decodeMs: Math.round(f.decodeMs), encodeMs: Math.round(f.encodeMs),
                         decodeSpawns: f.decodeSpawns, encodes: f.encodes };
    }
    fs.writeFileSync(rp, JSON.stringify({ summary, songs: report.filter(r => !r._stats) }, null, 1));
    console.log(`报告：${rp}`);
  }
  if(audioCtx) audioCtx.dispose();
  for(const t of tempRoots){ try { fs.rmSync(t, { recursive: true, force: true }); } catch(e){} }
  process.exitCode = failCount ? 1 : 0;
}

/* ================================================================== BMS 模式 */

const BMS_EXT_RE = /\.(bms|bme|bml|bmx)$/i;
const OJN_EXT_RE = /\.ojn$/i;

/** 把磁盘文件包成浏览器里 File 的样子（song.js / pipeline.js 只认这个形状） */
function fakeFile(full, root){
  const size = fs.statSync(full).size;
  return {
    name: path.basename(full),
    webkitRelativePath: path.relative(root, full).split(path.sep).join('/'),
    size,
    arrayBuffer: async () => {
      const b = fs.readFileSync(full);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

/** 顶层文件 + 子目录采样文件（BMS 的样本常在 samples/ 之类的子目录） */
function filesUnder(allFiles, dir){
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return allFiles.filter(p => p === dir || p.startsWith(prefix));
}

async function runBms(o){
  if(o.help || !o.in){ console.log(USAGE.trim()); process.exit(o.in ? 0 : 1); }

  const ctxRef = { ctx: null };
  process.on('SIGINT', () => {
    console.log('\n已中断，清理临时文件…');
    if(ctxRef.ctx) ctxRef.ctx.dispose();
    process.exit(130);
  });

  const inDir = path.resolve(o.in);
  if(!fs.existsSync(inDir)) throw new Error('输入目录不存在：' + inDir);
  const outDir = path.resolve(o.out || path.join(inDir, '..', 'BMS-osz'));
  fs.mkdirSync(outDir, { recursive: true });

  let audioFormat = o.format, audioMode = o.audio;
  if(audioFormat === 'keysound'){ audioMode = 'keysound'; audioFormat = 'wav'; }
  else if(audioFormat === 'none'){ audioMode = 'none'; audioFormat = 'wav'; }
  if(audioMode === 'keysound' || audioMode === 'none') audioFormat = 'wav';
  const fmt = formatById(audioFormat);
  if(fmt.id !== audioFormat) throw new Error(`--format 不认识 "${audioFormat}"（可用 ${audioFormatIds} / keysound / none）`);
  const needAudio = audioMode !== 'none' && audioMode !== 'keysound';

  let ffmpegInfo = null;
  if(needAudio){
    ffmpegInfo = await findFfmpeg(o.ffmpeg);
    for(const need of [fmt.id === 'mp3' ? 'libmp3lame' : fmt.id === 'ogg' ? 'libvorbis' : null].filter(Boolean))
      if(!await hasEncoder(ffmpegInfo.bin, need))
        throw new Error(`这个 ffmpeg 没有 ${need} 编码器：${ffmpegInfo.version}`);
    registerFfmpegEncoders({ ffmpeg: ffmpegInfo.bin });
  }

  // ---- 扫描：一次遍历 ----
  //   .zip   → 内存里摊平（不解压、不需要解压权限）
  //   .rar/.7z → 用系统 7-Zip / UnRAR 解到**临时目录**（源包只读，不需要在旁边写文件）
  const inIsFile = fs.statSync(inDir).isFile();
  const root = inIsFile ? path.dirname(inDir) : inDir;
  const allPaths = inIsFile ? [inDir] : walk(inDir, () => true);
  const ARCHIVE_RE = /\.(rar|7z)$/i;
  const zipPaths = allPaths.filter(p => /\.zip$/i.test(p));
  const heavyArchives = allPaths.filter(p => ARCHIVE_RE.test(p));
  const plainPaths = allPaths.filter(p => !/\.zip$/i.test(p) && !ARCHIVE_RE.test(p));

  const tempRoots = [];
  const vfiles = plainPaths.map(p => fakeFile(p, root));
  const archives = [];
  for(const zp of zipPaths){
    try {
      const buf = fs.readFileSync(zp);
      const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      if(!looksLikeZip(u8)){ console.log(`  ⚠ ${path.basename(zp)} 不是 ZIP，跳过`); continue; }
      const rel = path.relative(root, zp).split(path.sep).join('/').replace(/\.zip$/i, '');
      const r = expandZip(u8, rel);
      vfiles.push(...r.files);
      for(const w of r.warnings) console.log(`  ⚠ ${w}`);
      archives.push({ name: rel, files: r.files.length, kind: 'zip' });
    } catch(e){
      console.log(`  ⚠ ${path.basename(zp)} 解不开：${e.message}`);
    }
  }

  if(heavyArchives.length){
    const ex = findExtractor();
    if(!ex){
      console.log(`  ⚠ 发现 ${heavyArchives.length} 个 .rar/.7z，但没找到 7-Zip / UnRAR`);
      console.log(`     装一个 7-Zip（或用环境变量 SBC_7Z 指向 7z.exe）就能直接读，不必手动解压`);
    } else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbc-arc-'));
      tempRoots.push(tmp);
      for(const ap of heavyArchives){
        const rel = path.relative(root, ap).split(path.sep).join('/').replace(ARCHIVE_RE, '');
        const dest = path.join(tmp, ...rel.split('/'));
        try {
          await extractArchive(ex, ap, dest);
          const got = walk(dest, () => true).map(f => fakeFile(f, tmp));
          vfiles.push(...got);
          archives.push({ name: rel, files: got.length, kind: path.extname(ap).slice(1).toLowerCase() });
        } catch(e){
          console.log(`  ⚠ ${path.basename(ap)} 解不开：${e.message}`);
        }
      }
    }
  }

  const bmsFiles = vfiles.filter(f => BMS_EXT_RE.test(f.name));
  if(!bmsFiles.length) throw new Error('没找到 .bms/.bme/.bml/.bmx 文件（压缩包里也没有）：' + inDir);

  const buckets = groupFiles(bmsFiles);
  let songDirs = [...buckets.keys()].map(d => d.replace(/\/$/, ''));
  if(o.filter){
    let re; try { re = new RegExp(o.filter, 'i'); } catch(e){ throw new Error('--filter 不是合法正则：' + e.message); }
    songDirs = songDirs.filter(d => re.test(path.basename(d)));
  }
  songDirs = [...new Set(songDirs)].sort();
  if(o.limit) songDirs = songDirs.slice(0, o.limit);
  if(!songDirs.length) throw new Error('筛选后没有可转换的歌：' + inDir);

  console.log(`BMS → osu! 批量转换`);
  console.log(`  输入    ${inDir}（${songDirs.length} 首 / ${bmsFiles.length} 个 .bms`
    + (archives.length ? `；${archives.length} 个压缩包：zip 内存直读，rar/7z 解到临时目录` : '') + `）`);
  console.log(`  输出    ${outDir}`);
  console.log(`  音频    ${audioMode}${needAudio ? ' / ' + fmt.id.toUpperCase() + (fmt.id === 'mp3' ? '@' + o.kbps + 'k' : '') : ''}　${o.rate}Hz`
    + `　皿 ${o.plate}　键数 ${o.keys}`);
  console.log(`  并行    ${o.jobs} 首${ffmpegInfo ? '　ffmpeg ' + ffmpegInfo.version.replace(/^ffmpeg version /, '').split(' ')[0] : ''}`);
  if(archives.length)
    for(const a of archives) console.log(`  ${String(a.kind || '').padEnd(4)}  ${a.name}：${a.files} 个文件`);
  console.log('');

  const audioCtx = needAudio
    ? await createFfmpegAudioContext({ sampleRate: o.rate, ffmpeg: ffmpegInfo.bin, cacheMb: o.sampleCache, batchSize: o.decodeBatch })
    : null;
  ctxRef.ctx = audioCtx;

  const pipelineOpts = {
    od: o.od === undefined ? NaN : o.od, hp: o.hp, serverTag: o.server || '',
    audioMode, audioFormat: fmt.id, mp3Kbps: o.kbps, normalize: o.normalize, sampleRate: o.rate,
    tagMode: o.tags, tagTemplate: o.template || '', zipPerSong: o.zip,
    plate: o.plate, keys: o.keys === 'auto' ? null : Number(o.keys), stops: o.stops, random: o.random,
  };

  const usedNames = new Set();
  const uniqueName = (base) => {
    let n = base, k = 2;
    while(usedNames.has(n.toLowerCase())) n = `${base} (${k++})`;
    usedNames.add(n.toLowerCase());
    return n;
  };

  const report = [];
  const t0 = performance.now();
  let done = 0, okCount = 0, skipCount = 0, failCount = 0, totalBytes = 0;

  const onDone = (row) => {
    done++;
    if(row.ok) okCount++; else if(row.skipped) skipCount++; else failCount++;
    totalBytes += row.bytes || 0;
    const el = performance.now() - t0;
    if(!o.quiet){
      const tag = row.ok ? '✓' : row.skipped ? '·' : '✗';
      const extra = row.ok ? `${row.diffs} 难度 / ${mb(row.bytes)} / ${fmtMs(row.ms)}`
        : row.skipped ? row.reason : (row.error || '失败');
      console.log(`${tag} [${String(done).padStart(String(songDirs.length).length)}/${songDirs.length}] `
        + `${padDisplay(row.name, 46)} ${extra}`);
      if(o.verbose && row.logs) for(const l of row.logs) console.log('      ' + l.msg);
      if(row.warnings && row.warnings.length && !o.verbose)
        for(const w of row.warnings.slice(0, 2)) console.log('      ⚠ ' + w);
    }
  };

  let guard = 0;
  const worker = async () => {
    while(true){
      const i = guard++;
      if(i >= songDirs.length) return;
      const dir = songDirs[i];
      const row = { file: dir || path.basename(inDir), ok: false, skipped: false };
      const logs = [];
      try {
        const prefix = dir ? dir + '/' : '';
        const files = vfiles.filter(f => !prefix || String(f.webkitRelativePath).startsWith(prefix));
        const song = await prepareSong('', files, { plate: o.plate, random: o.random, keys: o.keys === 'auto' ? null : Number(o.keys) });
        if(!song) throw new Error('没有可解析的 .bms');
        row.title = song.title; row.artist = song.artist;
        row.diffs = song.diffs.filter(d => d.parsed).length;
        row.samples = song.diffs.reduce((a, d) => a + (d.parsed ? d.parsed.wav.size : 0), 0);

        const base = sanitizeFilename((song.artist ? song.artist + ' - ' : '') + (song.title || 'BMS'))
                     .replace(/[/\\:*?"<>|]/g, '').trim() || path.basename(dir);
        const name = uniqueName(base);
        row.name = name;
        row.osz = name + '.osz';
        const zipPath = path.join(outDir, row.osz);
        if(o['skip-existing'] && fs.existsSync(zipPath)){
          row.ok = true; row.skipped = true; row.reason = '输出已存在，跳过';
          row.bytes = fs.statSync(zipPath).size;
          report.push(row); onDone(row); continue;
        }

        setLogSink(null);
        const t = performance.now();
        let res;
        await als.run(logs, async () => {
          res = await convertBmsSong(song, pipelineOpts, audioCtx, null);
        });
        row.ms = performance.now() - t;
        row.logs = o.verbose ? logs : undefined;
        row.warnings = res.warnings.slice();
        row.files = res.files.map(f => ({ name: f.name, size: f.data.length }));
        row.audioBytes = res.files.filter(f => /\.(mp3|wav|ogg)$/i.test(f.name))
                                    .reduce((a, f) => a + f.data.length, 0);
        if(!res.files.some(f => /\.osu$/i.test(f.name))) throw new Error('没有产出任何 .osu');

        if(o.zip){
          const bytes = makeZip(res.files);
          fs.writeFileSync(zipPath, bytes);
          row.bytes = bytes.length;
        } else {
          const d = path.join(outDir, name);
          fs.mkdirSync(d, { recursive: true });
          for(const f of res.files) fs.writeFileSync(path.join(d, f.name), f.data);
          row.bytes = res.files.reduce((a, f) => a + f.data.length, 0);
        }
        row.ok = true;
      } catch(e){
        row.error = e.message;
        row.logs = o.verbose ? logs : undefined;
      }
      report.push(row); onDone(row);
    }
  };

  await Promise.all(Array.from({ length: Math.min(o.jobs, songDirs.length) }, worker));

  const el = performance.now() - t0;
  console.log(`\n完成：${okCount} 首成功${skipCount ? `（${skipCount} 首跳过）` : ''}`
    + `${failCount ? ` / ${failCount} 首失败` : ''}　用时 ${fmtMs(el)}　平均 ${fmtMs(el / songDirs.length)}/首`);
  console.log(`体积：共 ${mb(totalBytes)} → ${outDir}`);

  const fails = report.filter(r => r.error);
  if(fails.length){
    console.log('\n失败清单：');
    for(const f of fails) console.log(`  ✗ ${f.file}：${f.error}`);
  }
  const warn = report.filter(r => r.warnings && r.warnings.length && !r.error);
  if(warn.length && !o.verbose){
    const total = warn.reduce((a, r) => a + r.warnings.length, 0);
    console.log(`\n有 ${warn.length} 首带警告（共 ${total} 条）—— 加 --verbose 看详情，或翻报告 JSON。`);
  }

  if(o.report !== false){
    const rp = path.resolve(typeof o.report === 'string' ? o.report : path.join(outDir, '_report.json'));
    fs.writeFileSync(rp, JSON.stringify({
      summary: { mode: 'bms', input: inDir, output: outDir, ffmpeg: ffmpegInfo ? ffmpegInfo.version : null,
                 audioMode, format: fmt.id, kbps: o.kbps, rate: o.rate, plate: o.plate, keys: o.keys,
                 stops: o.stops, songs: songDirs.length, ok: okCount, skipped: skipCount, failed: failCount,
                 totalBytes, ms: Math.round(el) },
      songs: report,
    }, null, 1));
    console.log(`报告：${rp}`);
  }
  if(audioCtx) audioCtx.dispose();
  for(const t of tempRoots){ try { fs.rmSync(t, { recursive: true, force: true }); } catch(e){} }
  process.exitCode = failCount ? 1 : 0;
}

/* ================================================================== 入口 */

async function main(){
  const argv = process.argv.slice(2);
  let mode = 'auto';
  if(argv[0] && !argv[0].startsWith('-') && ['o2jam', 'bms', 'auto'].includes(argv[0])) mode = argv.shift();
  const o = parseArgs(argv);
  if(o.help || !o.in){ console.log(USAGE.trim()); process.exit(o.help ? 0 : 1); }

  if(mode === 'auto'){
    // 按扩展名分派：只有 .ojn 就跑 O2Jam（老命令的行为完全不变）；只有 .bms 就跑 BMS
    const inDir = path.resolve(o.in);
    const inIsFile = fs.statSync(inDir).isFile();
    const all = inIsFile ? [inDir] : walk(inDir, () => true);
    const hasOjn = all.some(p => OJN_EXT_RE.test(p));
    const hasBms = all.some(p => BMS_EXT_RE.test(p));
    if(hasOjn && hasBms){ mode = 'both'; }
    else if(hasBms){ mode = 'bms'; }
    else mode = 'o2jam';
  }
  if(mode === 'bms') return runBms(o);
  if(mode === 'both'){
    await runO2Jam(Object.assign({}, o, { quiet: true }));
    return runBms(Object.assign({}, o, { quiet: true }));
  }
  return runO2Jam(o);
}


const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if(isEntry){
  main().catch(e => {
    console.error('\n出错：' + e.message);
    if(process.env.OJN_DEBUG) console.error(e.stack);
    process.exitCode = 2;
  });
}

export { parseArgs, parseDiffs, findOjm, walk, padDisplay };