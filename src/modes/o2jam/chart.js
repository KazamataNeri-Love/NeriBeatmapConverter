// O2Jam 专属：OJN 事件流 → 中间表示（timingPoints / hitObjects / audioObjects / stats）
// 对齐 luzianu.ChartConverter.toOsu；异常 Note 修正也在这里（O2Jam 数据的毛病，别的模式不需要）。
//
// 注意：这里只产出数据，不拼 .osu 文本 —— 写出统一走 core/osu/writer.js。

import { CH_AUTOPLAY, CH_BGA, CH_BPM_CHANGE, CH_MEASURE, CH_NONE, CH_STOP, CH_TIME_SIGNATURE } from "./ojn.js";
import { COLUMN_X, HOLD_OPEN, SHORT_NOTE } from "../../core/util.js";
import { timingPointNoSV, timingPointSimple } from "../../core/osu/writer.js";

/* =====================================================================
   OJN → 中间表示（对齐 luzianu.ChartConverter + luzianu.osu.OsuChart）
   ===================================================================== */
/** 移植 ChartConverter.toOsu 的核心：返回 {timingPoints, hitObjects, audioObjects, stats}
    repair = {enabled:boolean} —— 异常 Note 自动修正开关（默认开） */
function buildChart(chartBpm, events, useSV, repair){
  const rp = Object.assign({enabled:true}, repair || {});
  const timingPoints = timingPointSimple(0, chartBpm, useSV, chartBpm).slice();
  const hitObjects = [];
  const audioObjects = [];
  const stats = {closedHold:0, shortHold:0, duplicate:0, tapInHold:0, mergedHold:0,
                 negativeTime:0, danglingRelease:0, demotedHold:0, keptAtHoldEnd:0, tapAtHoldEnd:0, longHold:0};
  const beatMs = 60000 / (chartBpm > 0 ? chartBpm : 120);
  // 异常长条（未闭合 / 零长 / 反向）统一修成「1/2 拍」。取长条自己那一刻的 BPM（随 BPM 变化事件走的
  // currentBpm），而不是头部 BPM，这样变速谱也不会补出长度不对的面条；30ms 下限只是防拍子极快时退化成 0 长。
  const halfBeatOf = (h) => Math.max(30, Math.round(((h.beatMs > 0 ? h.beatMs : beatMs)) / 2));

  let currentBpm = chartBpm;
  let lastBpmChangePosition = 0;
  let lastBpmChangeMeasure = 0;
  let timeOffset = 0;

  const lastMeasure = events.length ? events[events.length - 1].measure : 0;
  const timeSignatures = new Array(lastMeasure + 1).fill(1);
  for(const ev of events){
    if(ev.channel === CH_TIME_SIGNATURE)
      timeSignatures[ev.measure] = (ev.value <= 1e-10) ? 1 : ev.value;
  }

  for(const ev of events){
    const channel = ev.channel;
    if(channel === CH_STOP || channel === CH_BGA || channel === CH_MEASURE || channel === CH_NONE) continue;

    if(channel === CH_BPM_CHANGE){
      const prevBpm = currentBpm;
      currentBpm = ev.value;
      for(let i = lastBpmChangeMeasure; i < ev.measure; i++){
        if(timeSignatures[i] === undefined) timeSignatures[i] = 1;
        timeOffset += (1 - lastBpmChangePosition) * 60000 * 4 / prevBpm * timeSignatures[i];
        lastBpmChangePosition = 0;
        lastBpmChangeMeasure = i + 1;
      }
      const deltaPosition = ev.position - lastBpmChangePosition;
      timeOffset += deltaPosition * 60000 * 4 / prevBpm * (timeSignatures[ev.measure] || 1);
      lastBpmChangePosition = ev.position;
      lastBpmChangeMeasure = ev.measure;
      if(60000 / currentBpm >= 0.01){               // 防止 0.0 beatLength 让 osu 无限加载
        timingPoints.push(...timingPointSimple(timeOffset, currentBpm, useSV, chartBpm));
        if(!useSV) timingPoints.push(timingPointNoSV(timeOffset, currentBpm, chartBpm));
      }
    }

    for(let i = lastBpmChangeMeasure; i < ev.measure; i++){
      if(timeSignatures[i] === undefined) timeSignatures[i] = 1;
      timeOffset += (1 - lastBpmChangePosition) * 60000 * 4 / currentBpm * timeSignatures[i];
      lastBpmChangePosition = 0;
      lastBpmChangeMeasure = i + 1;
    }
    let time = timeOffset;
    time += (ev.position - lastBpmChangePosition) * 60000 * 4 / currentBpm;

    const column = channel - 1;                    // NOTE_1(3) → 0 ... NOTE_7(9) → 6
    if(column >= 0 && column < 7){
      // sampleId / sampleVolume 在「保留键音」模式下会变成每个音符的 hitSample
      if(ev.flag === "NONE"){
        hitObjects.push({_column:column, x:COLUMN_X[column], y:192, time:Math.trunc(time),
                         type:1, hitSound:0, endTime:SHORT_NOTE, hitSample:"0:0:0:0:",
                         sampleId: ev.value, sampleVolume: ev.volume});
      } else if(ev.flag === "HOLD"){
        hitObjects.push({_column:column, x:COLUMN_X[column], y:192, time:Math.trunc(time),
                         type:128, hitSound:0, endTime:HOLD_OPEN, hitSample:"0:0:0:0:",
                         sampleId: ev.value, sampleVolume: ev.volume,
                         beatMs: 60000 / (currentBpm > 0 ? currentBpm : (chartBpm > 0 ? chartBpm : 120))});
      } else if(ev.flag === "RELEASE"){
        let found = false;
        for(let i = hitObjects.length - 1; i >= 0; i--){
          const h = hitObjects[i];
          if(h._column === column && h.endTime === HOLD_OPEN){ h.endTime = Math.trunc(time); found = true; break; }
        }
        if(!found) stats.danglingRelease++;   // 原版的 "unconnected ln"，忽略这个 RELEASE
      }
    }

    if(channel !== CH_BPM_CHANGE && channel !== CH_MEASURE && channel !== CH_STOP &&
       channel !== CH_TIME_SIGNATURE && channel !== CH_NONE){
      if(ev.flag === "NONE" || ev.flag === "HOLD")
        audioObjects.push({time, sampleId: ev.value, volume: ev.volume, pan: ev.pan,
                           autoplay: channel === CH_AUTOPLAY});
    }
  }

  // ★ 修正 A（排序/合并之前做）：数据里缺 type 3（RELEASE）事件时，长条会停在 endTime = -1，
  // 写出 "…,128,0,-1,…" 让 osu! 拒绝整张图。修正 = 一律改成 1/2 拍长度。
  if(rp.enabled) closeDanglingHolds(hitObjects, halfBeatOf, stats);
  // ★ 修正 G（可选，阈值 > 0 才生效）：超长长条 —— 长度超过 N 拍视为长度异常，同样压成 1/2 拍。
  // 放在合并之前，否则过长的长条会先把后面的音符当成“夹音”吃掉，再截断也救不回来。
  if(rp.enabled && rp.maxBeats > 0){
    for(const h of hitObjects){
      if(h.type !== 128 || h.endTime === HOLD_OPEN) continue;
      const beat = h.beatMs > 0 ? h.beatMs : beatMs;
      if((h.endTime - h.time) / beat > rp.maxBeats){
        h.endTime = h.time + halfBeatOf(h);
        stats.longHold++;
      }
    }
  }

  // postProcessHitObject：同列 LN 重叠时的合并/丢弃
  hitObjects.sort((a,b) => a.time - b.time);
  const processed = [];
  // ★ 修正 E：原版把 holdEndTimes 初始化成 0，于是「时间正好 = 0」的短音会被 `time <= 0`
  // 当成“夹在长条里”而静默丢掉（若首个物件是长条，原版还会直接 NoSuchElementException 抛异常导致整首跳过）。
  // 用 -1 做哨兵，二者都不会再发生。
  const holdEndTimes = new Array(7).fill(-1);
  for(const h of hitObjects){
    const col = h._column;
    if(h.endTime === SHORT_NOTE){
      // ★ 修正 F：原版注释写的是 "a short note that is inbetween hold start and hold end"，
      // 但代码是 `time <= holdEndTimes`，于是「正好落在长条末端同刻」的音符也被静默丢掉了。
      // 这不只丢数据：修正 A 把未闭合长条的尾部补到「同列下一个物件」后，那个物件恰好就在末端，
      // 会被这条规则当场吃掉 —— 补尾等于白补。所以开启修正时末端同刻保留，严格在里面才丢。
      if(h.time < holdEndTimes[col]){ stats.tapInHold++; continue; }
      if(h.time === holdEndTimes[col]){
        if(rp.enabled) stats.keptAtHoldEnd++;
        else { stats.tapAtHoldEnd++; continue; }
      }
    } else {
      if(h.time <= holdEndTimes[col]){
        const target = processed.find(o => o._column === col && o.endTime === holdEndTimes[col]);
        if(target){ target.endTime = h.endTime; stats.mergedHold++; }
        holdEndTimes[col] = h.endTime;
        continue;
      }
      holdEndTimes[col] = h.endTime;
    }
    processed.push(h);
  }

  // ★ 修正 B：零长 / 反向长条（endTime <= time）——同样一律改成 1/2 拍；
  // 关掉修复时降级成普通 Note 以保证可导入
  for(const h of processed){
    if(h.type !== 128) continue;
    if(h.endTime === HOLD_OPEN || !(h.endTime > h.time)){
      if(rp.enabled){ h.endTime = h.time + halfBeatOf(h); stats.shortHold++; }
      else { h.endTime = SHORT_NOTE; h.type = 1; stats.demotedHold++; }
    }
  }

  // ★ 修正 C：同列同刻的重复短音去重（o2jam 数据里偶见，写出后会在同一点堆叠）
  let finalObjects = processed;
  if(rp.enabled){
    const seen = new Set();
    finalObjects = [];
    for(const h of processed){
      if(h.type === 1){
        const k = h._column + ":" + h.time;
        if(seen.has(k)){ stats.duplicate++; continue; }
        seen.add(k);
      }
      finalObjects.push(h);
    }
  }
  return {timingPoints, hitObjects: finalObjects, audioObjects, stats};
}

/** 未闭合长条（endTime = -1）一律按 1/2 拍补尾 */
function closeDanglingHolds(hitObjects, halfBeatOf, stats){
  for(const h of hitObjects){
    if(h.type !== 128 || h.endTime !== HOLD_OPEN) continue;
    h.endTime = h.time + halfBeatOf(h);
    stats.closedHold++;
  }
}

export { buildChart, closeDanglingHolds };
