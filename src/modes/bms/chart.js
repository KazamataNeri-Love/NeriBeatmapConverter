// BMS 时间轴 + 中间表示（timingPoints / hitObjects / audioObjects / stats）
//
// BMS 的时间语义比 OJN 复杂一档，这里集中处理：
//   · 小节长度        #mmm02:<倍数>（默认 1 = 4 拍；0.5 = 2 拍）
//   · BPM 变更        #mmm03:<hex 两位> / #mmm08:<#BPMxx 索引>
//   · STOP            #mmm09:<#STOPxx 索引>，单位是 1/192 全音符（乘 4 拍的时长折算）
//   · 皿（scratch）   通道 16 / 26：可按 8K 摆第 0 列，也可只当 Sample 事件播
//   · 长音            通道 5x/6x（#LNTYPE 1 成对；#LNTYPE 2 当作结束标记）+ #LNOBJ
//
// 换算方式：先把 (小节, 小节内比例) 压成「绝对拍」，再按 BPM 段积分成毫秒，最后叠加 STOP。
// 这套算法在 tools/test-suite.js 的 BMS 用例里与 .NET 参考实现（BmsToOsu）逐毫秒对齐过。

import { HOLD_OPEN, SHORT_NOTE } from '../../core/util.js';

const B36 = (s) => parseInt(s, 36);

const KEYS_1P = { '11':0, '12':1, '13':2, '14':3, '15':4, '18':5, '19':6 };
const KEYS_2P = { '21':0, '22':1, '23':2, '24':3, '25':4, '28':5, '29':6 };
const LN_1P   = { '51':0, '52':1, '53':2, '54':3, '55':4, '58':5, '59':6 };
const LN_2P   = { '61':0, '62':1, '63':2, '64':3, '65':4, '68':5, '69':6 };
/** 通道第 2 位 → 琴键序号（10=第 0 键 … 15=第 4 键，18/19=第 5/6 键） */
const KEY_IDX = { '1':0, '2':1, '3':2, '4':3, '5':4, '8':5, '9':6 };

/** 列中心：等分 512 宽（7K 也得 36/109/182/256/329/402/475 —— 与 osu 常规 7K 一致） */
export function columnX(column, keys){
  return Math.floor(512 * (column + 0.5) / keys);
}

/* =====================================================================
   键型布局：BMS 的常见形态是 5K1S / 7K1S / 10K2S / 14K2S
   （1S = 单手皿、2S = 双手皿；双人谱两排琴键，皿分别在最左、最右）
   列序与 .NET 参考实现（BmsToOsu 的 lane 0..15）完全一致：
     1P：[皿] 1 2 3 4 5 [6 7]  2P： 1 2 3 4 5 [6 7] [皿]
   ===================================================================== */
const LAYOUT_BY_COLUMNS = {
  5:  { sides: 1, keysPerSide: 5, scratch: false },
  6:  { sides: 1, keysPerSide: 5, scratch: true  },
  7:  { sides: 1, keysPerSide: 7, scratch: false },
  8:  { sides: 1, keysPerSide: 7, scratch: true  },
  10: { sides: 2, keysPerSide: 5, scratch: false },
  12: { sides: 2, keysPerSide: 5, scratch: true  },
  14: { sides: 2, keysPerSide: 7, scratch: false },
  16: { sides: 2, keysPerSide: 7, scratch: true  },
};

/** 每排宽度（含皿列） */
export function layoutBlockWidth(layout){
  return layout.keysPerSide + (layout.scratch ? 1 : 0);
}
/** 总列数 */
export function layoutColumns(layout){
  const l = typeof layout === 'number' ? LAYOUT_BY_COLUMNS[layout] : layout;
  return layoutBlockWidth(l) * l.sides;
}
/** 显示名：7K / 7K1S / 14K2S … */
export function layoutLabel(layout){
  if (!layout || !layout.sides) return '?';
  const k = layout.keysPerSide * layout.sides;
  return k + 'K' + (layout.scratch ? (layout.sides === 2 ? '2S' : '1S') : '');
}
/** 用总列数（5/6/7/8/10/12/14/16）反推布局 */
export function layoutFromColumns(columns){
  const base = LAYOUT_BY_COLUMNS[Number(columns)];
  if (!base) throw new Error('不支持的键型列数：' + columns + '（可用 5/6/7/8/10/12/14/16）');
  return Object.assign({}, base, { columns: Number(columns) });
}

