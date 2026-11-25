// 判定图库里真正「没有音乐」的曲目。
//
// ★ 正确模型（踩过两次坑后总结）
//   OJM 有两种常见形态：
//     A. BGM 型：整首歌是 1~几条长 BGM 样本（名字常叫 bgm1/60_bgm）。谱面音符携带的键音 id 往往都不在 OJM 里
//        —— 这**完全正常**，那些音符本来就没声音，音乐来自 AUTO_PLAY 通道。
//     B. 纯键音型：没有长 BGM，音乐由几百个短键音按时间轴拼出来。
//   所以：
//     · 「音符引用不到样本」≠ 缺音乐（必须分通道看）
//     · 「OJM 没有长样本」≠ 不配套
//     · 真正会“整首没声音”的只有：**AUTO_PLAY（BGM）通道引用的样本不在 OJM 里**，
//       或者 BGM 型却连那条 BGM 都找不到。
//   node tools/scan-missing.js [图库子目录]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../src/index.js';
import { sampleDurationMs } from '../src/core/sampledur.js';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(TOOLS, '..');
const ROOT = process.env.OJN_ROOT || path.resolve(PROJ, '..');
const SUB = process.argv[2] || 'OfficialBeatmaps';
const DIR = path.join(ROOT, SUB);

const files = fs.readdirSync(DIR).filter(f => /\.ojn$/i.test(f)).sort();
console.log('目录：' + SUB + '（' + files.length + ' 个 .ojn）');

const cls = { musicOk: 0, musicPartial: 0, musicNone: 0, noBgm: 0, keysoundOnly: 0, bgmOnly: 0 };
let durFail = 0, durOk = 0;
const songs = [];

for (const f of files) {
  const ojnPath = path.join(DIR, f);
  const ojmPath = ojnPath.replace(/\.ojn$/i, '.ojm');
  const e = { f, charts: [], worst: null, kind: '?', longest: 0, ojmSamples: 0 };
  if (!fs.existsSync(ojmPath)) { e.note = '缺 .ojm'; songs.push(e); continue; }
  const buf = fs.readFileSync(ojnPath);
  let header; try { header = C.parseOjnHeader(buf); } catch (err) { continue; }
  let samples; try { samples = C.parseOjm(fs.readFileSync(ojmPath), (b) => new TextDecoder('windows-1252').decode(b)); }
  catch (err) { e.note = 'OJM 解析失败'; songs.push(e); continue; }
  const dec = C.makeTextDecoder(C.detectEncoding([header.rawTitle, header.rawArtist]).encoding);
  e.artist = dec(header.rawArtist); e.title = dec(header.rawTitle);
  e.ojmSamples = samples.size;

  const dur = new Map();
  for (const [id, s] of samples) {
    const d = sampleDurationMs(s.bytes);
    dur.set(id, d);
    if (d === null) durFail++; else { durOk++; if (d > e.longest) e.longest = d; }
  }

  const u8 = new Uint8Array(buf);
  for (let idx = 0; idx < 3; idx++) {
    if (!header.noteCounts[idx]) continue;
    const evs = C.parseOjnEvents(u8, header.noteOffsets[idx], idx < 2 ? header.noteOffsets[idx + 1] : header.coverOffset);
    if (!evs.length) continue;
    const built = C.buildChart(header.bpm, evs, false);
    const bgm = [], keys = [];
    for (const o of built.audioObjects) (o.autoplay ? bgm : keys).push(o);
    const need = Math.max((header.durations[idx] || 0) * 1000,
      built.hitObjects.reduce((m, h) => Math.max(m, h.time, h.endTime > 0 ? h.endTime : 0), 0) + 1500);

    // BGM 侧：音乐本体
    let bgmHave = 0, bgmLost = 0, bgmEnd = 0;
    for (const o of bgm) {
      const d = dur.get(o.sampleId);
      if (d === undefined) { bgmLost++; continue; }
      bgmHave++;
      if (d !== null) bgmEnd = Math.max(bgmEnd, o.time + d);
    }
    // 键音侧：音符自带音效（缺失 = 音符静音，不等于没音乐）
    let keyHave = 0, keyLost = 0, keyEnd = 0;
    for (const o of keys) {
      const d = dur.get(o.sampleId);
      if (d === undefined) { keyLost++; continue; }
      keyHave++;
      if (d !== null) keyEnd = Math.max(keyEnd, o.time + d);
    }
    const musicEnd = Math.max(bgmEnd, keyEnd);
    const musicCover = need > 0 ? musicEnd / need : 1;
    const rec = { idx, bgmTotal: bgm.length, bgmHave, bgmLost, keyTotal: keys.length, keyHave, keyLost,
                  musicEnd, need, musicCover, notes: built.hitObjects.length };
    e.charts.push(rec);
    if (!e.worst || musicCover < e.worst.musicCover) e.worst = rec;
    if (bgm.length === 0) cls.noBgm++;
    else if (bgmHave === 0) cls.musicNone++;
    else if (musicCover < 0.9) cls.musicPartial++;
    else cls.musicOk++;
  }
  e.kind = e.longest >= 30000 ? 'BGM' : (e.worst && e.worst.keyHave > 0 ? '键音' : '?');
  if (e.kind === '键音') cls.keysoundOnly++; else if (e.kind === 'BGM') cls.bgmOnly++;
  songs.push(e);
}

