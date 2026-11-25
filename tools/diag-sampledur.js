// 校验 src/core/sampledur.js 的纯 JS 时长解析与 ffmpeg 是否一致（信任它之前必须先对一次）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from '../src/index.js';
import { sampleDurationMs } from '../src/core/sampledur.js';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.OJN_ROOT || path.resolve(PROJ, '..');
const ojm = process.argv[2] || path.join(ROOT, 'OfficialBeatmaps', 'o2ma3991.ojm');
const samples = C.parseOjm(fs.readFileSync(ojm), (b) => new TextDecoder('windows-1252').decode(b));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-'));

const pick = [...samples.entries()].sort((a, b) => b[1].bytes.length - a[1].bytes.length);
const list = [...pick.slice(0, 5), ...pick.slice(Math.floor(pick.length / 2), Math.floor(pick.length / 2) + 3), ...pick.slice(-3)];

function ffmpegDurationMs(file) {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    const err = (e.stderr || Buffer.from('')).toString();
    const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(err);
    if (m) return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
  }
  return null;
}

console.log('样本 ' + samples.size + ' 个；抽查 ' + list.length + ' 个\n');
console.log('id      我的解析      ffmpeg       结果');
let ok = 0, bad = 0, na = 0;
for (const [id, s] of list) {
  const mine = sampleDurationMs(s.bytes);
  const ext = (path.extname(s.name || '') || '.ogg');
  const f = path.join(TMP, 'x' + id + ext);
  fs.writeFileSync(f, s.bytes);
  const ff = ffmpegDurationMs(f);
  let verdict;
  if (mine === null || ff === null) { verdict = '无法比对'; na++; }
  else {
    const diff = Math.abs(mine - ff);
    if (diff < 60) { verdict = '✔ 一致'; ok++; }
    else if (diff < 250) { verdict = '≈ 差 ' + diff.toFixed(0) + 'ms'; ok++; }
    else { verdict = '✘ 差 ' + diff.toFixed(0) + 'ms'; bad++; }
  }
  console.log('  ' + String(id).padEnd(6)
    + (mine === null ? 'null' : (mine / 1000).toFixed(2) + 's').padStart(11)
    + (ff === null ? 'null' : (ff / 1000).toFixed(2) + 's').padStart(12) + '   ' + verdict
    + '   ' + (s.name || ''));
}
console.log('\n一致 ' + ok + '，不一致 ' + bad + '，无法比对 ' + na);
console.log('临时目录：' + TMP);
