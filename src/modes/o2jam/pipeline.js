// 单曲转换流水线（浏览器里调用）
// 由 o2jam2osu.html 的单文件脚本拆分而来（逻辑未改动；从 @/ 分节 7）

import { formatById, mixAndEncode } from "../../core/audio.js";
import { buildSampleNames, planKeysound } from "../../core/keysound.js";
import { applySampleFallback, applySampleFallbackToHitObjects, buildSampleIndex, planSampleFallback }
  from "./samples.js";
import { sampleDurationMs } from "../../core/sampledur.js";
import { buildOsuText, buildTags, describeRepairs, validateOsuText } from "../../core/osu/writer.js";
import { buildChart } from "./chart.js";
import { parseOjnEvents, parseOjnHeader } from "./ojn.js";
import { DIFFS, log, sanitizeFilename } from "../../core/util.js";

/** 主音频的真实时长（毫秒）；解析不出来就返回 undefined，交给“样本数极少”的退化判据 */
function mainDurMs(samples, id){
  if(id === null || id === undefined) return undefined;
  const s = samples.get(id);
  if(!s) return undefined;
  const d = sampleDurationMs(s.bytes);
  return d === null ? undefined : d;
}

/** 日志里那句“峰值 X → 响度怎么处理的” */
function describeLoudness(m){
  if(m.loudness === 'normalize')
    return m.gain !== 1 ? " → 归一化 " + (20 * Math.log10(m.gain)).toFixed(1) + "dB" : "（未超阈值）";
  if(m.loudness === 'limit')
    return m.limited ? " → 限制器压制 " + m.reductionDb.toFixed(1) + "dB（只压尖峰，整体响度不变）"
                     : "（未超阈值，原样输出）";
  return "（未做响度处理" + (m.peak > 1 ? "，超过 0dBFS 会削波" : "") + "）";
}

/* =====================================================================
   7. 单曲转换流水线（浏览器里调用）
   ===================================================================== */
