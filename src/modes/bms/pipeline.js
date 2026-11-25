// BMS 单曲转换流水线（一个文件夹 = 一首歌；每个 .bms = 一个难度）
//
// 与 O2Jam 版本共享的是 kernel：混音、编码器、键音计划、.osu 写出器、ZIP。
// 这里只管 BMS 自己的口径：难度怎么命名、皿怎么摆、缺样本怎么报警。

import { formatById, mixAndEncode } from '../../core/audio.js';
import { buildSampleNames, planKeysound } from '../../core/keysound.js';
import { buildOsuText, buildTags, describeRepairs, validateOsuText } from '../../core/osu/writer.js';
import { log, sanitizeFilename } from '../../core/util.js';
import { buildChart, layoutLabel } from './chart.js';
import { loadSamples, resolveSample, diffLabel } from './song.js';

function mb(b){ return (b / 1048576).toFixed(1) + ' MB'; }

/** 封面：STAGEFILE → BACKBMP → BANNER（谁存在用谁） */
function pickCover(diff, index){
  const m = diff.parsed.meta;
  for (const cand of [m.stage, m.backbmp, m.banner]){
    if (!cand) continue;
    const f = resolveSample(cand, diff.rel.replace(/[^/]*$/, ''), index);
    if (f) return { file: f, name: String(cand).replace(/\\/g, '/').split('/').pop() };
  }
  // 兜底：同目录里第一张图
  const dir = diff.rel.replace(/[^/]*$/, '').toLowerCase();
  for (const [k, f] of index.byPath){
    if (k.startsWith(dir) && /\.(jpg|jpeg|png|bmp)$/i.test(k)) return { file: f, name: k.slice(dir.length) };
  }
  return null;
}

