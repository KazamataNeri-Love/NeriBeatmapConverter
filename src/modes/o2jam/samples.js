// 样本 id 兜底：现实中不少 OJN/OJM 不是严格配套的，谱面引用的样本 id 与 OJM 里的 id 差一点点，
// 直接查表就会“整首没声音”。本模块只在这些情况下做**保守**兜底，并把每次改写记录下来。
//
// 覆盖的两种真实情形（都在 OfficialBeatmaps 里实测到）：
//   1. 音色库偏移 ±1000：OJM 里样本是 OGG（codec 5，id 用 ref 本身），
//      而谱面写的是 WAV 库编号（id = 1000 + ref，来自 note 事件的 `type % 8 > 3` 规则）。
//      例：o2ma3510 —— OJM 里 BGM id=0，谱面 BGM 引用 id=1000。
//   2. 单主音频（就像 osu 那样，整首歌只有一条主音频，没有键音）：
//      谱面 BGM 引用一个不存在的 id，而 OJM 里恰好只有一条「和谱面差不多长」的样本。
//      例：o2ma3776 EX —— OJM 里只有 id=1000 的 209.8s 主音频，谱面 BGM 引用 id=1。
//
// 明确**不做**的事：当 BGM 引用大面积缺失时（说明 OJM 本身残缺），不去乱映射 ——
// 例：o2ma1228「舞娘」486 个 BGM 对象里 485 个 id 缺失，硬映射只会把同一条样本反复重播。

/** 建立 id 索引 + 别名（别名只在“精确 id 不存在”时才用） */
export function buildSampleIndex(samples){
  const byId = new Map(samples);
  const alias = new Map();                        // 别名 id → OJM 里真实存在的 id
  for(const id of samples.keys()){
    const alt = id < 1000 ? id + 1000 : id - 1000;  // WAV 库 ↔ OGG 库
    if(!byId.has(alt) && !alias.has(alt)) alias.set(alt, id);
  }
  let mainId = null, mainDurMs = 0, mainBytes = 0;
  for(const [id, s] of samples){                  // “主音频”候选 = 体积最大（不解码即可得）
    if(s.bytes.length > mainBytes){ mainBytes = s.bytes.length; mainId = id; }
  }
  return { byId, alias, size: samples.size, mainId, mainBytes };
}

/** 先精确、再别名、最后由 resolveMainAudio 兜底 */
export function resolveSampleId(id, index){
  if(index.byId.has(id)) return id;
  if(index.alias.has(id)) return index.alias.get(id);
  return null;
}

/**
 * 为一张谱面规划 id 映射。
 *   index        buildSampleIndex(samples)
 *   audioObjects buildChart 产出的音频对象（含 autoplay 标记）
 *   needMs       谱面需要多长（用于判断“主音频”是否够长）
 *   maxMissingBgm 允许“BGM 引用缺失的不同 id 数”上限，超过就不做单主音频兜底（默认 2）
 *   mainDurationMs 主音频真实时长（推荐传；用 src/sampledur.js 算）。不传则退化为“样本数极少才算单主音频”
 * 返回 {map: Map<原id, 真实id>, mainAudio: {from:Set, toId}|null, stats}
 */
export function planSampleFallback({ index, audioObjects, needMs, maxMissingBgm = 2, mainDurationMs, durations }){
  const map = new Map();
  const stats = { exact: 0, aliasHits: 0, aliasIds: new Set(), mainAudio: 0, mainAudioIds: new Set(),
                  stillMissing: 0, missingIds: new Set() };
  const bgmMissing = new Set(), keyMissing = new Set();

  for(const o of audioObjects || []){
    if(index.byId.has(o.sampleId)){ stats.exact++; continue; }
    if(index.alias.has(o.sampleId)){ stats.aliasHits++; stats.aliasIds.add(o.sampleId); continue; }
    stats.stillMissing++;
    stats.missingIds.add(o.sampleId);
    (o.autoplay ? bgmMissing : keyMissing).add(o.sampleId);
  }

  // 情形 2：单主音频兜底 —— 只对 BGM（音乐本体）生效，且缺失 id 很少
  let mainAudio = null;
  if(index.mainId !== null && bgmMissing.size > 0 && bgmMissing.size <= maxMissingBgm){
    const md = mainDurationMs !== undefined ? mainDurationMs
      : (durations ? durations.get(index.mainId) : undefined);
    const ok = (md !== undefined && md !== null)
      ? (needMs > 0 ? md >= needMs * 0.5 : md > 0)      // 真实时长 ≥ 谱面一半
      : index.size <= 8;                                // 没时长信息时：只认“样本极少”的包
    if(ok){
      for(const id of bgmMissing) map.set(id, index.mainId);
      mainAudio = { from: new Set(bgmMissing), toId: index.mainId };
      stats.mainAudio = bgmMissing.size;
      for(const id of bgmMissing) stats.mainAudioIds.add(id);
    }
  }
  return { map, mainAudio, stats, bgmMissing: [...bgmMissing] };
}

/** 把兜底应用到音频对象上，返回 {objects, bgm, keys}
 *   严格分通道：
 *     1. 精确 id 存在 → 不动
 *     2. ±1000 别名 → BGM 与键音都可以用（只是音色库编号不同）
 *     3. 单主音频映射 → **只给 BGM（音乐本体）**。
 *        绝不能让键音指向整首歌样本：o2ma3776 的键音也引用同一个不存在的 id，
 *        若一起映射，399 个对象会同时播放那条 209.8s 主音频 → 峰值 109（归一化 -41.8dB）= 一坨噪音。
 */
export function applySampleFallback(audioObjects, fb, index){
  const map = fb && fb.map;
  const hasAlias = index.alias.size > 0;
  const hasMain = !!(map && map.size);
  const n = { objects: 0, bgm: 0, keys: 0 };
  if(!hasAlias && !hasMain) return n;
  for(const o of audioObjects || []){
    if(index.byId.has(o.sampleId)) continue;                                     // 1) 精确命中
    let to;
    if(hasAlias && index.alias.has(o.sampleId)) to = index.alias.get(o.sampleId); // 2) 别名
    if(to === undefined && hasMain && o.autoplay) to = map.get(o.sampleId);       // 3) 仅 BGM
    if(to === undefined) continue;
    o.sampleId = to;
    n.objects++;
    if(o.autoplay) n.bgm++; else n.keys++;
  }
  return n;
}

/** 音符（键音）只应用 ±1000 别名；绝不用“单主音频”映射 —— 否则一敲键就播整首歌 */
export function applySampleFallbackToHitObjects(hitObjects, fb, index){
  if(!index.alias.size) return 0;
  let n = 0;
  for(const h of hitObjects || []){
    const id = h.sampleId;
    if(id === undefined || index.byId.has(id)) continue;
    if(index.alias.has(id)){ h.sampleId = index.alias.get(id); n++; }
  }
  return n;
}