async function convertOneSong(song, opts, audioCtx, onProgress){
  const out = { files: [], warnings: [] };
  const u8 = new Uint8Array(await song.ojnFile.arrayBuffer());
  const header = parseOjnHeader(u8.buffer);
  header.fileName = song.ojnFile.name;
  const decode = song.decode;
  const title = decode(header.rawTitle);
  const artist = decode(header.rawArtist);
  const noter = decode(header.rawNoter);
  const samples = song.samples || new Map();
  const sampleNames = samples.size ? buildSampleNames(samples) : new Map();
  const sampleIndex = samples.size ? buildSampleIndex(samples) : null;
  const leafName = sanitizeFilename(artist + " - " + title.replace(/\.+$/, ""));

  // ---- 封面：直接拿内嵌的 JPEG 字节（原版用 ImageIO 重编成 png，这里省一步）----
  let coverName = "";
  if(header.coverSize > 0 && header.coverOffset + header.coverSize <= u8.length){
    const jpg = u8.slice(header.coverOffset, header.coverOffset + header.coverSize);
    if(jpg.length > 4 && jpg[0] === 0xFF && jpg[1] === 0xD8){
      out.files.push({name:"bg.jpg", data:jpg});
      coverName = "bg.jpg";
    }
  }

  const plan = (idx) => suffixPlan(opts, idx, opts.diffs.length);
  let sharedAudio = null;
  const decodeCache = new Map();      // 一首歌内跨难度复用解码结果

  for(const idx of opts.diffs){
    const start = header.noteOffsets[idx];
    const end = idx < 2 ? header.noteOffsets[idx+1] : header.coverOffset;
    const events = parseOjnEvents(u8, start, end);
    const built = buildChart(header.bpm, events, opts.useSV,
      {enabled: opts.autoRepair, maxBeats: opts.lnMaxBeats});
    const sfx = plan(idx);

    // ---- 样本 id 兜底：±1000（WAV/OGG 音色库偏移）/ 单主音频（整首只有一条主音频，像 osu）----
    if(sampleIndex && opts.sampleFallback !== false){
      const needMs = Math.max((header.durations[idx] || 0) * 1000,
        built.hitObjects.reduce((m, h) => Math.max(m, h.time, h.endTime > 0 ? h.endTime : 0), 0) + 1500);
      const fb = planSampleFallback({ index: sampleIndex, audioObjects: built.audioObjects, needMs,
                                      mainDurationMs: mainDurMs(samples, sampleIndex.mainId) });
      const nObj = applySampleFallback(built.audioObjects, fb, sampleIndex);
      const nHit = applySampleFallbackToHitObjects(built.hitObjects, fb, sampleIndex);
      if(fb.stats.aliasHits)
        log("  样本 id 兜底 ±1000：" + fb.stats.aliasHits + " 个对象（id " + [...fb.stats.aliasIds].join(",")
            + " → 音色库另一个区）", "w");
      if(fb.mainAudio)
        log("  样本 id 兜底·单主音频：BGM 引用的 id " + [...fb.mainAudio.from].join(",")
            + " 在 OJM 里不存在 → 已指向唯一的主音频 id " + fb.mainAudio.toId
            + "（共 " + fb.stats.mainAudio + " 个对象）", "w");
      if(nObj.bgm || nObj.keys){
        built.sampleFallback = nObj;
        log("  兜底命中：BGM " + nObj.bgm + " 个 / 键音 " + nObj.keys + " 个对象（共 " + nObj.objects + "）", "w");
      }
      if(nHit) log("  兜底命中：" + nHit + " 个音符的键音走 ±1000 别名", "w");
      if(fb.stats.stillMissing && !nObj.objects && !nHit)
        out.warnings.push("有 " + fb.stats.stillMissing + " 个音频对象引用的样本不在 OJM 里（id "
          + [...fb.stats.missingIds].slice(0, 6).join(",") + (fb.stats.missingIds.size > 6 ? "…" : "")
          + "）：这些音符/背景音会是静音的");
    }

    // ---- 音频：默认“每难度各混一份”；audioMode='keysound' 时改为保留原始样本（不混音） ----
    const fmt = formatById(opts.audioFormat);
    const mb = (b) => (b.length / 1048576).toFixed(1) + " MB";
    let audioFilename = leafName + sfx.file + fmt.ext;   // 不生成音频时的占位名（同扩展名，方便自行替换）
    let musicOffset = 0;
    let sampleMeta = null;
    const noSamples = samples.size === 0;
    if(noSamples && opts.audioMode !== "none"){
      /* ★ 关键：以前这里写的是 `audioMode !== "none" && samples.size` ——
         OJM 缺失/解析失败/空表时整个音频分支被跳过：既不产出音频，
         .osu 又仍写着 AudioFilename: <占位名>，打开 .osz 就是“这首没音频”。
         现在照样进入下面的流程，由退路链生成静音音轨并大声报警。 */
      log("  ⚠ 没有可用样本（" + (song.ojmFile ? "OJM 解析失败或为空" : "缺少同名 .ojm")
          + "）：会生成静音音轨，音轨长度按谱面时长", "w");
      out.warnings.push("没有可用样本（" + (song.ojmFile ? "OJM 解析失败或为空" : "缺少同名 .ojm")
          + "）：已生成静音音轨，谱面能正常导入但没有声音");
    }
    if(opts.audioMode === "keysound"){
      const plan = planKeysound({ samples, sampleNames, audioObjects: built.audioObjects, hitObjects: built.hitObjects });
      const st = plan.stats;
      audioFilename = plan.audioName;                    // 可能是 ''（没有 BGM 时不写 AudioFilename）
      sampleMeta = { sampleNames: plan.nameOf, sampleEvents: plan.sampleEvents };
      for(const f of plan.files) if(!out.files.some(x => x.name === f.name)) out.files.push(f);
      log("  保留键音：键音 " + st.keysounds + " 个 / BGM " + st.bgm + " 个（Sample 事件 " + st.sampleEvents
          + "，其中 " + st.sharedIds + " 个 id 与键音共用）+ 样本文件 " + st.samples + " 个"
          + (st.hasAudioTrack ? "，音轨 = " + audioFilename : "（无整首 BGM，不写 AudioFilename）"),
          st.hasAudioTrack ? "s" : "w");
      if(!plan.files.length) out.warnings.push("保留键音：没有可用样本，键音与背景音都会是静音的");
    } else if(opts.audioMode !== "none"){
      const wantShared = opts.audioMode === "shared";
      /* 音频至少要盖到谱面时长（头部声明的 duration / 最后一个物件）：
         不少 OJM 只含部分样本（有的只剩 1 个），只按样本算的话音频会提前结束 —— 听感就是“这首缺音频”。 */
      const lastObj = built.hitObjects.reduce((m, h) => Math.max(m, h.time, h.endTime > 0 ? h.endTime : 0), 0);
      /* ★ 共享模式下这份音频会被三个难度一起用，而它是**从第一个难度**混出来的 ——
         如果 EX 比 HX 短，HX 尾部就会缺一截（实测 30 首里有 2 首差 0.7~1.1 秒）。
         所以共享模式取「所有选中难度里最长的声明时长」，而不是当前难度自己的。
         再 +1.5 秒是必要的余量：头部声明的 duration 偶尔比 HX 实际最后一个音符还短
         （实测 100 首里有 1 首，声明 170.0s、实际 170.3s），那 1.5 秒静音只值 ~60KB。 */
      const sharedMinMs = wantShared
        ? Math.max(0, ...opts.diffs.map(d => (header.durations[d] || 0) * 1000)) + 1500
        : 0;
      const minDurationMs = Math.max((header.durations[idx] || 0) * 1000, lastObj + 1500, sharedMinMs);
      const base = { sampleRate: opts.sampleRate, normalize: opts.normalize, loudness: opts.loudness,
                     minDurationMs, decodeCache };
      // MP3 是纯 JS 编码（~10× 实时），必须把进度报出去，否则界面会像卡死
      const onEnc = onProgress ? (frac) => onProgress({ diff: idx, phase: "encode", frac }) : undefined;
      const nameFor = (fmt2) => leafName + (wantShared ? "" : sfx.file) + fmt2.ext;
      const take = (m, fmt2, extra) => {
        const name = nameFor(fmt2);
        audioFilename = name; musicOffset = m.musicOffset;
        if(!out.files.some(f => f.name === name)) out.files.push({name, data:m.bytes});
        log("  音频 " + fmt2.id.toUpperCase() + (fmt2.id === "mp3" ? "@" + opts.mp3Kbps + "kbps" : "")
            + (extra || "") + "：" + name + "（" + mb(m.bytes) + "，" + Math.round(m.seconds) + " 秒，"
            + m.usedSamples + " 个样本" + (m.padded ? "，样本不足已补静音" : "")
            + "，峰值 " + m.peak.toFixed(2) + describeLoudness(m)
            + "）", m.padded || m.silent ? "w" : "s");
        if(m.padded || m.silent) out.warnings.push(name + "：" + (m.silent ? "没有可用样本，已生成静音音轨" : "样本内容不足以覆盖全曲，已补静音到 " + Math.round(m.seconds) + " 秒"));
        /* 只有“明确要求不做响度处理”时才诚叫削波。限制器路径下峰已经被压到阈值以下，不需要警告 ——
           否则满屏幕都是假警告，真正的警告就没人看了。 */
        if(m.peak > 1 && m.loudness === 'none')
          out.warnings.push(name + "：响度处理已关，峰值 " + m.peak.toFixed(2) + " > 1.0（+ "
            + (20 * Math.log10(m.peak)).toFixed(1) + "dB）→ 会饱和削波失真；想要“和原曲一样响又不削”就选限制器");
      };
      if(wantShared && sharedAudio){
        take(sharedAudio.m, sharedAudio.fmt, "（共享）");
      } else {
        let m = null, fmt2 = fmt, note = "";
        const tEnc = Date.now();
        try {
          m = await mixAndEncode(audioCtx, built.audioObjects, samples,
            Object.assign({}, base, {format: opts.audioFormat, bitrate: opts.mp3Kbps, onEncodeProgress: onEnc}));
        } catch(e1){
          log("  混音失败：" + e1.message, "w");
          const wav = formatById("wav");
          if(opts.audioFormat !== "wav"){
            try {
              m = await mixAndEncode(audioCtx, built.audioObjects, samples, Object.assign({}, base, {format: "wav"}));
              fmt2 = wav; note = "（" + fmt.id.toUpperCase() + " 失败，已回退 WAV）";
            } catch(e2){ log("  回退 WAV 也失败：" + e2.message, "w"); }
          }
          if(!m){
            try {
              m = await mixAndEncode(audioCtx, [], samples, Object.assign({}, base, {format: "wav"}));
              fmt2 = wav; note = "（混音不可用，已生成静音）";
            } catch(e3){ log("  静音退路也失败：" + e3.message, "e"); }
          }
          if(!m){ out.warnings.push("音频生成彻底失败：" + e1.message + "（该难度只导出 .osu）"); }
        }
        if(m){
          if(wantShared) sharedAudio = {m, fmt: fmt2};
          const cost = Date.now() - tEnc;
          // MP3 是纯 JS 编码（实测约 10~12× 实时，4 分钟歌 ~20 秒）；把耗时写进日志，避免用户以为卡死
          if(cost > 800) log("  （编码/混音耗时 " + (cost / 1000).toFixed(1) + " 秒）");
          take(m, fmt2, note);
        }
      }
    }

    const tags = buildTags(opts, {file: header.fileName, noter, songid: header.songid, title, artist,
                                  diff: DIFFS[idx].name, level: header.levels[idx]});
    const text = buildOsuText({
      header, chart:{level: header.levels[idx], noteCount: header.noteCounts[idx]},
      meta:{ title, artist, noter, tags, od:opts.od, hp:opts.hp, serverTag:opts.serverTag, diffName:sfx.version,
             ...(sampleMeta || {}) },
      timingPoints: built.timingPoints,
      hitObjects: built.hitObjects,
      audioFilename, musicOffset, coverName,
      stats: built.stats,
    });
    const repairText = describeRepairs(built.stats);
    if(repairText) log("  修正 " + DIFFS[idx].name + " → " + repairText, "w");
    const osuName = leafName + sfx.file + ".osu";
    out.files.push({name:osuName, data:new TextEncoder().encode(text)});
    if(!out.preview) out.preview = {name: osuName, text};
    const problems = validateOsuText(text);
    if(problems.length){
      out.warnings.push(osuName + " 自检发现 " + problems.length + " 处问题");
      for(const p of problems.slice(0, 3)) log("  ⚠ 自检：" + p, "w");
    }
    log("  " + DIFFS[idx].name + " → " + osuName + "（" + built.hitObjects.length + " 个物件 / "
        + built.timingPoints.length + " 个时间点）");
    if(onProgress) onProgress(idx);
    sharedAudio = opts.audioMode === "shared" ? sharedAudio : null;   // 及时释放内存
  }
  if(opts.audioMode === "keysound" && !samples.size)
    out.warnings.push(song.ojmFile ? "OJM 解析失败或为空" : "缺少同名 .ojm");
  return out;
}
/** 难度后缀策略：与原版一致 —— 单难度不加后缀；多难度时 EX/NX 加、HX 的 fileName 不加但 Version 加 */
function suffixPlan(opts, idx, count){
  if(opts.suffixMode === "none") return {version:null, file:""};
  if(opts.suffixMode === "all")  return {version:DIFFS[idx].verSuffix, file:DIFFS[idx].fileSuffix};
  if(count === 1) return {version:null, file:""};              // 相当于原版默认（只转 HX，difficulty=null）
  return {version:DIFFS[idx].verSuffix, file:DIFFS[idx].fileSuffix};
}

export { convertOneSong, suffixPlan };