/** 一首歌 → 文件清单（.osu + 音频 + 样本），纯逻辑，可在 Node 里跑 */
export async function convertBmsSong(song, opts, audioCtx, onProgress){
  const out = { files: [], warnings: [] };
  const want = song.diffs.filter(d => d.parsed)
    .filter((d, i) => !opts.diffs || !opts.diffs.length || opts.diffs.includes(i));
  if (!want.length){ out.warnings.push('没有可转换的 BMS 难度'); return out; }

  const leaf = sanitizeFilename((song.artist ? song.artist + ' - ' : '') + String(song.title || 'BMS'));
  const multi = want.length > 1;
  const fmt = formatById(opts.audioFormat || 'wav');
  const sampleCache = new Map();
  const coverDone = new Set();
  let sharedAudio = null;

  for (let n = 0; n < want.length; n++){
    const d = want[n];
    // 布局在 prepareSong 里就定好了（含用户显式指定的键型）；这里只按它出图
    const built = buildChart(d.parsed, { layout: d.layout, keys: opts.keys || null,
                                         plate: opts.plate, stops: opts.stops !== false,
                                         repair: opts.repair !== false });
    const label = d.name || diffLabel(d.parsed, d.rel);
    const keyText = built.layout ? layoutLabel(built.layout) : (built.keys + 'K');

    // ---- 封面（整首只拷一次） ----
    let coverName = '';
    const cover = pickCover(d, song.index);
    if (cover){
      const data = await cover.file.arrayBuffer().then(b => new Uint8Array(b));
      const name = sanitizeFilename(cover.name);
      if (name && !coverDone.has(name)){ out.files.push({ name, data }); coverDone.add(name); }
      coverName = name;
    }

    // ---- 样本 ----
    const { samples, missing } = await loadSamples(d, song.index, sampleCache);
    if (missing.length)
      out.warnings.push(label + '：' + missing.length + ' 个 #WAV 找不到文件（这些音符会是静音，谱面保留）');
    let sampleNames = null, sampleEvents = null, audioFilename = '';

    // ---- 音频 ----
    const lastObj = built.hitObjects.reduce((m, h) => Math.max(m, h.time, h.endTime > 0 ? h.endTime : 0), 0);
    const minDurationMs = Math.max(lastObj + 1500, 1000);
    if (opts.audioMode === 'keysound'){
      sampleNames = buildSampleNames(samples);
      const plan = planKeysound({ samples, sampleNames, audioObjects: built.audioObjects, hitObjects: built.hitObjects });
      sampleEvents = plan.sampleEvents;
      audioFilename = plan.audioName;
      for (const f of plan.files) if (!out.files.some(x => x.name === f.name)) out.files.push(f);
      if (plan.stats.bgm && !plan.audioName)
        out.warnings.push(label + '：没有「整首一条 BGM」可当音轨，BGM 全部走 Sample 事件');
    } else if (opts.audioMode !== 'none'){
      const suffix = multi ? ' (' + label + ')' : '';
      const name = leaf + suffix + fmt.ext;
      let m = sharedAudio;
      let chosen = fmt.id;
      if (!m){
        const base = { sampleRate: opts.sampleRate || 44100, normalize: opts.normalize !== false,
                       minDurationMs, decodeCache: new Map() };
        const onEnc = onProgress ? (frac) => onProgress({ diff: n, phase: 'encode', frac }) : undefined;
        try {
          m = await mixAndEncode(audioCtx, built.audioObjects, samples,
            Object.assign({}, base, { format: fmt.id, bitrate: opts.mp3Kbps, onEncodeProgress: onEnc }));
        } catch (e){
          log('  混音失败：' + e.message, 'w');
          out.warnings.push(label + '：音频生成失败（' + e.message + '）');
        }
        if (m && opts.audioMode === 'shared') sharedAudio = m;
      }
      if (m){
        audioFilename = name;
        if (!out.files.some(f => f.name === name)) out.files.push({ name, data: m.bytes });
        log('  音频 ' + chosen.toUpperCase() + (chosen === 'mp3' ? '@' + (opts.mp3Kbps || 320) + 'kbps' : '')
            + '：' + name + '（' + mb(m.bytes) + '，' + Math.round(m.seconds) + ' 秒）',
            m.silent ? 'w' : 's');
      }
    }

    // ---- .osu ----
    const m = d.parsed.meta;
    const noter = m.subartist[0] || m.maker || m.artist || 'BMS';
    // 标题用「整张图的公共标题」，难度只体现在 Version —— osu! 按 Title+Artist 归组，
    // 各难度写各自的 "曲名 [Hard]" 会被拆成三张图
    const title = song.title || (m.title + (m.subtitle ? ' ' + m.subtitle : '')).trim();
    const tagCtx = { file: d.rel, noter, songid: '', title, artist: m.artist, diff: label,
                     level: String(d.level || '') };
    const tags = buildTags(opts, tagCtx, 'BMS' + (opts.serverTag ? ' ' + opts.serverTag : '') + ' 转换');
    const text = buildOsuText({
      header: { fileName: d.rel, bpm: m.bpm },
      chart: { level: d.level || 0, noteCount: built.hitObjects.length },
      meta: {
        title, artist: m.artist, noter, tags, od: opts.od, hp: opts.hp,
        serverTag: opts.serverTag, diffName: ' ' + label,
        source: 'BMS', versionPrefix: '', circleSize: built.keys,
        sampleNames, sampleEvents,
      },
      timingPoints: built.timingPoints,
      hitObjects: built.hitObjects,
      audioFilename, musicOffset: 0, coverName,
      stats: built.stats,
    });
    // 文件名兜底去重：同名 .osu 进同一个 .osz 会让 osu! 导入直接失败（zip 重名条目）
    let osuName = leaf + (multi ? ' (' + label + ')' : '') + '.osu';
    const taken = (n) => out.files.some(f => String(f.name).toLowerCase() === n.toLowerCase());
    if (taken(osuName)){
      let k = 1;
      do { osuName = leaf + ' (' + label + (keyText ? ' ' + keyText : '') + (k > 1 ? ' ' + k : '') + ').osu'; k++; }
      while (taken(osuName));
      out.warnings.push('同名难度已自动改名：' + label + ' → ' + osuName);
    }
    out.files.push({ name: osuName, data: new TextEncoder().encode(text) });
    if (!out.preview) out.preview = { name: osuName, text };

    const problems = validateOsuText(text);
    if (problems.length){
      out.warnings.push(osuName + ' 自检发现 ' + problems.length + ' 处问题：' + problems[0]);
      for (const p of problems.slice(0, 3)) log('  ⚠ 自检：' + p, 'w');
    }
    const rep = describeRepairs(built.stats);
    if (rep) log('  修正 ' + label + ' → ' + rep, 'w');
    log('  ' + label + ' [Lv.' + (d.level || '?') + '] → ' + osuName + '（' + built.hitObjects.length
        + ' 个物件 / ' + keyText + ' / ' + built.timingPoints.length + ' 个时间点'
        + (built.stats.scratchDropped ? ' / 皿丢弃 ' + built.stats.scratchDropped : '') + '）');
    if (onProgress) onProgress(n);
  }
  return out;
}
