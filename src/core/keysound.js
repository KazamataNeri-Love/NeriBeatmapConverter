// 保留键音（不混音）模式：不生成合并音频，而是把 OJM 里的样本原样用起来。
//
// 思路来自 BmsToOsu 的默认行为（它只有 --generate-mp3 时才用 ffmpeg 混音）：
//   · BGM（o2jam 的 AUTO_PLAY 通道）→ 只用体积最大的那条当 AudioFilename（原始文件，不重编码），
//     其余 BGM 用 [Events] 的 `Sample,<time>,0,"<file>",<volume>` 行在原时间点播放；
//   · 每个音符自带的键音 → 写进该音符的 hitSample，osu 命中时播放；
//   · 用到的样本文件原样拷进图包（体积 ≈ OJM 大小，远小于混音出的 WAV/MP3）。
//
// 输出行格式与 BmsToOsu 对齐：
//   短音        x,192,<t>,1,0,0:0:0:<vol>:<file>
//   长音        x,192,<t>,128,0,<end>:0:0:0:<vol>:<file>
//   背景音事件  Sample,<t>,0,"<file>",<vol>
import { sanitizeFilename } from './util.js';

/** 文件名里 osu 不能带的字符（逗号是字段分隔符，冒号是 hitSample 分隔符） */
function safeName(name, id){
  // 先把路径分隔符换成下划线（不能直接删，否则 "bgm/main" 与 "bgmmain" 会撞名）
  let base = String(name || '').replace(/[/\\]/g, '_').replace(/[,:"]/g, '_').trim();
  base = sanitizeFilename(base);                       // 再清掉剩下的 ? * < > | 并 trim
  base = base.replace(/^\.+/, '').replace(/\.+$/, ''); // 去掉首尾点
  if(!base) base = 'sample_' + id;
  if(!/\.[a-z0-9]{1,5}$/i.test(base)) base += '.ogg';  // 没扩展名就补一个（osu 靠扩展名找文件）
  return base;
}

/** 给整个 OJM 的样本表生成稳定文件名：同名冲突的加 _id 后缀（与用到哪些样本无关，故三难度一致） */
export function buildSampleNames(samples){
  const idsByBase = new Map();
  const baseOf = new Map();
  for(const [id, s] of samples){
    const base = safeName(s.name, id);
    baseOf.set(id, base);
    if(!idsByBase.has(base)) idsByBase.set(base, []);
    idsByBase.get(base).push(id);
  }
  const nameOf = new Map();
  for(const [id, base] of baseOf){
    const ids = idsByBase.get(base);
    if(ids.length <= 1){ nameOf.set(id, base); continue; }
    const dot = base.lastIndexOf('.');
    nameOf.set(id, base.slice(0, dot) + '_' + id + base.slice(dot));
  }
  return nameOf;
}

/** 生成一首歌（单难度）的保留键音输出计划 */
export function planKeysound({ samples, sampleNames, audioObjects, hitObjects }){
  const names = sampleNames || buildSampleNames(samples);
  const bgm = (audioObjects || []).filter(o => o.autoplay && samples.has(o.sampleId));
  // 音符实际用到的键音（样本不存在的音符会退化成静音音符，与混音模式一致）
  const noteIds = new Set();
  for(const h of hitObjects || [])
    if(h.sampleId !== undefined && samples.has(h.sampleId)) noteIds.add(h.sampleId);

  // 音轨：只挑「整个难度里只出现一次、且就在开头（≤100ms）」的最大 BGM 样本 —— 这种才真是“整首歌一条 BGM”，
  // 拿它当 AudioFilename 才不会丢事件、也不会让音频整体前移。
  // 其余情况（多次出现 / 起播位置不在 0 / 没有 BGM）一律走 Sample 事件，同步最准。
  const countById = new Map();
  for(const o of bgm) countById.set(o.sampleId, (countById.get(o.sampleId) || 0) + 1);
  let audioId = null, biggest = -1;
  for(const o of bgm){
    if(countById.get(o.sampleId) !== 1) continue;      // 用过多次 → 必须靠 Sample 事件逐次播
    if(o.time > 100) continue;                          // 不在开头 → 当音轨会整体提前
    const n = samples.get(o.sampleId).bytes.length;
    if(n > biggest){ biggest = n; audioId = o.sampleId; }
  }

  // 其余 BGM 全走 Sample 事件，只跳过被选作音轨的那一条。
  // 注意：即使某个样本同时被音符当键音用，这里也不排除 —— 原版 O2Jam 里它本来就会响两次
  // （AUTO_PLAY 排的那次 + 玩家命中那次），排除会把伴奏事件整片删掉（实测有的曲子会丢 45%）。
  const events = [];
  let sharedIds = 0;
  for(const o of bgm){
    if(o.sampleId === audioId) continue;
    events.push({ time: Math.trunc(o.time), file: names.get(o.sampleId),
                  volume: Math.max(1, Math.min(100, Math.round((o.volume === undefined ? 1 : o.volume) * 100))) });
  }
  for(const id of noteIds) if(countById.has(id)) sharedIds++;
  events.sort((a, b) => a.time - b.time);

  // 需要拷进图包的样本（键音 ∪ BGM）
  const usedIds = new Set([...noteIds, ...bgm.map(o => o.sampleId)]);
  const files = [];
  for(const id of usedIds){
    const s = samples.get(id);
    if(!s || !names.has(id)) continue;
    files.push({ name: names.get(id), data: s.bytes, mime: s.mime });
  }

  return {
    nameOf: names,
    sampleEvents: events,
    files,
    audioName: audioId === null ? '' : names.get(audioId),
    stats: { bgm: bgm.length, keysounds: noteIds.size, sampleEvents: events.length,
             samples: files.length, hasAudioTrack: audioId !== null, sharedIds },
  };
}
