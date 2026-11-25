// BMS 的「歌曲模型」：一个文件夹 = 一首歌，其中每个 .bms 是一个难度
//
// 浏览器与命令行共用同一套解析：传入的 files 只需要有
//   { name, webkitRelativePath?, size, arrayBuffer() }
// 浏览器里是 File；命令行里由 tools/cli.js 包一层（见 fakeFile）。

import { parseBms } from './bms.js';
import { analyzeChart, buildChart, detectLayout, layoutFromColumns, layoutLabel } from './chart.js';

const BMS_RE = /\.(bms|bme|bml|bmx)$/i;

/** 相对路径（统一用 /，去掉开头的 ./） */
function relOf(f){
  const raw = (f.webkitRelativePath || f.name || '').replace(/\\/g, '/');
  return raw.replace(/^\.\//, '').replace(/^\/+/, '');
}
function dirOf(p){ const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }
function baseOf(p){ const i = p.lastIndexOf('/'); return (i < 0 ? p : p.slice(i + 1)).toLowerCase(); }

/** 把一次拖入（或一次目录扫描）拆成「一首歌一个桶」 */
export function groupFiles(files){
  const buckets = new Map();
  for (const f of files){
    const rel = relOf(f);
    if (!rel) continue;
    const dir = dirOf(rel);
    if (!buckets.has(dir)) buckets.set(dir, []);
    buckets.get(dir).push(f);
  }
  return buckets;
}

/** 为一个桶建索引：完整相对路径 / 目录+文件名 / 全局文件名 / 目录+主干 / 全局主干 */
export function buildFileIndex(files){
  const byPath = new Map(), byDirBase = new Map(), byBase = new Map();
  const byDirStem = new Map(), byStem = new Map();
  const push = (map, key, f) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  };
  for (const f of files){
    const rel = relOf(f);
    byPath.set(rel.toLowerCase(), f);
    const dir = dirOf(rel).toLowerCase(), base = baseOf(rel);
    const stem = base.replace(/\.[^.]*$/, '');
    byDirBase.set(dir + '|' + base, f);
    push(byBase, base, f);
    push(byDirStem, dir + '|' + stem, f);
    push(byStem, stem, f);
  }
  return { byPath, byDirBase, byBase, byDirStem, byStem };
}

/** 音频扩展名；扩展名兜底时按这个顺序挑（同主干有多个候选时） */
const AUDIO_EXTS = ['.wav', '.ogg', '.mp3', '.flac', '.m4a', '.opus'];

/** 同一主干下的多个候选：优先已知音频扩展；只有一个就认它；否则不猜 */
function pickByExt(files){
  if (!files || !files.length) return null;
  if (files.length === 1) return files[0];
  for (const ext of AUDIO_EXTS){
    const hit = files.find(f => baseOf(relOf(f)).endsWith(ext));
    if (hit) return hit;
  }
  return null;
}

/**
 * #WAV 里写的路径 → 实际文件。容错顺序：
 *   ① 完整相对路径（大小写不敏感）
 *   ② 同目录只按文件名（#WAV 常写 "kick.wav" 而文件在 samples/kick.wav）
 *   ③ **同目录、换扩展名** —— 真实案例：BMS 写 "01.wav"，磁盘上只有 "01.ogg"；
 *      beatoraja / LR2 等播放器也会这么找，所以不换就会整首静音
 *   ④ 整个包里同名文件唯一才认
 *   ⑤ 整个包里同主干唯一才认
 */
