// BMS 文本解析（.bms/.bme/.bml/.bmx）
//
// 只做「把文本拆成结构化数据」，不碰时间轴、不碰 .osu：
//   · 头信息（#TITLE/#ARTIST/#BPM/#PLAYLEVEL/#STAGEFILE…）
//   · 索引表（#WAVxx / #BMPxx / #BPMxx / #STOPxx）
//   · 数据行（#mmmcc:data）
//   · #RANDOM/#IF/#ELSEIF/#ELSE/#ENDIF 的分支选择
//
// 编码：BMS 现实里是 Shift-JIS（日系）与 GBK（国服改版）混存，且两种编码都能「无替换字符」地解出对方，
// 所以不能用 TextDecoder 是否报错来判断 —— 用 core/text.js 的高频字打分，半角片假名会被重罚。

import { scoreText } from '../../core/text.js';

const B36 = (s) => parseInt(s, 36);

export function decodeBms(buf){
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // BOM
  if (u8.length > 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF)
    return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'utf-8' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' };
  } catch (e) { /* 不是严格 UTF-8 */ }
  const cands = ['shift_jis', 'gb18030', 'euc-kr', 'big5'];
  let best = null;
  for (const enc of cands){
    let t;
    try { t = new TextDecoder(enc, { fatal: false }).decode(u8); } catch (e) { continue; }
    const score = scoreText(t);
    if (!best || score > best.score) best = { enc, t, score };
  }
  if (!best) return { text: new TextDecoder('shift_jis').decode(u8), encoding: 'shift_jis' };
  return { text: best.t, encoding: best.enc };
}

/** 逐行扫描：返回 {meta, wav, bmp, bpmIdx, stopIdx, entries, encoding, randomChosen} */
export function parseBms(buf, opts = {}){
  const { text, encoding } = opts.text !== undefined
    ? { text: opts.text, encoding: opts.encoding || 'utf-8' }
    : decodeBms(buf);
  const meta = {
    title: '', subtitle: '', artist: '', subartist: [], genre: '', playlevel: 0, rank: 0,
    difficulty: 0, stage: '', backbmp: '', banner: '', bpm: 130, lntype: 1, lnobj: null,
    player: 0, total: 0, maker: '',   // 0 = 没写 #PLAYER（分析时按内容猜）
  };
  const wav = new Map();          // 数字 id → 文件名（保留原始写法，路径在后面解析）
  const bmp = new Map();
  const bpmIdx = new Map();       // 数字 id → BPM
  const stopIdx = new Map();      // 数字 id → 1/192 全音符数
  const entries = [];             // 数据行 {m, ch, msg}
  let randomChosen = opts.random || 1;

  // #RANDOM/#IF 分支：两种帧分开记 —— #ENDIF 只关 IF 帧，#ENDRANDOM 才关 RANDOM 帧
  const stack = [];
  const active = () => stack.every(x => x.active);
  const nearestRandom = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === 'random') return stack[i];
    return null;
  };

  for (const rawLine of text.split(/\r?\n/)){
    const line = rawLine.trim();
    if (!line.startsWith('#')) continue;

    const dm = /^#(\d{3})([0-9A-Za-z]{2}):(.*)$/.exec(line);
    if (dm){
      if (!active()) continue;
      entries.push({ m: +dm[1], ch: dm[2].toUpperCase(), msg: dm[3].trim() });
      continue;
    }

    const sp = line.slice(1).split(/\s+/);
    const cmd = sp[0].toUpperCase();
    const val = line.slice(1 + sp[0].length).trim();

    if (cmd === 'RANDOM' || cmd === 'SETRANDOM'){
      const n = parseInt(val, 10) || 1;
      const chosen = cmd === 'SETRANDOM' ? n : Math.min(Math.max(1, randomChosen), n);
      stack.push({ kind: 'random', n, chosen, active: true });
      continue;
    }
    if (cmd === 'IF'){
      const k = parseInt(val, 10) || 1;
      const rnd = nearestRandom();
      const chosen = rnd ? rnd.chosen : 1;
      const on = (k === chosen);
      stack.push({ kind: 'if', active: on, matched: on });
      continue;
    }
    if (cmd === 'ELSEIF'){
      const top = stack[stack.length - 1];
      if (top && top.kind === 'if' && !top.matched){
        const k = parseInt(val, 10) || 1;
        const rnd = nearestRandom();
        top.active = (k === (rnd ? rnd.chosen : 1));
        top.matched = top.active;
      } else if (top && top.kind === 'if') top.active = false;
      continue;
    }
    if (cmd === 'ELSE'){
      const top = stack[stack.length - 1];
      if (top && top.kind === 'if') top.active = !top.matched;
      continue;
    }
    if (cmd === 'ENDIF'){
      for (let i = stack.length - 1; i >= 0; i--){
        if (stack[i].kind === 'if'){ stack.splice(i, 1); break; }
      }
      continue;
    }
    if (cmd === 'ENDRANDOM'){
      for (let i = stack.length - 1; i >= 0; i--){
        if (stack[i].kind === 'random'){ stack.splice(i, 1); break; }
      }
      continue;
    }
    if (!active()) continue;

    let mm;
    if ((mm = /^WAV([0-9A-Z]{2})$/.exec(cmd))){ if (val) wav.set(B36(mm[1]), val); continue; }
    if ((mm = /^BMP([0-9A-Z]{2})$/.exec(cmd))){ if (val) bmp.set(B36(mm[1]), val); continue; }
    if ((mm = /^BPM([0-9A-Z]{2})$/.exec(cmd))){ const b = parseFloat(val); if (isFinite(b)) bpmIdx.set(B36(mm[1]), b); continue; }
    if ((mm = /^STOP([0-9A-Z]{2})$/.exec(cmd))){ const d = parseFloat(val); if (isFinite(d)) stopIdx.set(B36(mm[1]), d); continue; }

    switch (cmd){
      case 'TITLE': meta.title = val; break;
      case 'SUBTITLE': meta.subtitle = val; break;
      case 'ARTIST': meta.artist = val; break;
      case 'SUBARTIST': if (val) meta.subartist.push(val); break;
      case 'MAKER': meta.maker = val; break;
      case 'GENRE': meta.genre = val; break;
      case 'BPM': { const b = parseFloat(val); if (isFinite(b) && b > 0) meta.bpm = b; break; }
      case 'PLAYLEVEL': meta.playlevel = parseInt(val, 10) || 0; break;
      case 'RANK': meta.rank = parseInt(val, 10) || 0; break;
      case 'DIFFICULTY': meta.difficulty = parseInt(val, 10) || 0; break;
      case 'STAGEFILE': meta.stage = val; break;
      case 'BACKBMP': meta.backbmp = val; break;
      case 'BANNER': meta.banner = val; break;
      case 'LNTYPE': meta.lntype = parseInt(val, 10) || 1; break;
      case 'LNOBJ': meta.lnobj = val.toUpperCase() || null; break;
      case 'PLAYER': meta.player = parseInt(val, 10) || 0; break;
      case 'TOTAL': meta.total = parseFloat(val) || 0; break;
      default: break;
    }
  }
  return { meta, wav, bmp, bpmIdx, stopIdx, entries, encoding };
}

/** 谱面里出现的所有 key（BPM/STOP 索引）—— 供调试与自检 */
export function bmsStats(parsed){
  const m = parsed.entries.reduce((a, e) => Math.max(a, e.m), 0);
  return { measures: m + 1, entries: parsed.entries.length, wav: parsed.wav.size,
           bpmIdx: parsed.bpmIdx.size, stopIdx: parsed.stopIdx.size, encoding: parsed.encoding };
}