const pct = (n, d) => (d ? (n / d * 100).toFixed(1) : '0') + '%';
const totalCharts = cls.musicOk + cls.musicPartial + cls.musicNone + cls.noBgm;
console.log('\n样本时长解析：成功 ' + durOk + '，失败 ' + durFail);
console.log('\n【按难度·音乐（BGM ∪ 键音）覆盖】共 ' + totalCharts + ' 个难度');
console.log('  ✔ 音乐能盖到 ≥90% 谱面：' + cls.musicOk);
console.log('  ⚠ 只盖到 <90%          ：' + cls.musicPartial);
console.log('  ✘ BGM 一条都对不上     ：' + cls.musicNone);
console.log('  · 谱面无 BGM 通道（纯键音）：' + cls.noBgm);

const noMusic = songs.filter(e => e.charts.length && e.charts.every(c => c.bgmHave === 0 && c.keyHave === 0));
const badMusic = songs.filter(e => e.charts.length && e.charts.some(c => c.musicCover < 0.9));
console.log('\n【按曲子】共 ' + files.length + ' 首');
console.log('  OJM 形态：长 BGM 型 ' + cls.bgmOnly + ' 首，纯键音型 ' + cls.keysoundOnly + ' 首');
console.log('  ✘ 一个样本都对不上（完全没音乐）：' + noMusic.length + ' 首  ' + pct(noMusic.length, files.length));
console.log('  ⚠ 至少一个难度音乐盖不满 90%：' + badMusic.length + ' 首  ' + pct(badMusic.length, files.length));

badMusic.sort((a, b) => a.worst.musicCover - b.worst.musicCover);
console.log('\n音乐最不完整的 15 首：');
console.log('  文件'.padEnd(16) + '曲名                     形态  OJM样本   最长   BGM可用/总   键音可用/总   覆盖');
for (const e of badMusic.slice(0, 15)) {
  const c = e.worst;
  console.log('  ' + e.f.padEnd(16) + ((e.artist || '?') + ' - ' + (e.title || '?')).slice(0, 24).padEnd(26)
    + e.kind.padEnd(5) + String(e.ojmSamples).padStart(6)
    + (e.longest / 1000).toFixed(0).padStart(7) + 's'
    + (c.bgmHave + '/' + c.bgmTotal).padStart(12) + (c.keyHave + '/' + c.keyTotal).padStart(14)
    + (c.musicCover * 100).toFixed(0).padStart(7) + '%');
}
if (noMusic.length) {
  console.log('\n完全没有音乐的：');
  for (const e of noMusic) console.log('  ' + e.f + '  ' + (e.artist || '') + ' - ' + (e.title || '')
    + '  (OJM ' + e.ojmSamples + ' 个样本，最长 ' + (e.longest / 1000).toFixed(0) + 's)');
}
