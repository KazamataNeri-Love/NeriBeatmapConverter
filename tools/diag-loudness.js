// 响度诊断：我们现在到底比“原曲”低了多少 dB？
// 参照物有两个，都是客观可测的：
//   A. OJM 里的主 BGM 样本 —— 就是原曲母带（原版 O2Jam 放的就是它）
//   B. 「键音等效求和」—— 保留键音模式下 osu! 实际听到的东西（逐样本原幅度叠加）
// 输出：peak / RMS / EBU R128 整体响度（LUFS），以及目前归一化吃掉多少 dB。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseOjnHeader, parseOjnEvents } from '../src/modes/o2jam/ojn.js';
import { parseOjm } from '../src/modes/o2jam/ojm.js';
import { detectEncoding, makeTextDecoder } from '../src/core/text.js';
import { buildChart } from '../src/modes/o2jam/chart.js';
import { mixToPcm } from '../src/core/audio.js';
import { encodeWav } from '../src/core/encoders/wav.js';
import { buildSampleIndex, planSampleFallback, applySampleFallback } from '../src/modes/o2jam/samples.js';
import { createFfmpegAudioContext, findFfmpeg } from './lib/ffmpeg.js';

const FF = (await findFfmpeg()).bin;
const rate = 44100;

const ebur = (file) => new Promise((res) => {
  execFile(FF, ['-hide_banner', '-nostdin', '-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'],
    { maxBuffer: 1 << 26 }, (err, so, se) => {
      const t = String(se || '');
      /* ★ ebur128 会先把实时进度刷好几行（里面同样有 `I:` / `LRA:`，初值是 -70.0），
         末尾才是汇总。取**最后一次**匹配，否则永远读到“静音”那行的 -70.0。 */
      const last = (re) => { const m = [...t.matchAll(re)]; return m.length ? +m[m.length - 1][1] : null; };
      res({ lufs: last(/I:\s*(-?[\d.]+)\s*LUFS/g),
            lra: last(/LRA:\s*(-?[\d.]+)\s*LU/g),
            truePeak: last(/Peak:\s*(-?[\d.]+)\s*dBFS/g) });
    });
});

const rmsDb = (l, r, n) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += l[i] * l[i] + r[i] * r[i];
  return 10 * Math.log10(s / (2 * n) + 1e-20);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loud-'));
const files = process.argv.slice(2);
if (!files.length) files.push('../OfficialBeatmaps/o2ma100.ojn');

