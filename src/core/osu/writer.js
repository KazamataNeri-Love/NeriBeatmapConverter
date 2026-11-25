// .osu 写出器（kernel：所有「产物是 osu 谱面」的模式共用这一份）
//
// 这里是全项目唯一允许拼 .osu 文本的地方。模式只负责产出数据
// （timingPoints / hitObjects / audioObjects / meta），绝不允许自己拼字符串 ——
// 否则两个模式半年后就会产出两种「合法但不一样」的 .osu，没人说得清哪种对。
//
// 来源：原 src/chart.js 的写出部分（对齐 luzianu.osu.OsuChart.export）。

/* =====================================================================
   .osu 模板 / 格式化 / 自检
   ===================================================================== */
function timingPointSimple(time, bpm, useSV, chartBpm){
  const tp = {time, beatLength: 60000 / bpm, meter:4, sampleSet:0, sampleIndex:0,
              volume:30, uninherited:true, effects:0};
  return [tp];
}
function timingPointNoSV(time, bpm, chartBpm){
  const factor = chartBpm / bpm;
  return {time, beatLength: -100 / factor, meter:0, sampleSet:0, sampleIndex:0,
          volume:30, uninherited:false, effects:0};
}
function formatTimingPoint(t){
  const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
  return [f2(t.time), f2(t.beatLength), t.meter, t.sampleSet, t.sampleIndex, t.volume, t.uninherited?1:0, t.effects].join(",");
}
function formatHitObject(h){
  const DEFAULT_SAMPLE = "0:0:0:0:";
  if(h.type === 1) return [h.x, h.y, h.time, h.type, h.hitSound, h.hitSample].join(",");
  // 长音的规范格式是「第 6 个逗号字段 = endTime:hitSample」（osu 只读 split[5] 再按 ':' 拆，见
  // osu.Game/Rulesets/Objects/Legacy/ConvertHitObjectParser.cs 的 Hold 分支）。
  // 原版 o2jam-to-osu 写成了两个字段（…,<end>,0:0:0:0:），endTime 恰好还能解出来、但 hitSample 被忽略；
  // 所以只有带键音文件名时才改成规范写法，否则保持原版形式以维持逐行一致。
  if(h.hitSample && h.hitSample !== DEFAULT_SAMPLE)
    return [h.x, h.y, h.time, h.type, h.hitSound, h.endTime + ":" + h.hitSample].join(",");
  return [h.x, h.y, h.time, h.type, h.hitSound, h.endTime, h.hitSample].join(",");
}