/**
 * 扫描谱面用了哪些通道（不做决策，只报事实）。
 * 返回 { sides, seven, scratch, p1, p2, player }：
 *   p1/p2   两侧各自的音符事件数
 *   player  #PLAYER 原值（0 = 没写）
 *   sides   1 = 单人，2 = 双人。判定顺序：
 *           ① #PLAYER 3 → 双人；#PLAYER 1/2 → 单人（2P 侧的音符并进同一条键排）
 *           ② 没写 #PLAYER 才看内容：2P 音符占到 1P 的四分之一以上才算双人
 *              （实测 300.妖精的尾巴 有 1 个孤立的 2P 音符，按内容猜会把整张图撑成 16 列）
 *   seven   true = 用到第 6/7 键（18/19 或 28/29）
 *   scratch true = 用到皿（16/26 或长音皿 56/66）
 */
export function analyzeChart(parsed){
  let p1 = 0, p2 = 0, seven = false, scr = false;
  for (const e of parsed.entries){
    const ch = e.ch;
    if (!/^[1256][1-9]$/.test(ch)) continue;
    if (e.msg.length < 2 || e.msg.length % 2) continue;
    let n = 0;
    for (let i = 0; i < e.msg.length; i += 2) if (e.msg.slice(i, i + 2) !== '00') n++;
    if (!n) continue;
    const side2 = ch[0] === '2' || ch[0] === '6';
    if (side2) p2 += n; else p1 += n;
    if (ch === '16' || ch === '56' || ch === '26' || ch === '66'){ scr = true; continue; }
    if (ch[1] === '8' || ch[1] === '9') seven = true;
  }
  const player = parsed.meta.player || 0;
  // 两侧都「真的在用」才算双人：2P 至少 3 个音符、且不少于 1P 的四分之一。
  // 实测 847.Reverse MX 写了 #PLAYER 3，但 2P 只有 8 个（1P 1600）→ 判单人，
  // 否则会把整张谱挤进 16 列的左半边。
  const bothSidesUsed = p2 > 0 && p2 >= Math.max(3, p1 * 0.25);
  let sides;
  if (player === 3) sides = bothSidesUsed ? 2 : 1;
  else if (player === 1 || player === 2) sides = 1;
  else sides = bothSidesUsed ? 2 : 1;
  return { sides, seven, scratch: scr, p1, p2, player };
}

/**
 * 单谱面猜布局（BMS 没有「几键」头字段，只能看通道）。
 * 键数默认跟着 seven：用到 18/19 就是 7 键，否则 5 键。
 * 多难度歌曲请在 prepareSong 里先合并各难度的事实（见那里的说明），别让「简单难度只弹前 5 列」
 * 把整张图判成 5K。
 *
 * opts.keysPerSide 可强制键数；opts.plate：column（默认，皿成列）| sample | drop
 */
export function detectLayout(parsed, opts = {}){
  const a = analyzeChart(parsed);
  const plate = opts.plate === undefined ? 'column' : opts.plate;
  const layout = {
    sides: a.sides,
    keysPerSide: opts.keysPerSide || (a.seven ? 7 : 5),
    scratch: a.scratch && plate === 'column',
  };
  layout.columns = layoutColumns(layout);
  return layout;
}

/** 绝对拍 → 毫秒的时间轴（含 STOP） */
export function buildTimeline(parsed, opts = {}){
  const useStops = opts.stops !== false;
  const scaleOf = new Map();
  const bpmEv = [];
  const stops = [];

  for (const e of parsed.entries){
    if (e.ch === '02'){
      const v = parseFloat(e.msg);
      if (isFinite(v) && v > 0) scaleOf.set(e.m, v);
      continue;
    }
    if (e.ch !== '03' && e.ch !== '08' && e.ch !== '09') continue;
    const n = e.msg.length >> 1;
    for (let i = 0; i < n; i++){
      const msg = e.msg.slice(i * 2, i * 2 + 2).toUpperCase();
      if (msg === '00') continue;
      const frac = n > 1 ? i / n : 0;
      if (e.ch === '03'){
        const b = parseInt(msg, 16);
        if (b > 0) bpmEv.push({ m: e.m, frac, bpm: b });
      } else if (e.ch === '08'){
        const id = B36(msg);
        if (parsed.bpmIdx.has(id)) bpmEv.push({ m: e.m, frac, bpm: parsed.bpmIdx.get(id) });
      } else {
        const id = B36(msg);
        if (parsed.stopIdx.has(id)) stops.push({ m: e.m, frac, dur: parsed.stopIdx.get(id) });
      }
    }
  }

  const maxMeasure = parsed.entries.reduce((a, e) => Math.max(a, e.m), 0) + 1;
  const beatsAt = new Array(maxMeasure + 2).fill(0);
  for (let m = 0; m <= maxMeasure; m++) beatsAt[m + 1] = beatsAt[m] + 4 * (scaleOf.get(m) ?? 1);
  const beatOf = (m, frac) => beatsAt[m] + frac * 4 * (scaleOf.get(m) ?? 1);

  const segs = [{ beat: 0, bpm: parsed.meta.bpm > 0 ? parsed.meta.bpm : 130 },
                ...bpmEv.map(e => ({ beat: beatOf(e.m, e.frac), bpm: e.bpm }))]
    .sort((a, b) => a.beat - b.beat);

  function bpmAt(beat){
    let bpm = segs[0].bpm;
    for (const s of segs){ if (s.beat <= beat) bpm = s.bpm; else break; }
    return bpm;
  }
  const stopBeats = useStops
    ? stops.map(s => {
        const b = beatOf(s.m, s.frac);
        return { beat: b, ms: (s.dur / 192) * 4 * 60000 / bpmAt(b) };
      }).sort((a, b) => a.beat - b.beat)
    : [];

  /** strict = true：正好落在 STOP 位置的物件发生在「停住之前」，不计这次停止 */
  function msAtBeat(beat, strict = true){
    let t = 0, prev = 0, bpm = segs[0].bpm;
    for (const s of segs){
      if (s.beat >= beat) break;
      t += (s.beat - prev) * 60000 / bpm;
      prev = s.beat; bpm = s.bpm;
    }
    t += (beat - prev) * 60000 / bpm;
    for (const st of stopBeats){
      if (strict ? st.beat < beat : st.beat <= beat) t += st.ms;
      else if (st.beat > beat) break;
    }
    return t;
  }

  return {
    beatsAt, beatOf, bpmAt, segs, stops: stopBeats, maxMeasure,
    msAt: (m, frac) => msAtBeat(beatOf(m, frac)),
    msAtBeat,
    durationMs: msAtBeat(beatsAt[maxMeasure], false),
  };
}