const ctx = await createFfmpegAudioContext({ sampleRate: rate, ffmpeg: FF, cacheMb: 0 });
const rows = [];
try {
  for (const ojn of files) {
    const ojm = ojn.replace(/\.ojn$/i, '.ojm');
    if (!fs.existsSync(ojm)) { console.log(`（跳过 ${path.basename(ojn)}：没有 .ojm）`); continue; }
    const u8 = fs.readFileSync(ojn);
    const h = parseOjnHeader(u8);
    const dec = makeTextDecoder(detectEncoding([h.rawTitle, h.rawArtist, h.rawNoter]).encoding);
    const samples = parseOjm(fs.readFileSync(ojm), dec);
    const title = dec(h.rawTitle);

    // 用 HX（index 2），和 CLI 默认一致
    const idx = 2;
    const events = parseOjnEvents(new Uint8Array(u8.buffer, u8.byteOffset, u8.length), h.noteOffsets[idx], h.coverOffset);
    const built = buildChart(h.bpm, events, false, { enabled: true, maxBeats: 0 });
    const index = buildSampleIndex(samples);
    const needMs = Math.max((h.durations[idx] || 0) * 1000,
      built.hitObjects.reduce((m, x) => Math.max(m, x.time, x.endTime > 0 ? x.endTime : 0), 0) + 1500);
    const fb = planSampleFallback({ index, audioObjects: built.audioObjects, needMs });
    applySampleFallback(built.audioObjects, fb, index);
    const minDurationMs = needMs;

    // A. 主 BGM 母带（最长的那条样本）
    let master = null;
    if (index.mainId !== null && samples.has(index.mainId)) {
      const s = samples.get(index.mainId);
      const p = path.join(tmp, `master-${h.songid}`);
      fs.writeFileSync(p, s.bytes);
      const m = await ebur(p);
      fs.unlinkSync(p);
      master = m;
    }
    // 原始求和（不处理）
    const raw = await mixToPcm(ctx, built.audioObjects, samples, rate, { loudness: 'none', minDurationMs });
    // 现行默认：前视峰值限制器
    const norm = await mixToPcm(ctx, built.audioObjects, samples, rate, { loudness: 'limit', minDurationMs });
    // 旧行为：峰值归一化
    const old = await mixToPcm(ctx, built.audioObjects, samples, rate, { loudness: 'normalize', minDurationMs });

    const wRaw = path.join(tmp, `raw-${h.songid}.wav`);
    const wNorm = path.join(tmp, `norm-${h.songid}.wav`);
    const wOld = path.join(tmp, `old-${h.songid}.wav`);
    fs.writeFileSync(wRaw, encodeWav(raw));
    fs.writeFileSync(wNorm, encodeWav(norm));
    fs.writeFileSync(wOld, encodeWav(old));
    const eRaw = await ebur(wRaw), eNorm = await ebur(wNorm), eOld = await ebur(wOld);
    let peakAfter = 0;
    for (let i = 0; i < norm.length; i++) {
      const a = Math.abs(norm.left[i]), b = Math.abs(norm.right[i]);
      if (a > peakAfter) peakAfter = a;
      if (b > peakAfter) peakAfter = b;
    }
    fs.unlinkSync(wRaw); fs.unlinkSync(wNorm); fs.unlinkSync(wOld);

    rows.push({
      title, songid: h.songid,
      masterLufs: master ? master.lufs : null,
      rawLufs: eRaw.lufs, rawPeak: raw.peak, rawRms: rmsDb(raw.left, raw.right, raw.length),
      limLufs: eNorm.lufs, limPeak: peakAfter, limRms: rmsDb(norm.left, norm.right, norm.length),
      limRed: norm.reductionDb, limTruePeak: eNorm.truePeak,
      oldLufs: eOld.lufs, oldGainDb: 20 * Math.log10(old.gain),
      sec: raw.length / rate,
    });
  }
} finally { ctx.dispose(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }

console.log('\n歌名'.padEnd(26) + '母带  原始求和  限制器  旧归一化   峰值后  压制   比旧版响  比母带');
console.log('-'.repeat(104));
for (const r of rows) {
  const vsOld = r.oldLufs !== null && r.limLufs !== null ? r.oldLufs - r.limLufs : null;
  console.log(
    (r.title || '').slice(0, 22).padEnd(24)
    + String(r.masterLufs === null ? ' -' : r.masterLufs.toFixed(1)).padStart(6)
    + String(r.rawLufs.toFixed(1)).padStart(10)
    + String(r.limLufs === null ? '-' : r.limLufs.toFixed(1)).padStart(8)
    + String(r.oldLufs === null ? '-' : r.oldLufs.toFixed(1)).padStart(10)
    + String(r.limPeak.toFixed(3)).padStart(9)
    + String(r.limRed.toFixed(1) + 'dB').padStart(8)
    + String(vsOld === null ? '-' : '+' + vsOld.toFixed(1) + 'dB').padStart(10)
    + String(r.masterLufs === null ? '-' : (r.limLufs - r.masterLufs).toFixed(1) + 'dB').padStart(9)
  );
}
const ok = rows.filter(r => r.limLufs !== null && r.oldLufs !== null);
if (ok.length) {
  const gain = ok.map(r => r.oldLufs - r.limLufs);
  console.log(`\n限制器比旧峰值归一化平均响 ${(gain.reduce((a, b) => a + b, 0) / gain.length).toFixed(1)} dB`
    + `（${Math.min(...gain).toFixed(1)}~${Math.max(...gain).toFixed(1)} dB）`);
  const maxPeak = Math.max(...rows.map(r => r.limPeak));
  console.log(`限制器输出峰值上限 ${maxPeak.toFixed(3)}（阈值 0.89）→ ${maxPeak <= 0.8901 ? '全部不削波 ✓' : '有超阈值 ✗'}`);
}