export function resolveSample(value, dir, index){
  if (!value) return null;
  const norm = String(value).replace(/\\/g, '/').replace(/^\.\//, '');
  const full = (dir + norm).toLowerCase();
  if (index.byPath.has(full)) return index.byPath.get(full);

  const base = baseOf(norm);
  const d = dir.toLowerCase();
  const inDir = index.byDirBase.get(d + '|' + base);
  if (inDir) return inDir;

  const stem = base.replace(/\.[^.]*$/, '');
  const sameStem = pickByExt(index.byDirStem.get(d + '|' + stem));
  if (sameStem) return sameStem;

  const any = index.byBase.get(base);
  if (any && any.length === 1) return any[0];

  return pickByExt(index.byStem.get(stem));
}

/** 一首歌（一个文件夹）→ 难度列表（解析头 + 统计，暂不读样本） */
export async function prepareSong(dir, files, opts = {}){
  const bmsFiles = files.filter(f => BMS_RE.test(relOf(f)));
  if (!bmsFiles.length) return null;
  const index = buildFileIndex(files);

  // 先全部解析：键数要**按整首歌**决定 —— 简单难度可能只弹前 5 列，
  // 但同一张图的其它难度用了 18/19 就说明是 7K，不能让简单难度把整组拽成 5K。
  const parsedList = [];
  const diffs = [];
  for (const f of bmsFiles){
    try {
      parsedList.push({ f, rel: relOf(f), parsed: parseBms(await f.arrayBuffer(), { random: opts.random || 1 }) });
    } catch (e){
      diffs.push({ file: f, rel: relOf(f), error: e.message });
    }
  }
  const infos = parsedList.map(p => analyzeChart(p.parsed));
  const songSeven = infos.some(i => i.seven);

  for (let i = 0; i < parsedList.length; i++){
    const { f, rel, parsed } = parsedList[i];
    // 键型：显式指定（5/6/7/8/10/12/14/16 列）优先，否则按内容猜（含双方、有无皿）
    const layout = opts.keys ? layoutFromColumns(opts.keys)
                             : detectLayout(parsed, { plate: opts.plate, keysPerSide: songSeven ? 7 : 5 });
    const lv = parsed.meta.playlevel;
    const stem = rel.split('/').pop().replace(BMS_RE, '');
    const label = diffLabel(parsed, stem);
    diffs.push({ file: f, rel, parsed, layout, keys: layout.columns, encoding: parsed.encoding,
                 name: label, level: lv, title: parsed.meta.title, artist: parsed.meta.artist,
                 samples: parsed.wav.size });
  }
  diffs.sort((a, b) => (a.level - b.level) || String(a.rel).localeCompare(String(b.rel)));

  // 同一首歌里 SP 与 DP 版本常常共用同一个 #DIFFICULTY（都是 ANOTHER / HYPER / NORMAL），
  // 直接用会给两个难度生成同名 .osu → .osz 里出现重名条目 → osu! 导入直接失败
  // （ZipArchiveReader.GetStream 用 SingleOrDefault，重名抛 "Sequence contains more than one matching element"）。
  // 这里给重名的难度补上键型（ANOTHER 14K2S / ANOTHER 7K1S），仍然撞就给序号。
  const labelCount = new Map();
  for (const d of diffs) if (d.name) labelCount.set(d.name, (labelCount.get(d.name) || 0) + 1);
  const usedLabels = new Set();
  for (const d of diffs){
    if (!d.name) continue;
    let name = d.name;
    if (labelCount.get(name) > 1 && d.layout) name = name + ' ' + layoutLabel(d.layout);
    let n = 2;
    while (usedLabels.has(name.toLowerCase())){
      name = d.name + ' ' + (d.layout ? layoutLabel(d.layout) + ' ' : '') + n++;
    }
    usedLabels.add(name.toLowerCase());
    d.name = name;
  }

  const ok = diffs.filter(d => d.parsed);
  const first = ok[0] && ok[0].parsed.meta;
  return {
    dir, diffs, index,
    // 一首歌里的各个 .bms 常把难度写进标题（"Space Boy [Hard]"）——
    // osu! 按 Title+Artist 归组，所以取各难度的公共前缀当整张图的标题，难度留在 Version 里
    title: groupTitle(ok.map(d => (d.parsed.meta.title + (d.parsed.meta.subtitle ? ' ' + d.parsed.meta.subtitle : '')).trim()))
           || (first ? first.title : (dir || '(空)')),
    artist: first ? first.artist : '',
    encoding: first ? ok[0].encoding : '',
  };
}

/** 多个难度的标题取公共前缀，再削掉末尾的 "[ ( - ~" 之类残渣 */
export function groupTitle(titles){
  const list = titles.filter(t => t && String(t).trim());
  if (!list.length) return '';
  if (list.length === 1) return String(list[0]).trim();
  let p = String(list[0]);
  for (const t of list.slice(1)){
    let i = 0;
    while (i < p.length && i < String(t).length && p[i] === t[i]) i++;
    p = p.slice(0, i);
  }
  return p.replace(/[\s\[\](){}<>\-–—_~·:：]+$/g, '').trim();
}

/** 难度名：#DIFFICULTY 优先（1..5 的标准档位）→ 标题/文件名**末尾**的 [xxx] → 文件名主干
    只认末尾的方括号：像 "[国服]卡农" 这种前缀方括号是服务器标记，不能当难度名 */
export function diffLabel(parsed, stem){
  const names = { 1: 'BEGINNER', 2: 'NORMAL', 3: 'HYPER', 4: 'ANOTHER', 5: 'INSANE' };
  const byCode = names[parsed.meta.difficulty];
  if (byCode) return byCode;
  const tail = (s) => {
    const m = String(s || '').match(/\[([^\[\]]{1,16})\]\s*$/);
    return m ? m[1].trim() : '';
  };
  const fromTitle = tail(parsed.meta.title);
  if (fromTitle) return fromTitle;
  const fromStem = tail(stem);
  if (fromStem) return fromStem;
  return String(stem || 'BMS').replace(/^[_\-.\s]+/, '').replace(/\s*\[[^\]]*\]\s*$/, '').slice(0, 24) || 'BMS';
}

/** 一首歌用到的样本：把 #WAV 的 id 解析成文件，读字节并缓存（跨难度共用） */
export async function loadSamples(diff, index, cache = new Map()){
  const samples = new Map();
  const missing = [];
  for (const [id, value] of diff.parsed.wav){
    const f = resolveSample(value, dirOf(diff.rel), index);
    if (!f){ missing.push(value); continue; }
    const key = relOf(f).toLowerCase();
    let bytes = cache.get(key);
    if (!bytes){
      bytes = new Uint8Array(await f.arrayBuffer());
      cache.set(key, bytes);
    }
    samples.set(id, { name: baseOf(relOf(f)), bytes, mime: mimeOf(f.name), rel: relOf(f) });
  }
  return { samples, missing, cache };
}

function mimeOf(name){
  const ext = String(name).toLowerCase().replace(/^.*\./, '');
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'ogg') return 'audio/ogg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'flac') return 'audio/flac';
  return 'application/octet-stream';
}

/** 只算 chart（不读样本），供预览与自检复用 */
export function chartOf(diff, opts = {}){
  return buildChart(diff.parsed, Object.assign({ layout: diff.layout }, opts));
}
