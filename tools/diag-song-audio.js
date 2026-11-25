// 逐难度对照：谱面引用的样本 id（分 BGM/键音） vs OJM 里实际存在的 id。
// 用于精确定位“某一难度为什么没声音”。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../src/index.js';
import { sampleDurationMs } from '../src/core/sampledur.js';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.OJN_ROOT || path.resolve(TOOLS, '..', '..');

for (const rel of process.argv.slice(2)) {
  const ojnPath = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const ojmPath = ojnPath.replace(/\.ojn$/i, '.ojm');
  const buf = fs.readFileSync(ojnPath);
  const h = C.parseOjnHeader(buf);
  const dec = C.makeTextDecoder(C.detectEncoding([h.rawTitle, h.rawArtist]).encoding);
  const samples = C.parseOjm(fs.readFileSync(ojmPath), (b) => new TextDecoder('windows-1252').decode(b));
  console.log('── ' + path.basename(ojnPath) + '  ' + dec(h.rawArtist) + ' - ' + dec(h.rawTitle));
  const ids = [...samples.keys()].sort((a, b) => a - b);
  const durList = ids.map(id => sampleDurationMs(samples.get(id).bytes));
  console.log('   OJM ' + path.basename(ojmPath) + '：' + samples.size + ' 个样本，id = ' + ids.slice(0, 12).join(',')
    + (ids.length > 12 ? ' …' : '') + '，时长 ' + durList.map(d => d === null ? '?' : (d / 1000).toFixed(1) + 's').slice(0, 6).join('/'));
  console.log('   文件名例：' + ids.slice(0, 3).map(id => samples.get(id).name).join(' | '));

  const u8 = new Uint8Array(buf);
  for (let idx = 0; idx < 3; idx++) {
    const evs = C.parseOjnEvents(u8, h.noteOffsets[idx], idx < 2 ? h.noteOffsets[idx + 1] : h.coverOffset);
    if (!evs.length) { console.log('   难度 ' + ['EX', 'NX', 'HX'][idx] + '：无事件'); continue; }
    const built = C.buildChart(h.bpm, evs, false);
    const bgmIds = new Map(), keyIds = new Map();
    for (const o of built.audioObjects) {
      const m = o.autoplay ? bgmIds : keyIds;
      m.set(o.sampleId, (m.get(o.sampleId) || 0) + 1);
    }
    const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([id, n]) => id + (samples.has(id) ? '✔' : '✘') + '×' + n).join(' ');
    const bgmOk = [...bgmIds.keys()].filter(id => samples.has(id)).length;
    const keyOk = [...keyIds.keys()].filter(id => samples.has(id)).length;
    console.log('   难度 ' + ['EX', 'NX', 'HX'][idx] + '：音符 ' + built.hitObjects.length
      + '，BGM 对象 ' + built.audioObjects.filter(o => o.autoplay).length
      + '（id ' + bgmIds.size + ' 种，命中 ' + bgmOk + '）  键音对象 ' + built.audioObjects.filter(o => !o.autoplay).length
      + '（id ' + keyIds.size + ' 种，命中 ' + keyOk + '）');
    console.log('      BGM id：' + (fmt(bgmIds) || '（无）'));
    console.log('      键音 id：' + (fmt(keyIds) || '（无）'));
  }
  console.log('');
}
