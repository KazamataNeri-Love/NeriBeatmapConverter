// 扫描整个图库，统计「保留键音（不混音）」模式会产出什么：
//   键音数 / BGM 数 / Sample 事件数 / 音轨取哪条 / 需要拷多少样本、多大
// 对比混音模式（MP3@320 估算 = 时长 × 40KB/s），看清省了多少空间。
//   npm run scan:keysound
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../src/index.js';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OJN_ROOT || path.resolve(TOOLS, '..', '..');

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/o2jam-to-osu|BmsToOsu|SeriousBeatmapConverter|O2Jam-2-osu|Failed|node_modules/.test(e.name)) walk(p, out); }
    else if (/\.ojn$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
console.log('图库里的 .ojn：', files.length, '   根目录：', ROOT);
const agg = { songs: 0, charts: 0, noOjm: 0, noSample: 0, keysounds: 0, bgm: 0, events: 0,
              withAudio: 0, keysoundOnly: 0, sampleBytes: 0, ojmBytes: 0, estMixBytes: 0,
              notesTotal: 0, notesWithSound: 0 };
const rows = [];

for (const f of files) {
  const buf = fs.readFileSync(f);
  let header;
  try { header = C.parseOjnHeader(buf); } catch (e) { continue; }
  const ojmPath = path.join(path.dirname(f), path.basename(f).replace(/\.ojn$/i, '.ojm'));
  if (!fs.existsSync(ojmPath)) { agg.noOjm++; continue; }
  let samples;
  try { samples = C.parseOjm(fs.readFileSync(ojmPath), (b) => new TextDecoder('windows-1252').decode(b)); }
  catch (e) { agg.noOjm++; continue; }
  if (!samples.size) { agg.noSample++; continue; }
  agg.songs++;
  agg.ojmBytes += fs.statSync(ojmPath).size;
  const names = C.buildSampleNames(samples);
  const u8 = new Uint8Array(buf);
  const songFiles = new Map();      // 整首歌（三难度）真正要拷的样本，按歌去重才公平

  for (let idx = 0; idx < 3; idx++) {
    if (!header.noteCounts[idx]) continue;
    const evs = C.parseOjnEvents(u8, header.noteOffsets[idx],
      idx < 2 ? header.noteOffsets[idx + 1] : header.coverOffset);
    if (!evs.length) continue;
    const built = C.buildChart(header.bpm, evs, false);
    const plan = C.planKeysound({ samples, sampleNames: names, audioObjects: built.audioObjects,
                                  hitObjects: built.hitObjects });
    const st = plan.stats;
    agg.charts++;
    agg.keysounds += st.keysounds;
    agg.bgm += st.bgm;
    agg.events += st.sampleEvents;
    if (st.hasAudioTrack) agg.withAudio++; else agg.keysoundOnly++;
    for (const x of plan.files) songFiles.set(x.name, x.data.length);
    // 混音模式体积估算：用最长音符时间 + 尾音，按 MP3@320（40000 字节/秒）
    const last = built.hitObjects.reduce((m, h) => Math.max(m, h.time, h.endTime > 0 ? h.endTime : 0), 0);
    agg.estMixBytes += Math.max(0, last / 1000 + 8) * 40000;
    // 音符有没有键音
    const ids = new Set(samples.keys());
    agg.notesTotal += built.hitObjects.length;
    agg.notesWithSound += built.hitObjects.filter(h => h.sampleId !== undefined && ids.has(h.sampleId)).length;
    rows.push({ f: path.basename(f), idx, notes: built.hitObjects.length, ks: st.keysounds,
                bgm: st.bgm, ev: st.sampleEvents, audio: plan.audioName || '(无)',
                size: plan.files.reduce((a, x) => a + x.data.length, 0) });
  }
  agg.sampleBytes += [...songFiles.values()].reduce((a, b) => a + b, 0);
}

const MB = (b) => (b / 1048576).toFixed(1) + ' MB';
console.log('\n难度数：' + agg.charts + '   有 OJM：' + agg.songs + '   缺 OJM：' + agg.noOjm + '   空 OJM：' + agg.noSample);
console.log('音符：' + agg.notesTotal + ' 个，其中带可用键音的 ' + agg.notesWithSound
  + '（' + (agg.notesTotal ? (agg.notesWithSound / agg.notesTotal * 100).toFixed(1) : 0) + '%）');
console.log('BGM 事件 ' + agg.bgm + ' → 音轨选自 BGM 的 ' + agg.withAudio + ' 个难度；无 BGM（纯键音）' + agg.keysoundOnly + ' 个');
console.log('其余 BGM 转成 Sample 事件 ' + agg.events + ' 条');
console.log('\n体积对比（全库累计）：');
console.log('  保留键音：每首歌拷入的样本合计 ' + MB(agg.sampleBytes) + '（OJM 原始总量 ' + MB(agg.ojmBytes)
  + '，即不会超过它）');
console.log('  混音 MP3@320 估算：' + MB(agg.estMixBytes));
const save = agg.estMixBytes > 0 ? (1 - agg.sampleBytes / agg.estMixBytes) * 100 : 0;
console.log('  → 保留键音比混音省约 ' + save.toFixed(0) + '%');

const worst = rows.sort((a, b) => b.size - a.size).slice(0, 8);
console.log('\n最占空间的 8 个难度（保留键音模式下拷入的样本量）：');
console.log('  文件'.padEnd(18) + '难度  音符    键音   BGM  事件   样本量      音轨');
for (const r of worst)
  console.log('  ' + r.f.padEnd(18) + ['EX', 'NX', 'HX'][r.idx] + '   ' + String(r.notes).padStart(5)
    + '  ' + String(r.ks).padStart(5) + ' ' + String(r.bgm).padStart(4) + ' ' + String(r.ev).padStart(5)
    + '   ' + MB(r.size).padStart(9) + '   ' + r.audio.slice(0, 28));