/** 占位符展开：{noter} {songid} {server} {title} {artist} {diff} {level} {file} */
function expandPlaceholders(template, ctx){
  return String(template === undefined || template === null ? "" : template)
    .replace(/\{(noter|songid|server|title|artist|diff|level|file)\}/g,
             (_, k) => (ctx[k] === undefined || ctx[k] === null ? "" : String(ctx[k])))
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** [Metadata] 的 Tags 行：keep = 原版行为，append / replace = 用自定义内容
    base 可换掉“O2Jam 5ynt3ck convert”那段前缀（BMS 等别的来源用），不传则与老产物逐字一致 */
function buildTags(o, ctx, base){
  const head = base !== undefined ? base
    : ((o.serverTag ? ('O2Jam ' + o.serverTag) : 'O2Jam') + ' 5ynt3ck convert');
  const baseTags = head + ' ' + ctx.file;
  const mode = o.tagMode || 'keep';
  if(mode === 'keep') return baseTags;
  // {server} 来自选项，统一在这里合进上下文，调用方不必自己塞
  const custom = expandPlaceholders(o.tagTemplate, Object.assign({}, ctx, {server: o.serverTag || ''}));
  if(!custom) return baseTags;
  return mode === 'replace' ? custom : baseTags + ' ' + custom;
}

/**
 * 生成 .osu 文本（对齐 OsuChart.export）
 *
 * ctx = { header, chart, meta, timingPoints, hitObjects, audioFilename, musicOffset, coverName, stats }
 * meta 里允许的来源相关字段（不带时保持 O2Jam 原行为，保证老产物逐字节不变）：
 *   source        —— Source: 行，默认 'O2Jam'
 *   versionPrefix —— Version 前缀，默认 '[O2Jam] '
 *   circleSize    —— CircleSize，默认 7
 */
function buildOsuText(ctx){
  const {header, chart, meta, timingPoints, hitObjects, audioFilename, musicOffset, coverName} = ctx;
  const odOverride = meta.od, hp = meta.hp, serverTag = meta.serverTag, diffName = meta.diffName;
  const source = meta.source === undefined ? "O2Jam" : meta.source;
  const versionPrefix = meta.versionPrefix === undefined ? "[O2Jam] " : meta.versionPrefix;
  const circleSize = meta.circleSize === undefined ? 7 : meta.circleSize;
  let odString = "7";
  if(chart.level >= 80) odString = "6";
  if(chart.level >= 100) odString = "5";
  if(Number.isFinite(odOverride)) odString = String(odOverride);

  let levelString = "[" + chart.level + "]";
  if(serverTag) levelString = "[" + serverTag + "] " + levelString;
  if(diffName) levelString += diffName;

  const bgString = coverName ? ('0,0,"' + coverName + '",0,0') : "";
  // 保留键音模式：BGM 用 [Events] 的 Sample 行播（音频轨只放最大的那条 BGM 样本，甚至不放）
  const eventLines = [];
  if(bgString) eventLines.push(bgString);
  if(meta.sampleEvents) for(const se of meta.sampleEvents)
    eventLines.push('Sample,' + se.time + ',0,"' + se.file + '",' + se.volume);
  const L = [];
  const head = ["osu file format v14","","[General]"];
  if(audioFilename) head.push("AudioFilename: " + audioFilename);   // 保留键音且没有 BGM 时就不写这行
  head.push("AudioLeadIn: 0","PreviewTime: -1","Countdown: 0",
    "SampleSet: Soft","StackLeniency: 0.7","Mode: 3","LetterboxInBreaks: 0","SpecialStyle: 1",
    "WidescreenStoryboard: 0","","[Editor]","DistanceSpacing: 1","BeatDivisor: 6","GridSize: 4",
    "TimelineZoom: 1","","[Metadata]",
    "Title:" + meta.title, "Title:" + meta.title,
    "Artist:" + meta.artist, "ArtistUnicode:" + meta.artist,
    "Creator:" + meta.noter,
    "Version:" + versionPrefix + levelString,
    "Source:" + source,
    "Tags:" + (meta.tags !== undefined ? meta.tags
      : ((serverTag ? ("O2Jam " + serverTag) : "O2Jam") + " 5ynt3ck convert " + header.fileName)),
    "","[Difficulty]",
    "HPDrainRate:" + hp,"CircleSize:" + circleSize,"OverallDifficulty:" + odString,"ApproachRate:0",
    "SliderMultiplier:1","SliderTickRate:1","","[Events]", ...eventLines, "");
  L.push(...head);

  let inheritedCount = 0;
  for(const t of timingPoints) if(!t.uninherited) inheritedCount++;
  L.push("[TimingPoints]");
  for(let i = 0; i < timingPoints.length; i++){
    const t = timingPoints[i];
    t.time -= musicOffset;
    t.time = Math.max(0, t.time);
    if(i + 1 < timingPoints.length){
      const next = timingPoints[i + 1];
      if(next.time <= musicOffset && next.uninherited) continue;
    }
    if(i === timingPoints.length - 1 && !t.uninherited && inheritedCount <= 1) continue;
    L.push(formatTimingPoint(t));
  }
  L.push("[HitObjects]");
  const st = ctx.stats;
  for(const h of hitObjects){
    // 原版的 HitObject.time / endTime 是 int，Java 的 `t.time -= musicOffset` 复合赋值会隐式截断；
    // JS 不存在这个行为，必须显式取整。（musicOffset 现在恒为 0，保留取整以应对将来引入偏移。）
    const endBefore = h.endTime;                     // 原版先判断再减，顺序不能变
    let t = Math.trunc(h.time - musicOffset);
    if(t < 0){ if(st) st.negativeTime = (st.negativeTime || 0) + 1; t = 0; }   // ★ 修正 D：负时间钓到 0
    h.time = t;
    if(endBefore > 0){
      const e = Math.trunc(endBefore - musicOffset);
      h.endTime = e > h.time ? e : h.time + 1;       // 顺手保证长条长度 > 0
    }
    // 保留键音：把音符自带的样本写进 hitSample（osu 命中时播这个文件）
    if(meta.sampleNames && h.sampleId !== undefined){
      const file = meta.sampleNames.get(h.sampleId);
      if(file){
        const vol = Math.max(1, Math.min(100, Math.round((h.sampleVolume === undefined ? 1 : h.sampleVolume) * 100)));
        h.hitSample = "0:0:0:" + vol + ":" + file;
      }
    }
    L.push(formatHitObject(h));
  }
  return L.join("\n") + "\n";
}

/** 修正项的中文名（用于日志/预览） */
const REPAIR_LABELS = {
  closedHold: "未闭合长条补尾", shortHold: "零长/反向长条延长", duplicate: "同刻重复音去重",
  tapInHold: "长条中间夹音丢弃", mergedHold: "重叠长条合并", negativeTime: "负时间钓零",
  longHold: "超长长条压成半拍",
  keptAtHoldEnd: "长条末端同刻音符保留", tapAtHoldEnd: "长条末端同刻音符丢弃（关修正时）",
  demotedHold: "未闭合长条降级为 Note", danglingRelease: "孤立结束事件忽略",
};
/** 把修正统计拼成一行人类可读文本（全 0 时返回空串） */
function describeRepairs(stats){
  if(!stats) return "";
  const parts = [];
  for(const k of Object.keys(REPAIR_LABELS)) if(stats[k]) parts.push(REPAIR_LABELS[k] + " " + stats[k]);
  return parts.join("、");
}

/** 输出自检：返回问题列表（空数组 = 一切正常）。用于转换后立即发现坏谱。 */
function validateOsuText(text){
  const problems = [];
  const lines = String(text).split("\n");
  if(lines[0] !== "osu file format v14") problems.push("首行不是 osu file format v14");
  const sect = {};
  let cur = null;
  for(const l of lines){
    const m = /^\[(\w+)\]$/.exec(l);
    if(m){ cur = m[1]; sect[cur] = []; continue; }
    if(cur && l.trim()) sect[cur].push(l);
  }
  const isInt = (s) => /^-?\d+$/.test(s);
  for(const l of sect.TimingPoints || []){
    const p = l.split(",");
    if(p.length !== 8){ problems.push("TimingPoint 字段数异常：" + l); continue; }
    const t = Number(p[0]), bl = Number(p[1]);
    if(!isFinite(t) || !isFinite(bl)) problems.push("TimingPoint 含 NaN/Inf：" + l);
    else if(bl === 0) problems.push("beatLength = 0（osu! 会无限加载）：" + l);
  }
  for(const l of sect.HitObjects || []){
    const p = l.split(",");
    if(p.length !== 6 && p.length !== 7){ problems.push("HitObject 字段数异常：" + l); continue; }
    if(!isInt(p[0]) || !isInt(p[1]) || !isInt(p[2])) problems.push("HitObject 坐标/时间不是整数：" + l);
    if(p.length === 7 && p[3] === "128"){
      if(!isInt(p[5])) problems.push("LN 结束时间不是整数：" + l);
      else if(Number(p[5]) <= Number(p[2])) problems.push("LN 结束 <= 开始：" + l);
    }
  }
  if(!(sect.TimingPoints || []).length) problems.push("没有 TimingPoint");
  if(!(sect.HitObjects || []).length) problems.push("没有 HitObject");
  return problems;
}

export { REPAIR_LABELS, buildOsuText, buildTags, describeRepairs, expandPlaceholders,
         formatHitObject, formatTimingPoint, timingPointNoSV, timingPointSimple, validateOsuText };