/** 解析出的 BMS → 中间表示；返回 {timingPoints, hitObjects, audioObjects, stats, keys, layout} */
export function buildChart(parsed, opts = {}){
  const layout = opts.layout
    || (opts.keys ? layoutFromColumns(Number(opts.keys)) : detectLayout(parsed, opts));
  const columns = layout.columns || layoutColumns(layout);
  const tl = opts.timeline || buildTimeline(parsed, { stops: opts.stops });
  const blockW = layoutBlockWidth(layout);           // 每排宽度（含皿列）
  const scratch1Col = layout.scratch ? 0 : -1;       // 1P 皿：最左
  const scratch2Col = layout.scratch ? columns - 1 : -1;   // 2P 皿：最右
  const keyShift = layout.scratch ? 1 : 0;           // 有皿列时琴键整体右移一格

  const stats = { closedHold: 0, shortHold: 0, duplicate: 0, tapInHold: 0, mergedHold: 0,
                  negativeTime: 0, danglingRelease: 0, demotedHold: 0, keptAtHoldEnd: 0,
                  tapAtHoldEnd: 0, longHold: 0, scratchDropped: 0, dropped: 0, merged2P: 0 };

  // 先按时间排好，逐条处理（BGM 与音符混在一起，顺序无关，但长音配对需要有序）
  const rows = [];
  for (const e of parsed.entries){
    const ch = e.ch;
    if (ch === '01'){
      if (e.msg.length % 2) continue;
      const n = e.msg.length >> 1;
      for (let i = 0; i < n; i++){
        const msg = e.msg.slice(i * 2, i * 2 + 2).toUpperCase();
        if (msg === '00') continue;
        rows.push({ kind: 'bgm', m: e.m, frac: n > 1 ? i / n : 0, id: B36(msg) });
      }
      continue;
    }
    const isNote = KEYS_1P[ch] !== undefined || KEYS_2P[ch] !== undefined;
    // 长音通道：5x / 6x 全部（含 56/66 这两个「皿的长音」）；短皿是 16/26
    const isLn = /^[56][1-9]$/.test(ch);
    const isScratch = ch === '16' || ch === '26';
    if (!isNote && !isLn && !isScratch) continue;
    if (e.msg.length % 2) continue;
    const n = e.msg.length >> 1;
    for (let i = 0; i < n; i++){
      const msg = e.msg.slice(i * 2, i * 2 + 2).toUpperCase();
      if (msg === '00') continue;
      rows.push({ kind: 'note', ch, m: e.m, frac: n > 1 ? i / n : 0, id: B36(msg) });
    }
  }
  rows.sort((a, b) => tl.beatOf(a.m, a.frac) - tl.beatOf(b.m, b.frac));

  const hitObjects = [];
  const audioObjects = [];
  const openLn = new Map();          // lane → 物件（等待结束的 LN）

  const laneOf = (row) => {
    const ch = row.ch;
    const side2 = ch[0] === '2' || ch[0] === '6';       // 2P 侧（21-29 / 61-69）
    const digit = ch[1];
    const solo = layout.sides < 2;                       // 单侧谱：2P 通道并进同一排
    // 皿：16/56 = 1P（最左），26/66 = 2P（最右）—— 双人谱里双手皿各归各的边
    if (digit === '6'){
      const col = (side2 && !solo) ? scratch2Col : scratch1Col;
      if (col < 0){ stats.scratchDropped++; return -1; }
      return col;
    }
    const idx = KEY_IDX[digit];
    if (idx === undefined){ stats.dropped++; return -1; }
    if (idx >= layout.keysPerSide){ stats.dropped++; return -1; }   // 5K 谱里冒出 18/19
    if (side2 && !solo) return blockW + idx;             // 2P 块 = [1..7][皿]
    if (side2) stats.merged2P++;                         // 单侧谱：2P 音符并到 1P 同列
    return keyShift + idx;                               // 1P 块 = [皿][1..7]
  };

  for (const row of rows){
    const beat = tl.beatOf(row.m, row.frac);
    const time = Math.trunc(tl.msAtBeat(beat));
    if (row.kind === 'bgm'){
      audioObjects.push({ time, sampleId: row.id, volume: 1, pan: 0, autoplay: true });
      continue;
    }
    const lane = laneOf(row);
    if (lane < 0) continue;
    const isLnChannel = /^[56][1-9]$/.test(row.ch);

    // #LNOBJ：普通音符里取值为 lnobj 的那个，用来结束同列上一个音符
    if (parsed.meta.lnobj && row.id === B36(parsed.meta.lnobj) && !isLnChannel){
      const last = [...hitObjects].reverse().find(o => o._column === lane && o.type === 1);
      if (last){ last.type = 128; last.endTime = time; last.beatMs = 60000 / tl.bpmAt(beat); }
      continue;
    }

    if (isLnChannel){
      if (parsed.meta.lntype === 2){
        // LNTYPE 2：5x 物件是「结束标记」，起点是同列上一个普通音符
        const last = [...hitObjects].reverse().find(o => o._column === lane && o.type === 1);
        if (last){ last.type = 128; last.endTime = time; last.beatMs = 60000 / tl.bpmAt(beat); }
        else stats.danglingRelease++;
        continue;
      }
      const open = openLn.get(lane);
      if (open){ open.endTime = time; openLn.delete(lane); }
      else {
        const h = { _column: lane, x: columnX(lane, columns), y: 192, time, type: 128, hitSound: 0,
                    endTime: HOLD_OPEN, hitSample: '0:0:0:0:', sampleId: row.id,
                    beatMs: 60000 / tl.bpmAt(beat) };
        openLn.set(lane, h);
        hitObjects.push(h);
      }
      continue;
    }

    // 普通音符：落在未闭合长音区间内的按「夹音」丢弃（与 O2Jam 的修正口径一致）
    const open = openLn.get(lane);
    if (open && time > open.time){ stats.tapInHold++; continue; }
    if (open && time === open.time){ stats.duplicate++; continue; }
    hitObjects.push({ _column: lane, x: columnX(lane, columns), y: 192, time, type: 1, hitSound: 0,
                      endTime: SHORT_NOTE, hitSample: '0:0:0:0:', sampleId: row.id });
  }

  // 未闭合 / 零长 / 反向长条 → 1/2 拍（关掉修正时降级成普通音符，保证能导入）
  const repair = opts.repair !== false;
  for (const h of hitObjects){
    if (h.type !== 128) continue;
    const dangling = h.endTime === HOLD_OPEN;
    if (!dangling && h.endTime > h.time) continue;
    if (repair){
      h.endTime = h.time + Math.max(30, Math.round((h.beatMs || 500) / 2));
      if (dangling) stats.closedHold++; else stats.shortHold++;
    } else {
      h.endTime = SHORT_NOTE; h.type = 1; stats.demotedHold++;
    }
  }

  // 同列同刻去重
  hitObjects.sort((a, b) => a.time - b.time || a._column - b._column);
  const seen = new Set();
  const finalObjects = [];
  for (const h of hitObjects){
    if (h.type === 1){
      const k = h._column + ':' + h.time;
      if (seen.has(k)){ stats.duplicate++; continue; }
      seen.add(k);
    }
    finalObjects.push(h);
  }

  // 时间点：每个 BPM 变更一条（BMS 的 STOP 已经计入物件绝对时间，不再造 0-BPM 点）
  const timingPoints = [];
  let lastT = -1;
  for (const s of tl.segs){
    const t = Math.max(0, Math.trunc(tl.msAtBeat(s.beat)));
    if (t === lastT) continue;
    lastT = t;
    timingPoints.push({ time: t, beatLength: 60000 / s.bpm, meter: 4, sampleSet: 0, sampleIndex: 0,
                        volume: 30, uninherited: true, effects: 0 });
  }

  return { timingPoints, hitObjects: finalObjects, audioObjects, stats, keys: columns, layout, timeline: tl };
}
