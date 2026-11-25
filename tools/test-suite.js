// 测试套件：直接 import src/ 下的模块（不再从 HTML 里抽代码）
// 谱面图库默认在项目目录的上一级（可用 OJN_ROOT 环境变量指定）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from '../src/index.js';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(TOOLS, '..');                     // SeriousBeatmapConverter/
const OJN_ROOT = process.env.OJN_ROOT || (function(){
  // 夹具默认在 Tools/_qa（与核心工程并列）；老结构（工程上一级直接放 OfficialBeatmaps）也认
  const qa = path.resolve(PROJ, '..', '_qa');
  if (fs.existsSync(path.join(qa, 'OfficialBeatmaps'))) return qa;
  return path.resolve(PROJ, '..');
})();
const html = fs.readFileSync(path.join(PROJ, 'index.html'), 'utf8');
// 供 DOM 接线检查用：页面标签 + 所有模块源码（src 下全量扫描：core/ 与 modes/ 分层后不再维护固定清单）
const body = html.slice(0, html.indexOf('<script'));
const core = walk(path.join(PROJ, 'src')).filter(p => /\.js$/.test(p))
  .map(p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } })
  .join('\n');
// 浏览器里用 <script> 加载的 lamejs（vendor 里那份），Node 里用 vm 载入同一文件 → 编解码同源
const lamePath = path.join(PROJ, 'vendor/lamejs/lame.min.js');
if (fs.existsSync(lamePath)) vm.runInThisContext(fs.readFileSync(lamePath, 'utf8'));

// 读取 Java 版生成的 .osu（如果有的话，见文件末尾说明）
const verifyDir = process.env.OJN_VERIFY || path.join(process.env.TEMP || '.', 'ojnverify');
function walk(dir, out) {
  out = out || [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
/** 在图库里找一批可用的 .ojn（目录结构会变，所以自动搜） */
function findOjnFiles(limit) {
  const found = walk(OJN_ROOT).filter(p => /\.ojn$/i.test(p) && !/o2jam-to-osu/.test(p));
  return found.slice(0, limit || 1);
}
function javaOsuByLevel(level) {
  if (!fs.existsSync(verifyDir)) return null;
  for (const p of walk(verifyDir)) {
    if (!p.endsWith('.osu')) continue;
    const text = fs.readFileSync(p, 'utf8');
    if (text.includes('[O2Jam] [' + level + ']')) return { name: path.basename(p), text };
  }
  return null;
}
function section(text, name) {
  const lines = text.split(/\r?\n/);
  const i = lines.indexOf('[' + name + ']');
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\[/.test(lines[j])) break;
    if (lines[j].trim() !== '') out.push(lines[j]);
  }
  return out;
}
function diff(a, b) {
  const n = Math.max(a.length, b.length);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      if (bad < 6) console.log('   行' + i + '  Java: ' + JSON.stringify(a[i]) + '\n           本工具: ' + JSON.stringify(b[i]));
      bad++;
    }
  }
  return bad;
}

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log('  ✔ ' + msg); } else { fail++; console.log('  ✘ ' + msg); } }

// ---------------- 测试 1：真实 OJN 解析 + （可选）与 Java 版逐行对比 ----------------
const samples = findOjnFiles(1);
if (!samples.length) {
  console.log('\n✘ 当前目录下找不到任何 .ojn，无法测试');
  process.exit(1);
}
const ojnPath = samples[0];
const buf = fs.readFileSync(ojnPath);
const u8 = new Uint8Array(buf);
const header = C.parseOjnHeader(buf);
const raw = [header.rawTitle, header.rawArtist, header.rawNoter];
const enc = C.detectEncoding(raw);
const decode = C.makeTextDecoder(enc.encoding);

console.log('\n=== 测试1: 解析 ' + path.basename(ojnPath) + ' ===');
console.log('  路径 =', ojnPath.replace(OJN_ROOT + path.sep, ''));
console.log('  编码检测 =', enc.encoding, '得分', JSON.stringify(enc.scores));
console.log('  解码 -> title=' + JSON.stringify(decode(header.rawTitle)),
            'artist=' + JSON.stringify(decode(header.rawArtist)),
            'noter=' + JSON.stringify(decode(header.rawNoter)));
check(header.songid > 0, 'songid = ' + header.songid);
check(/\ufffd/.test(decode(header.rawTitle)) === false, '标题里没有替换字符（解码成功）');
check(decode(header.rawNoter).length > 0, '谱师名非空：' + JSON.stringify(decode(header.rawNoter)));
check(header.noteOffsets[0] === 300, '第一个音符块从 0x12C(300) 开始');
check(header.noteOffsets[0] <= header.noteOffsets[1] && header.noteOffsets[1] <= header.noteOffsets[2],
      '三个难度的 note_offset 递增');
check(header.coverOffset >= header.noteOffsets[2], '封面偏移在音符数据之后');

// 三个难度都能生成且通过自检
for (let idx = 0; idx < 3; idx++) {
  const events = C.parseOjnEvents(u8, header.noteOffsets[idx],
                                 idx < 2 ? header.noteOffsets[idx + 1] : header.coverOffset);
  const built = C.buildChart(header.bpm, events, false);
  const text = C.buildOsuText({
    header: Object.assign({}, header, { fileName: path.basename(ojnPath) }),
    chart: { level: header.levels[idx] },
    meta: { title: decode(header.rawTitle), artist: decode(header.rawArtist), noter: decode(header.rawNoter),
            od: NaN, hp: 8.2, serverTag: '', diffName: C.DIFFS[idx].verSuffix },
    timingPoints: built.timingPoints, hitObjects: built.hitObjects,
    audioFilename: 'x.wav', musicOffset: 0, coverName: 'bg.jpg',
  });
  const probs = C.validateOsuText(text);
  console.log('  ' + C.DIFFS[idx].name + '：物件 ' + built.hitObjects.length + ' / 时间点 ' + built.timingPoints.length
    + ' / 音频对象 ' + built.audioObjects.length + '，自检 ' + (probs.length ? '✘ ' + probs[0] : '✔ 通过'));
  check(probs.length === 0, C.DIFFS[idx].name + ' 输出自检通过');
  check(built.hitObjects.length > 0, C.DIFFS[idx].name + ' 有物件（' + built.hitObjects.length + '）');
  check(text.includes('Version:[O2Jam] [' + header.levels[idx] + ']' + C.DIFFS[idx].verSuffix),
        C.DIFFS[idx].name + ' Version 字符串正确');
  if (header.noteCounts[idx] > 0)
    check(built.hitObjects.length <= header.noteCounts[idx] * 2,
          C.DIFFS[idx].name + ' 物件数不异常（头部声明 ' + header.noteCounts[idx] + '）');
}

// 与 Java 版逐行对比（需要先跑过 o2jam-to-osu.jar，见末尾说明）
{
  const idx = 2;   // 用一个存在的难度跟 Java 对
  const evs2 = C.parseOjnEvents(u8, header.noteOffsets[idx], header.coverOffset);
  const off = C.buildChart(header.bpm, evs2, false, { enabled: false });   // 关修正 = 应当等同原版
  const on = C.buildChart(header.bpm, evs2, false);                        // 开修正 = 本工具默认
  const mk = (b) => C.buildOsuText({
    header: Object.assign({}, header, { fileName: path.basename(ojnPath) }), chart: { level: header.levels[idx] },
    meta: { title: 'T', artist: 'A', noter: 'N', od: NaN, hp: 8.2, serverTag: '', diffName: null },
    timingPoints: b.timingPoints, hitObjects: b.hitObjects,
    audioFilename: 'x.wav', musicOffset: 0, coverName: '',
  });
  const text = mk(off);
  const j = javaOsuByLevel(header.levels[idx]);
  if (!j) {
    console.log('  ℹ 跳过 Java 对比（没找到 ' + verifyDir + '；跑法见文件末尾注释）');
  } else {
    const jt = section(j.text, 'TimingPoints'), jh = section(j.text, 'HitObjects');
    const myt = section(text, 'TimingPoints'), myh = section(text, 'HitObjects');
    console.log('  ' + C.DIFFS[idx].name + '：Java 时间点 ' + jt.length + ' / 物件 ' + jh.length
      + '；本工具(关修正) ' + myt.length + ' / ' + myh.length);
    check(jt.length === myt.length && diff(jt, myt) === 0, 'TimingPoints 与 Java 完全一致（关修正）');
    check(jh.length === myh.length && diff(jh, myh) === 0, 'HitObjects 与 Java 完全一致（关修正）');
  }
  console.log('  修正开/关物件数：' + on.hitObjects.length + ' / ' + off.hitObjects.length
    + (C.describeRepairs(on.stats) ? '；修正动作：' + C.describeRepairs(on.stats) : '；本曲无需修正'));
  check(C.validateOsuText(mk(on)).length === 0, '开修正后输出依旧通过自检');
}

// ---------------- 测试 2：批量头部解析与编码检测（扫当前目录里的真实文件）----------------
console.log('\n=== 测试2: 批量头部解析 ===');
let checked = 0, mismatch = 0;
for (const p of findOjnFiles(60)) {
  const b = fs.readFileSync(p);
  let h, t, a, n;
  try { h = C.parseOjnHeader(b); } catch (e) { continue; }
  const encName = C.detectEncoding([h.rawTitle, h.rawArtist, h.rawNoter]).encoding;
  const dec = C.makeTextDecoder(encName);
  t = dec(h.rawTitle); a = dec(h.rawArtist); n = dec(h.rawNoter);
  checked++;
  const bad = /\ufffd/.test(t + a + n) || h.bpm <= 0 || h.levels.some(l => l < 0) || !t.length;
  if (bad) {
    mismatch++;
    if (mismatch < 6) console.log('  ✘ ' + path.basename(p) + ' bpm=' + h.bpm + ' title=' + JSON.stringify(t));
  }
}
console.log('  抽查 ' + checked + ' 个文件，异常 ' + mismatch + ' 个');
check(checked > 0, '至少解析了 1 个 OJN');
check(mismatch === 0, '批量解析无异常（无替换字符 / bpm>0 / 等级非负 / 标题非空）');

// ---------------- 测试 3：ZIP 结构 ----------------
console.log('\n=== 测试3: ZIP 打包 ===');
const zip = C.makeZip([{ name: 'a b.txt', data: new TextEncoder().encode('hello') },
                       { name: '曲/歌.osu', data: new TextEncoder().encode('osu file format v14\n') }]);
check(zip[0] === 0x50 && zip[1] === 0x4b, '本地文件头签名 PK\\x03\\x04');
check(new DataView(zip.buffer).getUint32(zip.length - 22, true) === 0x06054b50, '中央目录结束记录签名正确');
check(new DataView(zip.buffer).getUint16(zip.length - 12, true) === 2, '条目数 = 2');
console.log('  ZIP 大小 =', zip.length, '字节');
if (fs.existsSync(path.join(verifyDir, 'o2ma110.ojn'))) { /* 无 */ }

// ---------------- 测试 4：OJM 解析（拿同目录的 .ojm）----------------
console.log('\n=== 测试4: OJM 样本解析 ===');
let ojmPath = path.join(path.dirname(ojnPath), path.basename(ojnPath).replace(/\.ojn$/i, '.ojm'));
if (!fs.existsSync(ojmPath)) {
  const cand = walk(OJN_ROOT).filter(p => /\.ojm$/i.test(p) && !/o2jam-to-osu/.test(p));
  ojmPath = cand[0];
}
if (!ojmPath || !fs.existsSync(ojmPath)) {
  console.log('  ℹ 跳过：当前目录找不到 .ojm');
} else {
const ojmBuf = fs.readFileSync(ojmPath);
const sig = new DataView(ojmBuf.buffer, ojmBuf.byteOffset).getInt32(0, true);
console.log('  文件 =', path.basename(ojmPath), ' 签名 = 0x' + (sig >>> 0).toString(16),
            '(', Buffer.from(ojmBuf.slice(1, 4)).toString('ascii'), ')');
const smp = C.parseOjm(ojmBuf.buffer.slice(ojmBuf.byteOffset, ojmBuf.byteOffset + ojmBuf.length),
                       (bytes) => new TextDecoder('windows-1252').decode(bytes));
console.log('  样本数 =', smp.size);
const head = [...smp.entries()].slice(0, 3).map(([id, s]) => id + ':' + s.name + '(' + s.bytes.length + 'B)').join(', ');
console.log('  前几个 =', head);
const q4 = [...smp.values()].filter(s => s.bytes[0] === 0x4F && s.bytes[1] === 0x67 && s.bytes[2] === 0x67);
check(smp.size > 0, 'OJM 解析出样本（' + smp.size + ' 个）');
check(q4.length > 0, '至少一个样本是合法 OggS 头（' + q4.length + '/' + smp.size + '）');
const wavs = [...smp.values()].filter(s => s.bytes[0] === 0x52 && s.bytes[1] === 0x49 && s.bytes[2] === 0x46);
console.log('  WAV 样本数 =', wavs.length);
}

// ---------------- 测试 5：混音 → WAV（用假 AudioContext 验证数学与头部）----------------
(async () => {
  console.log('\n=== 测试5: 混音与 WAV 输出 ===');
  const RATE = 1000;                      // 便于心算
  function fakeBuffer(samples) {
    return { length: samples.length, numberOfChannels: 1, sampleRate: RATE,
             duration: samples.length / RATE,
             getChannelData: () => Float32Array.from(samples) };
  }
  const decoded = { 1000: fakeBuffer([1, 1, 1, 1]), 1001: fakeBuffer([0.5, 0.5]) };
  const ctx = { sampleRate: RATE, decodeAudioData: async (ab) => {
    const id = new DataView(ab).getInt32(0, true);
    return decoded[id];
  } };
  const samples = new Map([
    [1000, { name: 'a.ogg', bytes: new Uint8Array(new Int32Array([1000]).buffer), mime: 'audio/ogg' }],
    [1001, { name: 'b.ogg', bytes: new Uint8Array(new Int32Array([1001]).buffer), mime: 'audio/ogg' }],
  ]);
  // 两个音频对象：t=0ms 全音量居中的 sample1000（4 帧）；t=4ms 全音量最左的 sample1001（2 帧，不重叠）
  const objs = [{ time: 0, sampleId: 1000, volume: 1, pan: 0 },
                { time: 4, sampleId: 1001, volume: 1, pan: -1 }];
  const r = await C.mixToWav(ctx, objs, samples, RATE, { normalize: false });   // 关归一化：本节测的是混音数学
  const dv = new DataView(r.wav.buffer);
  const tag = (o) => String.fromCharCode(r.wav[o], r.wav[o+1], r.wav[o+2], r.wav[o+3]);
  console.log('  WAV 字节数 =', r.wav.length, ' 音乐偏移 =', r.musicOffset, ' 使用样本数 =', r.usedSamples);
  check(tag(0) === 'RIFF' && tag(8) === 'WAVE' && tag(12) === 'fmt ' && tag(36) === 'data', 'WAV 头部标识正确');
  check(dv.getUint16(20, true) === 1 && dv.getUint16(22, true) === 2, 'PCM / 双声道');
  check(dv.getUint32(24, true) === RATE && dv.getUint32(28, true) === RATE * 4, '采样率与字节率正确');
  check(dv.getUint32(4, true) === r.wav.length - 8 && dv.getUint32(40, true) === r.wav.length - 44, 'RIFF/data 长度字段自洽');
  // pan=0 → 左右各 cos(45°)=sin(45°)=0.7071；pan=-1 → 全左
  const L0 = dv.getInt16(44, true), R0 = dv.getInt16(46, true);
  const L3 = dv.getInt16(44 + 3 * 4, true), R3 = dv.getInt16(46 + 3 * 4, true);
  const L4 = dv.getInt16(44 + 4 * 4, true), R4 = dv.getInt16(46 + 4 * 4, true);
  console.log('  第0帧 L/R =', L0, R0, '  第3帧 L/R =', L3, R3, '  第4帧 L/R =', L4, R4);
  check(L3 === L0 && R3 === R0, '第0~3 帧完全是 sample1000（前后不串音）');
  check(L0 === 32767 && R0 === 32767, '居中样本两声道原样通过（平衡式声像：不再 ×0.707）');
  check(L4 === 16383 && R4 === 0, 'pan=-1 只进左声道（0.5×32767≈16383）');
  check(r.musicOffset === 0, '多个对象时 musicOffset = 0（与原版一致）');
  const single = await C.mixToWav(ctx, [{ time: 7, sampleId: 1000, volume: 1, pan: 0 }], samples, RATE, { normalize: false });
  check(single.musicOffset === 0,
        '单样本时 musicOffset = 0（本混音器已把前置静音写进音频，不能再位移；原版单样本分支是直接拷贝样本文件才需要偏移）');

  // ---------------- 测试 6：Tags 自定义 ----------------
  console.log('\n=== 测试6: [Metadata] Tags 自定义 ===');
  const baseCtx = { file: 'o2ma104.ojn', noter: 'No 1 Family', songid: 104,
                    title: '[国服]失去控制', artist: 'RAVEN', diff: 'HX', level: 9 };
  const BASE = 'O2Jam 5ynt3ck convert o2ma104.ojn';
  check(C.buildTags({ tagMode: 'keep' }, baseCtx) === BASE, 'keep = 原版 Tags');
  check(C.buildTags({ tagMode: 'keep', serverTag: '9you' }, baseCtx)
        === 'O2Jam 9you 5ynt3ck convert o2ma104.ojn', 'keep + 服务器 tag 与原版一致');
  check(C.buildTags({ tagMode: 'append', tagTemplate: '我的图集' }, baseCtx) === BASE + ' 我的图集',
        'append = 原版 Tags + 自定义');
  check(C.buildTags({ tagMode: 'replace', tagTemplate: 'o2jam pack' }, baseCtx) === 'o2jam pack',
        'replace = 只用自定义');
  check(C.buildTags({ tagMode: 'append', tagTemplate: '   ' }, baseCtx) === BASE, '自定义内容为空时回退到原版');
  check(C.buildTags({ tagMode: 'replace', tagTemplate: '{artist}_{title}_{diff}_Lv{level}_#{songid}_{noter}_{file}' }, baseCtx)
        === 'RAVEN_[国服]失去控制_HX_Lv9_#104_No 1 Family_o2ma104.ojn', '占位符全部展开');
  const BASE9 = 'O2Jam 9you 5ynt3ck convert o2ma104.ojn';       // 带服务器 tag 的原版 Tags
  check(C.buildTags({ tagMode: 'append', tagTemplate: '[{server}]x', serverTag: '9you' }, baseCtx)
        === BASE9 + ' [9you]x', '自定义里的 {server} 取服务器 tag');
  check(C.buildTags({ tagMode: 'replace', tagTemplate: '{server}', serverTag: '9you' }, baseCtx) === '9you',
        'replace 时只留自定义内容');
  check(C.expandPlaceholders('{unknown} {bad} {noter}', baseCtx) === '{unknown} {bad} No 1 Family',
        '未知占位符原样保留');
  check(C.expandPlaceholders('a\nb   c', baseCtx) === 'a b c', '换行/多余空格归一化（Tags 必须单行）');

  const o6 = C.buildChart(140, C.parseOjnEvents(u8, header.noteOffsets[2], header.coverOffset), false);
  const mk = (meta) => C.buildOsuText({
    header: Object.assign({}, header, { fileName: 'o2ma110.ojn' }), chart: { level: 13 },
    meta: Object.assign({ title: 'T', artist: 'A', noter: 'NF-Special', od: NaN, hp: 8.2, serverTag: '' }, meta),
    timingPoints: o6.timingPoints, hitObjects: o6.hitObjects,
    audioFilename: 'x.wav', musicOffset: 0, coverName: '',
  });
  const text6 = mk({ tags: 'my pack v2' });
  check(text6.includes('Tags:my pack v2'), 'Tags 行用了自定义内容');
  check(text6.includes('Creator:NF-Special'), '谱师（Creator）仍然写原 noter');
  const text6b = mk({ diffName: null });
  check(text6b.includes('Tags:O2Jam 5ynt3ck convert o2ma110.ojn'), '未自定义时 Tags 与原版逐字一致');
  check(text6b.includes('Creator:NF-Special'), '未自定义时 Creator 与原版一致');

  // ---------------- 测试 7：DOM 接线 ----------------
  console.log('\n=== 测试7: 界面元素接线 ===');
  const defined = new Set([...body.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const used = new Set([...core.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1]));
  const missing = [...used].filter(id => !defined.has(id));
  check(missing.length === 0, '脚本引用的 ' + used.size + ' 个 id 全部存在'
        + (missing.length ? '（缺：' + missing.join(', ') + '）' : ''));
  const optIds = ['tagMode', 'tagTemplate', 'tagPreview', 'encoding', 'autoRepair', 'lnMaxBeats'];
  check(optIds.every(id => defined.has(id)), 'Tags/编码控件都在 HTML 里');
  check(defined.has('useFfmpeg') && defined.has('ffmpegState'), '本地 ffmpeg 开关与状态提示都在 HTML 里');
  check(/id="useFfmpeg"[^>]*\bchecked\b/.test(body), '本地 ffmpeg 开关默认打开（探测到接口就直接用）');
  check(!/id="useFfmpeg"[^>]*\bdisabled\b/.test(body), '开关初始不置灰（探测失败时由脚本自己置灰）');
  check(!/id="noter(Mode|Template|Fallback|Tag|Preview)"/.test(body), '旧的“谱师标签”控件已移除');
  // 布局：①② 并列需包在同一个 .cols2.top 里；标签配对要平衡
  check(/<div class="cols2 top">[\s\S]*?<h2>① [\s\S]*?<h2>② [\s\S]*?<\/section>\s*<\/div>/.test(body),
        '① 选曲 与 ② 转谱细则 并列在同一个 .cols2.top 容器内');
  const count = (re) => (body.match(re) || []).length;
  const pairs = [['div', /<div\b/g, /<\/div>/g], ['section', /<section\b/g, /<\/section>/g],
                 ['label', /<label\b/g, /<\/label>/g], ['details', /<details\b/g, /<\/details>/g],
                 ['p', /<p\b/g, /<\/p>/g]];
  const unbalanced = pairs.filter(([, o, c]) => count(o) !== count(c)).map(([n, o, c]) => n + '(' + count(o) + '/' + count(c) + ')');
  check(unbalanced.length === 0, '常用标签开闭配对平衡' + (unbalanced.length ? '（不平：' + unbalanced.join(', ') + '）' : ''));
  const optRows = count(/<div class="opt\b/g);
  check(optRows >= 7, '② 的选项已按标签长度拆成 ' + optRows + ' 行');
  // 取某个控件所在的那一行 .opt（行内不含嵌套 div，所以第一个 </div> 就是行尾）
  const rowBlock = (id) => {
    const i = body.indexOf('id="' + id + '"');
    if (i < 0) return '';
    const s = body.lastIndexOf('<div class="opt', i);
    const e = body.indexOf('</div>', i);
    return (s >= 0 && e > i) ? body.slice(s, e) : '';
  };
  check(!!rowBlock('audioMode') && rowBlock('audioMode') === rowBlock('rate')
        && !rowBlock('audioMode').includes('suffixMode'),
        '音频 与 采样率 在同一行（且不和其他项混在一起）');
  const suffixRow = rowBlock('suffixMode');
  check(!!suffixRow && suffixRow !== rowBlock('audioMode') && suffixRow.includes('自动修复异常 Note') === false,
        '难度后缀 单独一行');

  // ---------------- 测试 8：musicOffset > 0 的时间取整（回归：曾经写出小数时间导致 osu! 拒绝导入）----------------
  console.log('\n=== 测试8: musicOffset 偏移后的时间取整 ===');
  const o8 = C.buildChart(header.bpm, C.parseOjnEvents(u8, header.noteOffsets[2], header.coverOffset), false);
  const mk8 = (off) => C.buildOsuText({
    header: Object.assign({}, header, { fileName: path.basename(ojnPath) }), chart: { level: 13 },
    meta: { title: 'T', artist: 'A', noter: 'N', od: NaN, hp: 8.2, serverTag: '', diffName: null },
    timingPoints: o8.timingPoints, hitObjects: o8.hitObjects,
    audioFilename: 'x.wav', musicOffset: off, coverName: '',
  });
  const frac = 1607.4512195121952 - Math.floor(1607.4512195121952);   // 一个非整数偏移量
  const text8 = mk8(frac);
  const ho8 = section(text8, 'HitObjects');
  const floatTimes = ho8.filter(l => {
    const p = l.split(',');
    return !/^-?\d+$/.test(p[2]) || (p.length === 7 && p[3] === '128' && !/^-?\d+$/.test(p[5]));
  });
  console.log('  musicOffset =', frac, '→ 物件 ' + ho8.length + '，含小数时间的 ' + floatTimes.length);
  if (floatTimes.length) console.log('    例：' + floatTimes[0]);
  check(floatTimes.length === 0, 'musicOffset>0 时 HitObject 时间仍是整数（原版 int 语义）');
  check(C.validateOsuText(text8).length === 0, '自检通过：' + (C.validateOsuText(text8)[0] || '无问题'));
  const text8b = mk8(0);
  check(section(text8b, 'TimingPoints').length === section(text8, 'TimingPoints').length,
        '时间点数量不受偏移影响');
  check(C.validateOsuText(text8b).length === 0, 'musicOffset=0 时自检也通过');

  // 自检本身要能抓出坏文件
  const broken = text8b.replace(/,192,(\d+),1,/, ',192,1607.4512195121952,1,');
  check(C.validateOsuText(broken).some(p => /不是整数/.test(p)), '自检能识破小数时间');
  check(C.validateOsuText(text8b.replace(/^\[TimingPoints\]$/m, '[TimingPoints]\n100,0,4,0,0,30,1,0'))
        .some(p => /beatLength = 0/.test(p)), '自检能识破 beatLength=0');

  // ---------------- 测试 9：异常 Note 自动修正 ----------------
  console.log('\n=== 测试9: 异常 Note 自动修正 ===');
  const sortEv = (evs) => evs.sort((a, b) => (a.measure + a.position) - (b.measure + b.position));
  const evs = sortEv([
    { channel: 3, measure: 0, position: 0,    value: 1, flag: 'HOLD',    volume: 1, pan: 0 },  // 未闭合长条
    { channel: 3, measure: 0, position: 0.5,  value: 1, flag: 'NONE',    volume: 1, pan: 0 },  // 同列下一个物件 @1000ms
    { channel: 4, measure: 0, position: 0,    value: 1, flag: 'HOLD',    volume: 1, pan: 0 },  // 正常 LN
    { channel: 4, measure: 0, position: 0.5,  value: 1, flag: 'RELEASE', volume: 1, pan: 0 },
    { channel: 5, measure: 1, position: 0,    value: 1, flag: 'RELEASE', volume: 1, pan: 0 },  // 孤立 RELEASE
    { channel: 6, measure: 0, position: 0.25, value: 1, flag: 'NONE',    volume: 1, pan: 0 },  // 同刻重复短音
    { channel: 6, measure: 0, position: 0.25, value: 1, flag: 'NONE',    volume: 1, pan: 0 },
  ]);
  const b9 = C.buildChart(120, evs, false);          // 默认开启修正
  console.log('  物件：', b9.hitObjects.map(h => `${h._column}:${h.time}~${h.endTime}(t${h.type})`).join('  '));
  console.log('  修正：', C.describeRepairs(b9.stats));
  const ln9 = b9.hitObjects.find(h => h._column === 2 && h.type === 128);
  check(b9.stats.closedHold === 1, '未闭合长条补尾 × 1');
  check(!!ln9 && ln9.endTime - ln9.time === 250, '未闭合长条补成 1/2 拍（120BPM → 250ms）');
  check(b9.hitObjects.some(h => h._column === 2 && h.type === 1 && h.time === 1000),
        '后续同列音符不受影响（长条只占 1/2 拍）');
  check(b9.stats.duplicate === 1, '同列同刻重复短音去重 × 1');
  check(b9.stats.danglingRelease === 1, '孤立 RELEASE 计数 × 1');
  check(b9.hitObjects.every(h => h.endTime !== -1), '输出里没有 endTime = -1');
  check(C.describeRepairs(b9.stats).length > 0, '修正统计能拼出可读文本');
  const lnNormal = b9.hitObjects.find(h => h._column === 3 && h.type === 128);
  check(!!lnNormal && lnNormal.time === 0 && lnNormal.endTime === 1000, '正常 LN 保持成对不变');

  const t9 = C.buildOsuText({
    header: { fileName: 'x.ojn' }, chart: { level: 5 },
    meta: { title: 'T', artist: 'A', noter: 'N', od: NaN, hp: 8.2, serverTag: '' },
    timingPoints: b9.timingPoints, hitObjects: b9.hitObjects,
    audioFilename: 'x.wav', musicOffset: 0, coverName: '', stats: b9.stats,
  });
  check(C.validateOsuText(t9).length === 0, '输出自检通过：' + (C.validateOsuText(t9)[0] || '无问题'));
  check(!/,\s*128\s*,\s*0\s*,\s*-1\s*,/.test(t9), '文件里不再出现 ",128,0,-1,"');

  // 关掉修正：仍然保证可导入（降级成普通 Note），但不补尾
  const b9off = C.buildChart(120, evs, false, { enabled: false });
  check(b9off.stats.demotedHold === 1 && b9off.hitObjects.every(h => h.endTime !== -1),
        '关闭修正时未闭合长条降级为 Note（依旧可导入）');

  // 同列后面没有物件时也一样：一律 1/2 拍
  const b9lone = C.buildChart(120, sortEv([{ channel: 3, measure: 0, position: 0, value: 1, flag: 'HOLD', volume: 1, pan: 0 }]), false);
  check(b9lone.hitObjects[0].endTime === 250, '孤零零的长条也是 1/2 拍（120BPM → 250ms）');
  // 零长长条（同刻 RELEASE）→ 同样 1/2 拍
  const b9zero = C.buildChart(120, sortEv([
    { channel: 3, measure: 0, position: 0, value: 1, flag: 'HOLD', volume: 1, pan: 0 },
    { channel: 3, measure: 0, position: 0, value: 1, flag: 'RELEASE', volume: 1, pan: 0 },
  ]), false);
  check(b9zero.stats.shortHold === 1 && b9zero.hitObjects[0].endTime === 250, '零长/反向长条也补成 1/2 拍');
  // 半拍要跟长条那一刻的 BPM，而不是头部 BPM（此处 BPM 改成 240 → 半拍 125ms）
  const b9fast = C.buildChart(120, sortEv([
    { channel: 18, measure: 0, position: 0, value: 240, flag: 'NONE', volume: 1, pan: 0 },   // BPM_CHANGE
    { channel: 3, measure: 1, position: 0, value: 1, flag: 'HOLD', volume: 1, pan: 0 },      // 此时 BPM=240
  ]), false);
  check(b9fast.hitObjects[0].endTime - b9fast.hitObjects[0].time === 125,
        '变速谱按长条所在时刻的 BPM 算半拍（240BPM → 125ms）');

  // 超长长条阈值（默认 0 = 不处理；设成 2 拍时超长的压成 1/2 拍）
  const evsLong = sortEv([
    { channel: 3, measure: 0, position: 0,   value: 1, flag: 'HOLD',    volume: 1, pan: 0 },  // 0ms
    { channel: 3, measure: 4, position: 0,   value: 1, flag: 'RELEASE', volume: 1, pan: 0 },  // 8000ms → 16 拍
    { channel: 4, measure: 1, position: 0,   value: 1, flag: 'HOLD',    volume: 1, pan: 0 },  // 2000ms
    { channel: 4, measure: 1, position: 0.5, value: 1, flag: 'RELEASE', volume: 1, pan: 0 },  // 3000ms → 2 拍
  ]);
  const bLongOff = C.buildChart(120, evsLong, false);
  const bLongOn = C.buildChart(120, evsLong, false, { enabled: true, maxBeats: 2 });
  check(bLongOff.stats.longHold === 0 && bLongOff.hitObjects[0].endTime === 8000, '阈值 0 时不处理超长长条（保持 16 拍）');
  check(bLongOn.stats.longHold === 1 && bLongOn.hitObjects[0].endTime - bLongOn.hitObjects[0].time === 250,
        '阈值 2 拍时超长长条压成 1/2 拍（250ms），刚好 2 拍的不动');
  check(bLongOn.hitObjects.some(h => h._column === 3 && h.type === 128 && h.endTime - h.time === 1000),
        '刚好等于阈值的 2 拍长条不改动');

  // 回归：原版 holdEndTimes 初始为 0，会把“时间正好 = 0”的短音当成 LN 内夹音丢掉
  const b9t0 = C.buildChart(120, sortEv([{ channel: 3, measure: 0, position: 0, value: 1, flag: 'NONE', volume: 1, pan: 0 }]), false);
  check(b9t0.hitObjects.length === 1 && b9t0.hitObjects[0].time === 0, '时间 0 的短音不再被丢掉');

  // 负时间钓零（构造一个巨大的 musicOffset）
  const b9neg = C.buildChart(120, sortEv([{ channel: 3, measure: 1, position: 0, value: 1, flag: 'NONE', volume: 1, pan: 0 }]), false);
  const negStats = {};
  const tNeg = C.buildOsuText({
    header: { fileName: 'x.ojn' }, chart: { level: 5 },
    meta: { title: 'T', artist: 'A', noter: 'N', od: NaN, hp: 8.2, serverTag: '' },
    timingPoints: b9neg.timingPoints, hitObjects: b9neg.hitObjects,
    audioFilename: 'x.wav', musicOffset: 99999, coverName: '', stats: negStats,
  });
  check(negStats.negativeTime >= 1 && section(tNeg, 'HitObjects').every(l => parseFloat(l.split(',')[2]) >= 0),
        '负时间被钓到 0 并计数（' + negStats.negativeTime + ' 个）');

  // ---------------- 测试 10：混音偏移回归（曾经让整张图提前 = 单样本时返回了非 0 musicOffset）----------------
  console.log('\n=== 测试10: 混音偏移 ===');
  const oneObj = await C.mixToWav(ctx, [{ time: 7000, sampleId: 1000, volume: 1, pan: 0 }], samples, RATE);
  check(oneObj.musicOffset === 0, '整首只用到 1 个样本时 musicOffset 仍为 0（音频已含前置静音）');
  check(oneObj.firstSampleTime === 7000, '报告首个样本位置 7000ms（仅用于日志/排查）');
  const dvOne = new DataView(oneObj.wav.buffer);
  check(dvOne.getInt16(44 + 6 * RATE * 4, true) === 0, '7000ms 之前确实是静音');
  check(dvOne.getInt16(44 + 7000 * 4, true) > 10000, '7000ms 处才有声音（与 .osu 时间轴对齐）');

  // ---------------- 测试 11（信息性）：在整个图库上统计修正命中数量 ----------------
  console.log('\n=== 测试11: 全库修正命中统计（信息性） ===');
  {
    const files = findOjnFiles(400);
    const agg = { charts: 0, closedHold: 0, shortHold: 0, duplicate: 0, tapInHold: 0,
                  mergedHold: 0, danglingRelease: 0, demotedHold: 0, affected: 0,
                  keptAtHoldEnd: 0, tapAtHoldEnd: 0, t0note: 0, t0kept: 0, firstTimeNeg: 0 };
    const examples = [];
    for (const p of files) {
      let h;
      try { h = C.parseOjnHeader(fs.readFileSync(p)); } catch (e) { continue; }
      const buf = fs.readFileSync(p);
      for (let idx = 0; idx < 3; idx++) {
        if (!h.noteCounts[idx]) continue;
        const evs = C.parseOjnEvents(new Uint8Array(buf), h.noteOffsets[idx],
          idx < 2 ? h.noteOffsets[idx + 1] : h.coverOffset);
        if (!evs.length) continue;
        agg.charts++;
        const on = C.buildChart(h.bpm, evs, false);
        const off = C.buildChart(h.bpm, evs, false, { enabled: false });
        const s = on.stats;
        let hit = 0;
        for (const k of ['closedHold', 'shortHold', 'duplicate', 'tapInHold', 'mergedHold',
                         'danglingRelease', 'keptAtHoldEnd', 'tapAtHoldEnd']) {
          agg[k] += s[k] || 0; hit += s[k] || 0;
        }
        agg.demotedHold += off.stats.demotedHold || 0;
        if (hit) { agg.affected++; if (examples.length < 5) examples.push(path.basename(p) + '#' + idx + ' ' + JSON.stringify(s)); }
        // 统计时间 0 的短音（这是修好的：holdEndTimes 哨兵 0 → -1）
        const t0 = off.hitObjects.filter(o => o.time === 0 && o.type === 1).length;
        if (t0) { agg.t0note += t0; agg.t0kept += on.hitObjects.filter(o => o.time === 0 && o.type === 1).length; }
      }
    }
    console.log('  扫了 ' + agg.charts + ' 个难度；有修正动作的 ' + agg.affected + ' 个');
    console.log('  ' + C.describeRepairs(agg));
    console.log('  时间 0 的短音：原版会丢 ' + agg.t0note + ' 个，现在保留 ' + agg.t0kept + ' 个');
    for (const e of examples) console.log('    例：' + e);
    check(agg.charts > 0, '在大图上跑完了全库扫描');
    check(true, '全库修正命中：' + (C.describeRepairs(agg) || '无（数据很干净）'));
  }

  // ---------------- 测试 12（信息性）：长条长度分布 ----------------
  console.log('\n=== 测试12: 长条长度分布（判断“长度异常”阈值用） ===');
  {
    const files = findOjnFiles(400);
    const lensBeats = [], lensMs = [];
    let lns = 0, closed = 0, eaten = 0;
    for (const p of files) {
      let h, buf;
      try { buf = fs.readFileSync(p); h = C.parseOjnHeader(buf); } catch (e) { continue; }
      const u8 = new Uint8Array(buf);
      for (let idx = 0; idx < 3; idx++) {
        if (!h.noteCounts[idx]) continue;
        const evs = C.parseOjnEvents(u8, h.noteOffsets[idx],
          idx < 2 ? h.noteOffsets[idx + 1] : h.coverOffset);
        if (!evs.length) continue;
        const b = C.buildChart(h.bpm, evs, false);
        closed += b.stats.closedHold; eaten += b.stats.tapInHold;
        for (const o of b.hitObjects) {
          if (o.type !== 128) continue;
          lns++;
          const L = o.endTime - o.time;
          lensMs.push(L);
          lensBeats.push(L / (o.beatMs > 0 ? o.beatMs : 60000 / h.bpm));
        }
      }
    }
    lensMs.sort((a, b) => a - b); lensBeats.sort((a, b) => a - b);
    const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
    console.log('  长条 ' + lns + ' 个；本次补尾 ' + closed + ' 个；长条中间夹音丢弃 ' + eaten + ' 个');
    console.log('  长度(拍) p50 ' + q(lensBeats, .5).toFixed(2) + '  p90 ' + q(lensBeats, .9).toFixed(2)
      + '  p99 ' + q(lensBeats, .99).toFixed(2) + '  p99.9 ' + q(lensBeats, .999).toFixed(2)
      + '  最大 ' + (lensBeats[lensBeats.length - 1] || 0).toFixed(1));
    console.log('  长度(ms) p50 ' + q(lensMs, .5) + '  p99 ' + q(lensMs, .99) + '  最大 ' + lensMs[lensMs.length - 1]);
    const over = (n) => lensBeats.filter(x => x > n).length;
    console.log('  超 16 拍：' + over(16) + ' 个；超 64 拍：' + over(64) + ' 个；超 256 拍：' + over(256) + ' 个');
    check(lns > 0, '统计到 ' + lns + ' 个长条');
  }

  // ---------------- 测试 13：音频编码器（MP3 / WAV）----------------
  console.log('\n=== 测试13: 音频编码器 ===');
  const MPEG1_L3_BR = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];   // 比特率索引表
  const mp3Info = (u8) => {
    const h = (u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3];
    return { sync: u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0,
             mpeg1: ((h >>> 19) & 3) === 3, layer3: ((h >>> 17) & 3) === 1,
             bitrate: MPEG1_L3_BR[(h >>> 12) & 15], sampleRateIdx: (h >>> 10) & 3 };
  };
  check(typeof C.lameReady === 'function' && C.lameReady(), 'lamejs 已就绪（与浏览器同一份 vendor 文件）');
  check(C.MP3_BITRATES.join(',') === '128,320', '可选码率表只有两档：' + C.MP3_BITRATES.join('/'));
  check(C.formatById('mp3').defaultBitrate === 320, 'MP3 默认码率 = 320k');
  // 造 1 秒 440Hz 立体声
  const SEC = 44100;
  const pcmT = { left: new Float32Array(SEC), right: new Float32Array(SEC), sampleRate: 44100, length: SEC };
  for (let i = 0; i < SEC; i++) pcmT.left[i] = pcmT.right[i] = Math.sin(2 * Math.PI * 440 * i / 44100) * 0.5;
  const mp3_hi = C.encodeMp3(pcmT);                      // 不传码率 → 用默认 320
  const info = mp3Info(mp3_hi);
  console.log('  MP3@320 =', mp3_hi.length, '字节 | 同步字', mp3_hi[0].toString(16), mp3_hi[1].toString(16),
    '| MPEG1', info.mpeg1, '| LayerIII', info.layer3, '| 解析出码率', info.bitrate + 'kbps');
  check(info.sync && info.mpeg1 && info.layer3, 'MP3 帧头合法（同步字 + MPEG1 + LayerIII）');
  check(info.bitrate === 320, '默认码率为 320k（帧头解析验证）');
  check(info.sampleRateIdx === 0, '帧头里的采样率 = 44100Hz');
  check(Math.abs(mp3_hi.length - 40000) < 4000, '1 秒 320k 体积合理（' + mp3_hi.length + ' ≈ 40000 字节）');
  const mp3_lo = C.encodeMp3(pcmT, { bitrate: 128 });
  check(mp3Info(mp3_lo).bitrate === 128 && mp3_lo.length < mp3_hi.length,
    '128k 比 320k 小（' + mp3_lo.length + ' < ' + mp3_hi.length + '）');
  check(C.encodeMp3(pcmT, { bitrate: 999 }).length === mp3_hi.length, '非表内码率回退到默认 320k');
  const wavT = C.encodeWav(pcmT);
  check(String.fromCharCode(wavT[0], wavT[1], wavT[2], wavT[3]) === 'RIFF'
        && new DataView(wavT.buffer).getUint32(24, true) === 44100, 'WAV 编码仍正常（RIFF + 44100Hz）');
  console.log('  同曲 4 分钟估算：MP3@320 ≈ ' + (40000 * 240 / 1048576).toFixed(1) + ' MB，MP3@128 ≈ '
    + (16000 * 240 / 1048576).toFixed(1) + ' MB，WAV ≈ ' + (44100 * 4 * 240 / 1048576).toFixed(1) + ' MB');
  // 格式注册表
  check(C.formatById('mp3').ext === '.mp3' && C.formatById('mp3').mime === 'audio/mpeg', 'mp3 格式元数据正确');
  check(C.formatById('wav').ext === '.wav' && C.formatById('不存在').id === 'mp3', '未知格式回退到默认（mp3）');
  check(C.AUDIO_FORMATS.length >= 2 && C.AUDIO_FORMATS.every(f => f.id && f.ext && f.label), '格式表可驱动 UI');
  // 端到端：混音 → 编码（用 44100Hz 的假 AudioContext，MP3 只认标准采样率）
  const RATE2 = 44100, N2 = Math.round(RATE2 / 10);
  const sine = Float32Array.from({ length: N2 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / RATE2) * 0.5);
  const ctx2 = { sampleRate: RATE2, decodeAudioData: async () =>
    ({ length: N2, numberOfChannels: 1, sampleRate: RATE2, duration: N2 / RATE2, getChannelData: () => sine }) };
  const samples2 = new Map([[1000, { name: 'a.ogg', bytes: new Uint8Array([0, 0, 0, 0]), mime: 'audio/ogg' }]]);
  const mixed = await C.mixAndEncode(ctx2, [{ time: 0, sampleId: 1000, volume: 1, pan: 0 }], samples2,
    { sampleRate: RATE2 });
  check(mixed.fmt.id === 'mp3' && mp3Info(mixed.bytes).bitrate === 320, 'mixAndEncode 默认输出 MP3@320');
  const mixedWav = await C.mixAndEncode(ctx2, [{ time: 0, sampleId: 1000, volume: 1, pan: 0 }], samples2,
    { sampleRate: RATE2, format: 'wav' });
  check(String.fromCharCode(mixedWav.bytes[0], mixedWav.bytes[1], mixedWav.bytes[2], mixedWav.bytes[3]) === 'RIFF',
    'mixAndEncode 可切回 WAV');
  check(mixed.musicOffset === 0, '编码路径下 musicOffset 依旧为 0');
  // 非标准采样率要被拦住，而不是静默产出垃圾 MP3
  let rateErr = '';
  try { C.encodeMp3({ left: new Float32Array(100), right: new Float32Array(100), sampleRate: 1000, length: 100 }); }
  catch (e) { rateErr = e.message; }
  check(/采样率/.test(rateErr), '非标准采样率报错而不产垃圾：' + (rateErr || '(没报错!)'));
  // 新的界面控件
  check(['audioFormat', 'mp3Kbps', 'brWrap'].every(id => defined.has(id)), '格式/码率控件（含码率行包裹）都在页面里');
  check(/<select id="audioFormat"/.test(body) && /<select id="mp3Kbps"/.test(body), '两个下拉框在 HTML 里');

  // ---------------- 测试 14：保留键音（不混音）----------------
  console.log('\n=== 测试14: 保留键音模式 ===');
  {
    const fake = new Map([
      [0, { name: 'bgm/main.ogg', bytes: new Uint8Array(9000), mime: 'audio/ogg' }],   // 最大的 BGM → 当音轨
      [1, { name: 'bgm/sub.ogg', bytes: new Uint8Array(500), mime: 'audio/ogg' }],     // 其余 BGM → Sample 事件
      [2, { name: 'keys/kick.wav', bytes: new Uint8Array(300), mime: 'audio/wav' }],   // 键音
      [3, { name: 'keys/kick.wav', bytes: new Uint8Array(200), mime: 'audio/wav' }],   // 同名 → 加 _id
    ]);
    const names = C.buildSampleNames(fake);
    console.log('  文件名：', [...names.entries()].map(([i, n]) => i + '→' + n).join(', '));
    check(names.get(0) === 'bgm_main.ogg', '路径分隔符被换成下划线');
    check(names.get(2) !== names.get(3) && /^keys_kick_2\.wav$/.test(names.get(2)) && /^keys_kick_3\.wav$/.test(names.get(3)),
          '同名样本两个都加 _id（与用到哪些 id 无关 → 三难度名字稳定）');
    check(names.get(1) === 'bgm_sub.ogg', '不冲突的样本保持原名');
    const objs = [
      { time: 100, sampleId: 0, volume: 1, pan: 0, autoplay: true },
      { time: 5000, sampleId: 1, volume: 0.5, pan: 0, autoplay: true },
      { time: 1000, sampleId: 2, volume: 1, pan: 0, autoplay: false },
      { time: 2000, sampleId: 9, volume: 1, pan: 0, autoplay: false },      // 样本不存在
    ];
    const hits = [
      { _column: 0, x: 36, y: 192, time: 1000, type: 1, hitSound: 0, endTime: -2147483648, hitSample: '0:0:0:0:', sampleId: 2, sampleVolume: 0.9375 },
      { _column: 1, x: 109, y: 192, time: 2000, type: 1, hitSound: 0, endTime: -2147483648, hitSample: '0:0:0:0:', sampleId: 9, sampleVolume: 1 },
      { _column: 2, x: 182, y: 192, time: 3000, type: 128, hitSound: 0, endTime: 3500, hitSample: '0:0:0:0:', sampleId: 3, sampleVolume: 1 },
    ];
    const plan = C.planKeysound({ samples: fake, sampleNames: names, audioObjects: objs, hitObjects: hits });
    console.log('  计划：', JSON.stringify(plan.stats), '| 音轨 =', plan.audioName);
    check(plan.audioName === 'bgm_main.ogg', '音轨 = 体积最大的 BGM（原始文件，不重编码）');
    check(plan.sampleEvents.length === 1 && plan.sampleEvents[0].file === 'bgm_sub.ogg'
          && plan.sampleEvents[0].volume === 50 && plan.sampleEvents[0].time === 5000,
          '其余 BGM 变成 Sample 事件（音量 0.5 → 50）');
    check(plan.files.length === 4, '拷进图包的样本 = 键音 ∪ BGM（4 个）');
    const tp = [{ time: 0, beatLength: 500, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 30, uninherited: true, effects: 0 }];
    const mk = (audio, events) => C.buildOsuText({
      header: { fileName: 'o2ma1.ojn' }, chart: { level: 5 },
      meta: { title: 'T', artist: 'A', noter: 'N', od: NaN, hp: 8.2, serverTag: '', diffName: null,
              sampleNames: names, sampleEvents: events },
      timingPoints: JSON.parse(JSON.stringify(tp)), hitObjects: JSON.parse(JSON.stringify(hits)),
      audioFilename: audio, musicOffset: 0, coverName: 'bg.jpg',
    });
    const text = mk(plan.audioName, plan.sampleEvents);
    const ho = section(text, 'HitObjects');
    for (const l of ho) console.log('    ' + l);
    check(ho[0] === '36,192,1000,1,0,0:0:0:94:keys_kick_2.wav', '短音 hitSample = 0:0:0:<音量>:<文件>（与 BmsToOsu 同格式）');
    check(ho[1] === '109,192,2000,1,0,0:0:0:0:', '样本不存在的音符退化为静音（不写文件名）');
    check(ho[2] === '182,192,3000,128,0,3500:0:0:0:100:keys_kick_3.wav', '长音 = <end>:0:0:0:<vol>:<file>');
    check(text.includes('AudioFilename: bgm_main.ogg'), '音轨写进 AudioFilename');
    check(section(text, 'Events').includes('Sample,5000,0,"bgm_sub.ogg",50'), 'Sample 事件格式与 BmsToOsu 一致');
    check(C.validateOsuText(text).length === 0, '保留键音输出通过自检：' + (C.validateOsuText(text)[0] || '无问题'));
    // 没有 BGM 的谱面：不选音轨、不写 AudioFilename
    const plan2 = C.planKeysound({ samples: fake, sampleNames: names, audioObjects: [objs[2]], hitObjects: hits });
    check(plan2.audioName === '' && plan2.sampleEvents.length === 0 && plan2.files.length === 2,
          '没有 BGM 时不选音轨，只拷键音');
    check(!/AudioFilename:/.test(mk('', [])), '没有音轨时不写 AudioFilename 行');
    check(/<option value="keysound">/.test(body), '音频下拉框里有“保留键音”选项');
    // 真实谱面：三个难度共用同一份文件名映射（保证同图内名字一致）
    const realOjm = walk(OJN_ROOT).filter(p => /\.ojm$/i.test(p) && !/o2jam-to-osu/.test(p))[0];
    if (realOjm) {
      const smp = C.parseOjm(fs.readFileSync(realOjm), (b) => new TextDecoder('windows-1252').decode(b));
      const nm = C.buildSampleNames(smp);
      check(nm.size === smp.size && [...nm.values()].every(v => v && !/[,:]/.test(v)),
            '真实 OJM（' + smp.size + ' 个样本）都能生成安全文件名，无逗号/冒号');
      console.log('  真实样本文件名例：', [...nm.entries()].slice(0, 3).map(([i, n]) => i + '→' + n).join(', '));
    }
  }

  // ---------------- 测试 15：声像法则 / 峰值归一化 / WAV 字节级回归 ----------------
  console.log('\n=== 测试15: 声像与归一化 ===');
  {
    const R3 = 44100, N3 = 1000;
    const sine3 = Float32Array.from({ length: N3 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / R3) * 0.5);
    const buf3 = () => ({ length: N3, numberOfChannels: 1, sampleRate: R3, duration: N3 / R3, getChannelData: () => sine3 });
    const ctx3 = { sampleRate: R3, decodeAudioData: async () => buf3() };
    const smp3 = new Map([[1000, { name: 'a.ogg', bytes: new Uint8Array([0, 0, 0, 0]), mime: 'audio/ogg' }]]);
    const mixOne = (objs, options) => C.mixToPcm(ctx3, objs, smp3, R3, options);

    const c0 = await mixOne([{ time: 0, sampleId: 1000, volume: 1, pan: 0 }], { normalize: false });
    check(Math.abs(c0.left[100] - sine3[100]) < 1e-7 && Math.abs(c0.right[100] - sine3[100]) < 1e-7,
          '居中：两声道与源样本完全一致（平衡式声像；旧等功率会是 ×0.707、整体 -3dB）');
    const cL = await mixOne([{ time: 0, sampleId: 1000, volume: 1, pan: -1 }], { normalize: false });
    const cR = await mixOne([{ time: 0, sampleId: 1000, volume: 1, pan: 1 }], { normalize: false });
    check(cL.left[100] === sine3[100] && cL.right[100] === 0, '全左：左声道原样、右声道静音');
    check(cR.right[100] === sine3[100] && cR.left[100] === 0, '全右：右声道原样、左声道静音');
    const cH = await mixOne([{ time: 0, sampleId: 1000, volume: 1, pan: 0.5 }], { normalize: false });
    check(Math.abs(cH.left[100] - sine3[100] * 0.5) < 1e-7 && Math.abs(cH.right[100] - sine3[100]) < 1e-7,
          '右半声像：只衰减左声道（×0.5），右声道不动');
    const cV = await mixOne([{ time: 0, sampleId: 1000, volume: 0.5, pan: 0 }], { normalize: false });
    check(Math.abs(cV.left[100] - sine3[100] * 0.5) < 1e-7, '音量 0.5 → 幅度减半');

    // 归一化：两个同刻同源对象（源峰值 0.5，音量 1+1）→ 峰值 1.0，超过 -1dBFS 阀值 → 压到 0.89
    const cN = await mixOne([{ time: 0, sampleId: 1000, volume: 1, pan: 0 },
                             { time: 0, sampleId: 1000, volume: 1, pan: 0 }]);
    check(Math.abs(cN.peak - 1.0) < 0.01 && cN.gain !== 1, '报告归一化前的原始峰值（' + cN.peak.toFixed(2) + '）并给出增益');
    let after = 0; for (let i = 0; i < cN.length; i++) after = Math.max(after, Math.abs(cN.left[i]), Math.abs(cN.right[i]));
    check(Math.abs(after - 0.89) < 0.01, '归一化后峰值 = -1dBFS（' + after.toFixed(3) + '，无削波余量给有损编码）');
    const cOff = await mixOne([{ time: 0, sampleId: 1000, volume: 1, pan: 0 },
                               { time: 0, sampleId: 1000, volume: 1, pan: 0 }], { normalize: false });
    let afterOff = 0; for (let i = 0; i < cOff.length; i++) afterOff = Math.max(afterOff, Math.abs(cOff.left[i]));
    check(cOff.gain === 1 && Math.abs(afterOff - 1.0) < 0.01, '关归一化时保持原样（峰值 ' + afterOff.toFixed(2) + '）');

    // WAV 字节级回归：与重构前的内联写法逐字节比对（回答“改动是否动了 WAV 混音”）
    const fp = { left: Float32Array.from([0, 0.5, -0.5, 1, -1, 0.3333]),
                 right: Float32Array.from([0, -0.5, 0.5, 1, -1, -0.3333]), sampleRate: 44100, length: 6 };
    const got = Buffer.from(C.encodeWav(fp));
    const exp = Buffer.alloc(44 + 24);
    const dv = new DataView(exp.buffer, exp.byteOffset, exp.byteLength);
    const put = (o, s) => { for (let i = 0; i < s.length; i++) exp[o + i] = s.charCodeAt(i); };
    put(0, 'RIFF'); dv.setUint32(4, 36 + 24, true); put(8, 'WAVE');
    put(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
    dv.setUint32(24, 44100, true); dv.setUint32(28, 44100 * 4, true);
    dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
    put(36, 'data'); dv.setUint32(40, 24, true);
    const clampOld = (v) => { v = v < -1 ? -1 : (v > 1 ? 1 : v); return (v * 32767) | 0; };
    for (let i = 0; i < 6; i++) {
      dv.setInt16(44 + i * 4, clampOld(fp.left[i]), true);
      dv.setInt16(46 + i * 4, clampOld(fp.right[i]), true);
    }
    check(got.equals(exp), 'WAV 写出与重构前逐字节一致（头 + 纹波 + 钳位公式都没变）');

    // ---------------- 响度模式：默认仍是峰值归一化，限制器是显式可选项 ----------------
    /* 背景：密集键音叠加后峰值常到 3~5（+10~+14dBFS）。峰值归一化为了让那一个尖峰不削波会把
       **整首歌**拉低（用 ebur128 实测比原曲母带低 7~10dB，听感“好低”）。
       限制器只压超阈值的瞬间 → 响度基本不变。默认不开，但代码在，就得钉住它的行为。 */
    check(C.resolveLoudness({}) === 'normalize', '默认仍是峰值归一化（与改动前完全一致）');
    check(C.resolveLoudness({ normalize: false }) === 'none', 'normalize:false 仍然等于“不处理”（老开关语义不变）');
    check(C.resolveLoudness({ loudness: 'limit' }) === 'limit', '只有显式 loudness:limit 才用限制器');

    {
      const N = 40000, R = 44100, CEIL = 0.89;

      /* ① 尖峰放在**末尾**：它之前的样本几乎都在前视窗口之外。
         这一条正是限制器与峰值归一化的关键区别 —— 归一化会把整首都乘 0.89/3.0 ≈ 0.297，
         而限制器必须让远处样本原样通过（这才是“响度不再被拉低”的原因）。 */
      const a1 = new Float32Array(N).fill(0.2), b1 = new Float32Array(N).fill(0.2);
      const at = N - 100;
      a1[at] = 3.0; b1[at] = 3.0;
      const src1 = a1.slice();
      const red1 = C.limitPeaks(a1, b1, N, R, CEIL, {});
      check(Math.abs(a1[10] - src1[10]) < 1e-6, '尖峰远处的样本原样通过（' + a1[10].toFixed(4)
        + '；同一信号走峰值归一化会变成 ' + (src1[10] * CEIL / 3).toFixed(4) + '）');
      check(Math.abs(a1[at - 500] - src1[at - 500]) < 1e-6, '前视窗口（约 10ms = 440 个样本）之外的样本也不受影响');
      check(Math.abs(a1[at] - CEIL) < 1e-4, '尖峰被压到刚好等于阈值（' + a1[at].toFixed(4) + '）');
      let peak1 = 0;
      for (let i = 0; i < N; i++) peak1 = Math.max(peak1, Math.abs(a1[i]), Math.abs(b1[i]));
      check(peak1 <= CEIL + 1e-6, '整段输出峰值不超过阈值（' + peak1.toFixed(4) + ' ≤ ' + CEIL + '）');
      check(red1 < 0 && red1 > -20, '报告了压制量（' + red1.toFixed(1) + 'dB）');

      /* ② 尖峰放在开头：验证 ① 前视窗口内会**提前**降增益（不是等爆了才压），
             ② 之后按 release 恢复，而不是永久压暗。 */
      const a2 = new Float32Array(N).fill(0.2), b2 = new Float32Array(N).fill(0.2);
      a2[100] = 3.0; b2[100] = 3.0;
      C.limitPeaks(a2, b2, N, R, CEIL, {});
      check(a2[90] < 0.2 - 1e-6, '尖峰之前的前视窗口内已提前降增益（' + a2[90].toFixed(4) + ' < 0.2）');
      check(a2[N - 1] > 0.2 * 0.99, '尖峰之后按 release 恢复（' + a2[N - 1].toFixed(4) + ' / 0.2，'
        + ((N - 100) / R * 1000).toFixed(0) + 'ms 后 ≈ 原样）');

      /* ③ 全程在阈值内：一个样本都不改 */
      const q = new Float32Array(N).fill(0.5), qr = new Float32Array(N).fill(0.5);
      const qs = q.slice();
      const red3 = C.limitPeaks(q, qr, N, R, CEIL, {});
      let same = true;
      for (let i = 0; i < N; i++) if (q[i] !== qs[i]) same = false;
      check(same && red3 === 0, '整个信号都在阈值内时一个样本都不改（压制量 0dB）');
    }
  }

  // ---------------- 测试 16：音频缺失/截断/内存加固 ----------------
  console.log('\n=== 测试16: 补静音 / 静音退路 / 解码缓存 / 分块打包 / 编码检测收紧 ===');
  {
    const R4 = 44100, N4 = 100;
    const sine4 = Float32Array.from({ length: N4 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / R4) * 0.5);
    let decodeCalls = 0;
    const ctx4 = { sampleRate: R4, decodeAudioData: async () => {
      decodeCalls++;
      return { length: N4, numberOfChannels: 1, sampleRate: R4, duration: N4 / R4, getChannelData: () => sine4 };
    } };
    const smp4 = new Map([[1000, { name: 'a.ogg', bytes: new Uint8Array(4), mime: 'audio/ogg' }]]);
    const objs4 = [{ time: 0, sampleId: 1000, volume: 1, pan: 0 }];

    const p1 = await C.mixToPcm(ctx4, objs4, smp4, R4, { normalize: false, minDurationMs: 5000 });
    check(p1.length === Math.round(5 * R4) && p1.padded === true,
          '样本只有 0.1s：已补静音到谱面长度（' + (p1.length / R4).toFixed(2) + 's）而不是提前结束');
    const p1b = await C.mixToPcm(ctx4, objs4, smp4, R4, { normalize: false });
    check(p1b.padded === false && p1b.length < R4, '不给 minDurationMs 时不补（保持原样 ' + (p1b.length / R4).toFixed(2) + 's）');

    const p2 = await C.mixToPcm(ctx4, [], smp4, R4, { minDurationMs: 3000 });
    check(p2.silent === true && p2.length === 3 * R4 && p2.usedSamples === 0,
          '一个可解样本都没有 → 生成静音音轨（3s），不再丢音频');
    let threw = false;
    try { await C.mixToPcm(ctx4, [], smp4, R4, {}); } catch (e) { threw = true; }
    check(threw, '无样本且不给时长时仍然报错（保留旧语义）');
    const sil = C.silentPcm(R4, 1000);
    check(sil.silent === true && sil.left.length === 1000 && sil.left[500] === 0, 'silentPcm 产出全零 PCM');

    decodeCalls = 0;
    const cache = new Map();
    await C.mixToPcm(ctx4, objs4, smp4, R4, { decodeCache: cache });
    await C.mixToPcm(ctx4, objs4, smp4, R4, { decodeCache: cache });
    check(decodeCalls === 1, '同一个 decodeCache 下样本只解码 1 次（三难度共用；实际 ' + decodeCalls + ' 次）');

    const zf = [{ name: 'a.txt', data: new TextEncoder().encode('aaa') },
                { name: 'b/c.osu', data: new TextEncoder().encode('osu file format v14\n') }];
    const when = new Date(2026, 8, 20, 1, 2, 3);
    const joined = Buffer.concat(C.makeZipChunks(zf, when).map(c => Buffer.from(c)));
    const whole = Buffer.from(C.makeZip(zf, when));
    check(joined.equals(whole), 'makeZipChunks 拼接后与 makeZip 逐字节一致（' + whole.length + ' 字节，Blob 直接吃分块）');

    const single = C.detectEncoding([Uint8Array.from([0xD6, 0xF1, 0xC8, 0xA1, 0xEF, 0x77, 0xCF, 0xE8])]);
    check(single.encoding === 'gb18030', '单条 GBK 文本不再被判成 windows-1252（' + single.encoding + '）');
  }

  // ---------------- 测试 17：不变量 —— 每个 .osu 引用的音频必须真的产出（回归：曾出现“osz 里没音频”）----------------
  console.log('\n=== 测试17: 音频引用不变量（含无 OJM 情形）===');
  {
    // 用一个真实 .ojn 当输入；samples 可为空，模拟 OJM 缺失/解析失败
    const ojnFile = findOjnFiles(1)[0];
    const ojnBuf = fs.readFileSync(ojnFile);
    const hdr = C.parseOjnHeader(ojnBuf);
    const dec = C.makeTextDecoder(C.detectEncoding([hdr.rawTitle, hdr.rawArtist, hdr.rawNoter]).encoding);
    const R5 = 44100, N5 = 2000;
    const s5 = Float32Array.from({ length: N5 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / R5) * 0.4);
    const ctx5 = { sampleRate: R5, decodeAudioData: async () =>
      ({ length: N5, numberOfChannels: 1, sampleRate: R5, duration: N5 / R5, getChannelData: () => s5 }) };
    const withSamples = new Map([[1000, { name: 'a.ogg', bytes: new Uint8Array(new Int32Array([1000]).buffer), mime: 'audio/ogg' }],
                                 [1001, { name: 'b.ogg', bytes: new Uint8Array(new Int32Array([1001]).buffer), mime: 'audio/ogg' }]]);

    const runMode = async (mode, fmt, samples, label) => {
      const song = {
        ojnFile: { name: path.basename(ojnFile),
                   arrayBuffer: async () => ojnBuf.buffer.slice(ojnBuf.byteOffset, ojnBuf.byteOffset + ojnBuf.length) },
        ojmFile: samples.size ? { name: 'x.ojm' } : (label.includes('无 OJM') ? null : { name: 'x.ojm' }),
        decode: dec, samples,
      };
      const res = await C.convertOneSong(song, {
        diffs: [2], od: NaN, hp: 8.2, serverTag: '', useSV: false, autoRepair: true, lnMaxBeats: 0,
        audioMode: mode, audioFormat: fmt, mp3Kbps: 320, sampleRate: R5, normalize: true,
        suffixMode: 'auto', tagMode: 'keep', tagTemplate: '',
      }, ctx5, null);
      const names = new Set(res.files.map(f => f.name));
      const problems = [];
      for (const f of res.files.filter(x => /\.osu$/i.test(x.name))) {
        const m = /^AudioFilename: (.+)$/m.exec(new TextDecoder().decode(f.data));
        const want = m ? m[1].trim() : '';
        if (want && !names.has(want)) problems.push(f.name + ' → ' + want);
        if (!want && mode !== 'keysound' && mode !== 'none') problems.push(f.name + ' → 没有 AudioFilename');
      }
      const audioCount = res.files.filter(f => /\.(wav|mp3|ogg)$/i.test(f.name)).length;
      check(problems.length === 0,
        label + '：' + res.files.length + ' 个文件（音频 ' + audioCount + ' 个）—— 音频引用全部存在'
        + (problems.length ? '，问题：' + problems.join('; ') : ''));
      return res;
    };

    await runMode('per-diff', 'wav', withSamples, '每难度混音·WAV·有样本');
    await runMode('shared', 'wav', withSamples, '共享混音·WAV·有样本');
    await runMode('per-diff', 'mp3', withSamples, '每难度混音·MP3·有样本');
    await runMode('keysound', 'wav', withSamples, '保留键音·有样本');
    // OJM 缺失/解析失败 —— 以前这里会“没有音频”
    const noOjm = await runMode('per-diff', 'wav', new Map(), '每难度混音·无 OJM');
    check(noOjm.warnings.some(w => /没有可用样本|静音/.test(w)), '无 OJM 时给出明确警告：' + (noOjm.warnings[0] || '(无)'));
    const noOjmShared = await runMode('shared', 'wav', new Map(), '共享混音·无 OJM');
    check(noOjmShared.files.some(f => /\.wav$/i.test(f.name)), '无 OJM + 共享模式也会产出音频文件（静音）');
    check(noOjmShared.warnings.length > 0, '无 OJM + 共享模式有警告（' + noOjmShared.warnings.length + ' 条）');
    await runMode('keysound', 'wav', new Map(), '保留键音·无 OJM');
  }

  // ---------------- 测试 18：样本 id 兜底（±1000 音色库偏移 / 单主音频）----------------
  console.log('\n=== 测试18: 样本 id 兜底 ===');
  {
    const mkSamples = (pairs) => new Map(pairs.map(([id, bytes, name]) =>
      [id, { name: name || ('s' + id + '.ogg'), mime: 'audio/ogg', bytes: new Uint8Array(bytes) }]));
    // 情形 1：OJM 里 BGM 是 OGG（id 0），谱面写的是 WAV 库编号（1000）
    const only0 = mkSamples([[0, 9000, 'FIRE (full version).ogg']]);
    const idx0 = C.buildSampleIndex(only0);
    check(C.resolveSampleId(1000, idx0) === 0, '±1000 兜底：谱面写 1000 → 命中 OJM 里的 0');
    check(C.resolveSampleId(0, idx0) === 0, '精确 id 优先（0 → 0）');
    const idxSwap = C.buildSampleIndex(mkSamples([[1000, 9000]]));
    check(C.resolveSampleId(0, idxSwap) === 1000, '反向也成立：谱面写 0 → 命中 OJM 里的 1000');
    const idxBoth = C.buildSampleIndex(mkSamples([[0, 100], [1000, 200]]));
    check(C.resolveSampleId(0, idxBoth) === 0 && C.resolveSampleId(1000, idxBoth) === 1000,
      '两个区都有样本时不建别名（各自精确命中）');

    // 用真实样本 OJM 验一边：o2ma3510（只有一条 249s 主音频，id=0）
    const dir = path.join(OJN_ROOT, 'OfficialBeatmaps');
    const p3510 = path.join(dir, 'o2ma3510.ojm');
    if (fs.existsSync(p3510)) {
      const raw = fs.readFileSync(p3510);
      const h3510 = C.parseOjnHeader(fs.readFileSync(path.join(dir, 'o2ma3510.ojn')));
      const smp = C.parseOjm(raw, (b) => new TextDecoder('windows-1252').decode(b));
      const idx = C.buildSampleIndex(smp);
      const u8b = new Uint8Array(fs.readFileSync(path.join(dir, 'o2ma3510.ojn')));
      // HX = 第 3 个难度
      const evs = C.parseOjnEvents(u8b, h3510.noteOffsets[2], h3510.coverOffset);
      const built = C.buildChart(h3510.bpm, evs, false);
      const before = built.audioObjects.filter(o => smp.has(o.sampleId)).length;
      const fb = C.planSampleFallback({ index: idx, audioObjects: built.audioObjects, needMs: 250000,
                                        mainDurationMs: 249000 });
      const n = C.applySampleFallback(built.audioObjects, fb, idx);
      const after = built.audioObjects.filter(o => smp.has(o.sampleId)).length;
      console.log('  o2ma3510 HX：兜底前可播 ' + before + ' / ' + built.audioObjects.length
        + '，兜底后 ' + after + '（BGM ' + n.bgm + ' / 键音 ' + n.keys + '）');
      check(before === 7 && after === before + 1, '真实曲 o2ma3510 HX：±1000 别名把 BGM（id 1000→0）救回来，可播对象 ' + before + ' → ' + after);
      check(after / built.audioObjects.length > 0.9 || fb.stats.aliasHits > 0,
        '至少通过 ±1000 别名命中 BGM');
    }

    // 情形 2：单主音频（谱面 BGM 引用不存在的 id，OJM 只有一条长样本）
    const one = mkSamples([[1000, 500000, 'main.ogg']]);
    const idx1 = C.buildSampleIndex(one);
    const objs = [{ time: 0, sampleId: 1, autoplay: true }, { time: 1000, sampleId: 1, autoplay: true }];
    const fb1 = C.planSampleFallback({ index: idx1, audioObjects: objs, needMs: 200000, mainDurationMs: 199000 });
    check(fb1.stats.mainAudio === 1 && fb1.map.get(1) === 1000, '单主音频兜底：BGM 缺失 id 1 → 指向唯一主音频 1000');
    const n1 = C.applySampleFallback(objs, fb1, idx1);
    check(n1.bgm === 2 && objs.every(o => o.sampleId === 1000), '应用后 BGM 对象都指向主音频');
    // ★ 关键：键音不能跟着指向整首歌（否则同时播几百遍 → 噪音）
    const mixed = [{ time: 0, sampleId: 1, autoplay: true },
                   ...Array.from({ length: 50 }, (_, i) => ({ time: 200 + i * 100, sampleId: 1, autoplay: false }))];
    const n2 = C.applySampleFallback(mixed, fb1, idx1);
    check(n2.bgm === 1 && n2.keys === 0 && mixed.filter(o => !o.autoplay).every(o => o.sampleId === 1),
      '单主音频兜底只作用于 BGM（' + n2.bgm + ' 个），50 个键音保持不动');
    const hits = Array.from({ length: 50 }, () => ({ sampleId: 1 }));
    check(C.applySampleFallbackToHitObjects(hits, fb1, idx1) === 0 && hits.every(h => h.sampleId === 1),
      '音符（hitSample）绝不套用单主音频映射');
    // 样本很多且缺失 id 很多时不能乱映射（o2ma1228 那种残缺 OJM）
    const many = mkSamples(Array.from({ length: 12 }, (_, i) => [i, 100 + i]));
    const idx2 = C.buildSampleIndex(many);
    const objs2 = Array.from({ length: 20 }, (_, i) => ({ time: i * 100, sampleId: 500 + i, autoplay: true }));
    const fb2 = C.planSampleFallback({ index: idx2, audioObjects: objs2, needMs: 200000 });
    check(fb2.stats.mainAudio === 0 && fb2.map.size === 0,
      'BGM 大面积缺失时不乱映射（' + fb2.bgmMissing.length + ' 个缺失 id → 不做单主音频兜底）');
    // 主音频太短也不能当整首音乐（传真实时长 200ms vs 谱面 200s）
    const shortMain = C.buildSampleIndex(mkSamples([[7, 5000]]));
    const fb3 = C.planSampleFallback({ index: shortMain, audioObjects: [{ time: 0, sampleId: 3, autoplay: true }],
                                       needMs: 200000, mainDurationMs: 200 });
    check(fb3.stats.mainAudio === 0, '主音频只有 200ms 而谱面 200s → 不当整首音乐');
    const fb3b = C.planSampleFallback({ index: shortMain, audioObjects: [{ time: 0, sampleId: 3, autoplay: true }],
                                       needMs: 200000, mainDurationMs: 190000 });
    check(fb3b.stats.mainAudio === 1, '同一条件下若主音频确实够长（190s） → 才应用');
    // 开/关开关
    const song = {
      ojnFile: { name: 'x.ojn', arrayBuffer: async () => fs.readFileSync(path.join(dir, 'o2ma3510.ojn')).buffer },
      ojmFile: { name: 'x.ojm' }, decode: (b) => new TextDecoder('windows-1252').decode(b),
      samples: C.parseOjm(fs.readFileSync(p3510), (b) => new TextDecoder('windows-1252').decode(b)),
    };
    const baseOpts = { diffs: [2], od: NaN, hp: 8.2, serverTag: '', useSV: false, autoRepair: true, lnMaxBeats: 0,
      audioMode: 'per-diff', audioFormat: 'wav', mp3Kbps: 320, sampleRate: 8000, normalize: true,
      suffixMode: 'none', tagMode: 'keep', tagTemplate: '' };
    const on = await C.convertOneSong(song, Object.assign({}, baseOpts, { sampleFallback: true }), null, null);
    const off = await C.convertOneSong(song, Object.assign({}, baseOpts, { sampleFallback: false }), null, null);
    const wavOn = on.files.find(f => /\.wav$/i.test(f.name));
    const wavOff = off.files.find(f => /\.wav$/i.test(f.name));
    // 注：Node 里没有 Web Audio，真实 Ogg 样本解不了 → 两边的音频都是静音，不能比内容。
    // 这里只验证“开关接得上、都能产出音频”，remap 逻辑本身已在上面的单元断言里验过。
    check(!!wavOn && !!wavOff, '开关都接得上：两种设置都能产出音频文件');
    check(wavOn.data.length === wavOff.data.length,
      '两边音频都补到谱面长度（' + (wavOn.data.length / 1048576).toFixed(1) + 'MB）');
  }

  // ---------------- 测试 19：PCM 钳位（回归：Int16Array 环绕导致 MP3 严重杂音）----------------
  console.log('\n=== 测试19: 浮点→int16 必须钳位（不能环绕）===');
  {
    const inp = Float32Array.from([0, 0.5, 1, 1.5, 2, 2.8, -0.5, -1, -1.5, -2, -2.8, 0.999]);
    const got = [...C.floatToInt16(inp)];
    const want = [0, 16383, 32767, 32767, 32767, 32767, -16383, -32767, -32767, -32767, -32767, 32734];
    console.log('  输入 ' + [...inp].map(v => v.toFixed(2)).join(', '));
    console.log('  输出 ' + got.join(', '));
    check(JSON.stringify(got) === JSON.stringify(want), '过载样值全部饱和到 ±满幅（不环绕）');
    // 环绕会变成符号翻转 —— 这是以前 MP3 杂音的根因
    check(got[4] === 32767 && got[10] === -32767, '+2.0 → 32767（不是 -2），-2.8 → -32767（不是 +1）');
    check([...C.floatToInt16(Float32Array.from([1.0, -1.0]))].join(',') === '32767,-32767', '±1.0 边界正确');
    const co = C.countOutOfRange(inp);
    check(Math.abs(co.peak - 2.8) < 1e-5 && co.over === 6, 'countOutOfRange 统计正确（峰值 ' + co.peak.toFixed(2) + '，超限 ' + co.over + ' 个）');
    // mp3/wav 两条路径共用同一个转换 → 等价性检查
    const tiny = { left: Float32Array.from([0, 2, -2]), right: Float32Array.from([0, 2, -2]),
                   sampleRate: 44100, length: 3 };
    const w = C.encodeWav(tiny);
    const dv = new DataView(w.buffer);
    const wv = [0, 1, 2].map(i => dv.getInt16(44 + i * 4, true));
    check(wv.join(',') === '0,32767,-32767', 'WAV 写出也是饱和而非环绕（' + wv.join(',') + '）');
    const m = C.encodeMp3(tiny, { bitrate: 320 });
    check(m.length > 0 && m[0] === 0xFF && (m[1] & 0xE0) === 0xE0, '过载信号也能编出合法 MP3 帧');
  }

  // ---------------- 测试 20：MP3 异步分片编码（回归：整段同步编码把页面卡死）----------------
  console.log('\n=== 测试20: MP3 分片编码不阻塞主线程 ===');
  {
    const SEC = 12;                                     // 12 秒音频，足够看出分片行为
    const N = 44100 * SEC;
    const pcmL = new Float32Array(N), pcmR = new Float32Array(N);
    for (let i = 0; i < N; i++) { const v = 0.6 * Math.sin(2 * Math.PI * 220 * i / 44100); pcmL[i] = v; pcmR[i] = v; }
    const pcm = { left: pcmL, right: pcmR, sampleRate: 44100, length: N };

    const t0 = performance.now();
    const sync = C.encodeMp3(pcm, { bitrate: 320 });
    const tSync = performance.now() - t0;
    const fracs = [];
    const stats = {};
    const t1 = performance.now();
    const asyn = await C.encodeMp3Async(pcm, { bitrate: 320, onProgress: (f) => fracs.push(f),
                                                onStats: (s) => Object.assign(stats, s),
                                                yieldFn: () => new Promise(r => setImmediate(r)) });
    const tAsync = performance.now() - t1;
    console.log('  ' + SEC + ' 秒音频：同步 ' + tSync.toFixed(0) + 'ms（约 ' + (SEC * 1000 / tSync).toFixed(0)
      + '× 实时），异步 ' + tAsync.toFixed(0) + 'ms；分片 ' + stats.slices + ' 次，让出 ' + stats.yields
      + ' 次，最大单片 ' + stats.maxSliceMs.toFixed(1) + 'ms');
    check(Buffer.from(asyn).equals(Buffer.from(sync)), '异步与同步输出逐字节一致（' + asyn.length + ' 字节）');
    check(stats.maxSliceMs < 200, '单片最长 ' + stats.maxSliceMs.toFixed(0) + 'ms（不会长到让页面卡死）');
    check(stats.yields >= 10, '让出主线程 ' + stats.yields + ' 次（页面有机会绘制/响应）');
    check(fracs.length >= 5 && fracs[fracs.length - 1] === 1, '进度回报 ' + fracs.length + ' 次，最后到 1');
    check(fracs.every((f, i) => i === 0 || f >= fracs[i - 1]), '进度单调递增');
    // 复用 scratch 缓冲不得改变输出
    const a = C.encodeMp3({ left: pcmL.subarray(0, 5000), right: pcmR.subarray(0, 5000), sampleRate: 44100, length: 5000 });
    const b = C.encodeMp3({ left: pcmL.subarray(0, 5000), right: pcmR.subarray(0, 5000), sampleRate: 44100, length: 5000 });
    check(Buffer.from(a).equals(Buffer.from(b)), '同一输入两次编码结果相同（scratch 复用无副作用）');
    const st = C.floatToInt16(Float32Array.from([2, -2, 0.5]), 0, 3, new Int16Array(3));
    check(st[0] === 32767 && st[1] === -32767, 'floatToInt16 支持传入输出缓冲，结果与分配版一致');
  }

  /* ==================================================================
     测试21: 编码后端可插拔（命令行用 ffmpeg 换掉 lamejs，浏览器不受影响）
     ================================================================== */
  {
    console.log('\n=== 测试21: 编码后端注册表 ===');
    check(C.encoderBackend('mp3') === null && C.encoderBackend('wav') === null,
      '默认没有任何注册后端（浏览器照旧走 lamejs / 纯 JS WAV）');
    const ogg = C.formatById('ogg');
    check(ogg.id === 'ogg' && ogg.ext === '.ogg' && ogg.nodeOnly === true,
      'ogg 格式存在且标了 nodeOnly（界面下拉框会把它滤掉）');
    const domFormats = C.AUDIO_FORMATS.filter(f => !f.nodeOnly).map(f => f.id);
    check(domFormats.join(',') === 'mp3,wav', '界面能选的格式仍是 mp3,wav：' + domFormats.join(','));

    // 注册一个假后端，确认 encodeAudioAsync 改走它、且进度被收尾到 1
    let called = 0, seenProgress = null;
    C.registerEncoder('mp3', async (pcm, { bitrate }) => { called++; return new Uint8Array([bitrate & 255, 1, 2, 3]); });
    check(C.encoderBackend('mp3') !== null, '注册后能查到 mp3 后端');
    const pcm2 = { left: new Float32Array(1000), right: new Float32Array(1000), sampleRate: 44100, length: 1000 };
    const r = await C.encodeAudioAsync(pcm2, 'mp3', 320, { onProgress: (f) => { seenProgress = f; } });
    check(called === 1 && r.bytes.length === 4 && r.bytes[0] === 64, '注册的后端被调用且返回值被采用');
    check(seenProgress === 1, '后端路径也会把进度收到 1（进度条不会停在 99%）');
    check(r.fmt.id === 'mp3' && r.fmt.ext === '.mp3', '返回的 fmt 元数据仍然是 mp3');

    // wav 没注册 → 继续走纯 JS 编码器（与浏览器完全一致）
    const wavBytes = (await C.encodeAudioAsync(pcm2, 'wav', 0)).bytes;
    check(wavBytes.length === 44 + 1000 * 4 && String.fromCharCode(...wavBytes.slice(0, 4)) === 'RIFF',
      '未注册的 wav 仍走纯 JS 编码器（44 字节头 + 1000 帧立体声 16bit）');

    C.clearEncoders();
    check(C.encoderBackend('mp3') === null, 'clearEncoders 后回到默认后端');
  }

  /* ==================================================================
     测试22: 混音器的批量解码钩子（ffmpeg 一次解一批样本）
     ================================================================== */
  {
    console.log('\n=== 测试22: 批量解码钩子 ===');
    const R = 44100;
    const samples = new Map();
    const objects = [];
    for (let i = 1; i <= 5; i++) {
      // 每个样本 1 帧单调递增的常量，便于断言混音结果
      const s = Float32Array.from([i / 100]);
      samples.set(i, { name: i + '.ogg', bytes: new Uint8Array([i, i, i, i]), mime: 'audio/ogg' });
      objects.push({ sampleId: i, time: i * 100, volume: 1, pan: 0 });
    }
    let batchCalls = 0, singleCalls = 0, askedIds = null;
    const fakeBuf = (v) => ({ length: 1, numberOfChannels: 1, sampleRate: R, duration: 1 / R,
                              getChannelData: () => Float32Array.from([v]) });
    const ctx = {
      sampleRate: R,
      async decodeBatch(items) {
        batchCalls++;
        askedIds = items.map(it => it.id).sort();
        const m = new Map();
        for (const it of items) m.set(it.id, fakeBuf(it.id / 100));
        return m;
      },
      async decodeAudioData() { singleCalls++; return fakeBuf(0); },
    };
    const pcm = await C.mixToPcm(ctx, objects, samples, R, { normalize: false, minDurationMs: 700 });
    check(batchCalls === 1 && singleCalls === 0, '有 decodeBatch 时只调 1 次批量、不逐个解码');
    check(askedIds && askedIds.join(',') === '1,2,3,4,5', '一次把 5 个样本 id 全交给批量（' + (askedIds || []).join(',') + '）');
    check(pcm.usedSamples === 5 && pcm.length === Math.round(0.7 * R), '混音用上全部 5 个样本、并补到指定时长');
    // 检查第 i 帧处确实是第 i 个样本的贡献（时间 i*100ms → 帧 i*4410）
    let ok = true;
    for (let i = 1; i <= 5; i++) if (Math.abs(pcm.left[i * 4410] - i / 100) > 1e-6) ok = false;
    check(ok, '批量解出来的内容被正确摆放到 i×100ms 的位置');

    // 批量失败要退化成“静音”而不是崩掉（与 decodeAudioData 失败同语义）
    const badCtx = { sampleRate: R, async decodeBatch() { throw new Error('ffmpeg 炸了'); },
                     async decodeAudioData() { throw new Error('也炸了'); } };
    let threw = false;
    try { await C.mixToPcm(badCtx, objects, samples, R, { minDurationMs: 100 }); } catch (e) { threw = true; }
    check(threw, '批量解码整体失败时按“所有样本解码失败”处理（抛错交给上层退路链，不静默出坏音频）');

    // 没有 decodeBatch 时必须回到逐个 decodeAudioData（浏览器路径）
    const plainCtx = { sampleRate: R, async decodeAudioData() { singleCalls++; return fakeBuf(1); } };
    singleCalls = 0;
    await C.mixToPcm(plainCtx, objects.slice(0, 2), samples, R, { minDurationMs: 100 });
    check(singleCalls === 2, '没有 decodeBatch 时逐个解码 2 次（浏览器行为不变）');
  }

  /* ==================================================================
     测试23: 日志接收器（命令行靠它把每首的日志归到该首名下）
     ================================================================== */
  {
    console.log('\n=== 测试23: 日志接收器 ===');
    const got = [];
    C.setLogSink((msg, cls) => got.push([cls, msg]));
    C.log('hello', 'w');
    C.log('world');
    C.setLogSink(null);
    C.log('不应该是接收器收到（已摘掉）');
    check(got.length === 2 && got[0][0] === 'w' && got[0][1] === 'hello' && got[1][1] === 'world',
      'setLogSink 安装后只走接收器，并带上级别');
    check(got.length === 2, 'setLogSink(null) 后不再接收（浏览器/直跑不受影响）');
  }

  /* ==================================================================
     测试24: 命令行（tools/cli.js）—— 参数解析 + ffmpeg 后端
     需要系统 ffmpeg；没有就跳过（不算失败）
     ================================================================== */
  {
    console.log('\n=== 测试24: 命令行 + ffmpeg 后端 ===');
    let CLI = null, FF = null, ojnForOjm = null;
    try { CLI = await import('./cli.js'); } catch (e) { console.log('  （cli.js 导入失败：' + e.message + '）'); }
    if (!CLI) check(false, 'cli.js 能被 import（且不自动执行转换）');
    else {
      check(typeof CLI.parseArgs === 'function' && typeof CLI.findOjm === 'function', 'cli.js 导出了可测的纯函数');
      const a = CLI.parseArgs(['--in', 'D:/x', '--diffs', 'ex,nx', '--audio', 'per-diff', '--kbps', '128', '--jobs', '3']);
      check(a.in === 'D:/x' && a.diffs === 'ex,nx' && a.audio === 'per-diff' && a.kbps === 128 && a.jobs === 3,
        '基本参数解析正确');
      check(CLI.parseArgs(['--in', 'x']).diffs === 'all' && CLI.parseArgs(['--in', 'x']).audio === 'shared',
        '默认 diffs=all、audio=shared');
      check(CLI.parseArgs(['--in', 'x', '--no-repair']).repair === false
        && CLI.parseArgs(['--in', 'x', '--no-normalize']).normalize === false, '--no-xxx 反向开关生效');
      check(CLI.parseArgs(['--in', 'x', '-h']).help === true, '-h 是 help 的别名');
      let bad = null;
      try { CLI.parseArgs(['--in', 'x', '--diffs', 'ez']); } catch (e) { bad = e.message; }
      check(!!bad && /diffs/.test(bad), '非法难度值会报错：' + bad);
      let bad2 = null;
      try { CLI.parseArgs(['--in', 'x', '--kbps']); } catch (e) { bad2 = e.message; }
      check(!!bad2, '缺值的参数会报错：' + bad2);

      const ojnForTest = findOjnFiles(200).find(p => fs.existsSync(p.replace(/\.ojn$/i, '.ojm')));
      ojnForOjm = ojnForTest;
      if (ojnForTest) {
        const hit = CLI.findOjm(ojnForTest);
        check(!!hit && /\.ojm$/i.test(hit) && path.basename(hit).replace(/\.ojm$/i, '').toLowerCase()
          === path.basename(ojnForTest).replace(/\.ojn$/i, '').toLowerCase(), 'findOjm 找到同名 .ojm');
        check(CLI.findOjm(path.join(path.dirname(ojnForTest), '不存在的谱.ojn')) === null, '找不到 .ojm 时返回 null（不猜）');
      } else console.log('  （没找到带 .ojm 的谱面，跳过 findOjm 检查）');
    }

    let MOD = null;
    try { MOD = await import('./lib/ffmpeg.js'); } catch (e) { console.log('  （lib/ffmpeg.js 导入失败：' + e.message + '）'); }
    if (MOD) {
      // sniffExt 是纯函数，不需要 ffmpeg
      const bytesOf = (...b) => new Uint8Array([...b, ...new Array(8).fill(0)]);
      check(MOD.sniffExt(bytesOf(0x4F, 0x67, 0x67, 0x53), 'audio/ogg') === 'ogg', 'sniffExt 认 OggS');
      check(MOD.sniffExt(bytesOf(0x52, 0x49, 0x46, 0x46), 'audio/ogg') === 'wav', 'sniffExt 按内容认 RIFF（压过声称的 mime）');
      check(MOD.sniffExt(bytesOf(0xFF, 0xFB), 'audio/wav') === 'mp3', '.wav 其实装的是 MP3 也能认出来');
      check(MOD.sniffExt(bytesOf(0x49, 0x44, 0x33), 'audio/wav') === 'mp3', 'sniffExt 认 ID3 头');

      try { FF = await MOD.findFfmpeg(process.env.FFMPEG); }
      catch (e) { console.log('  （跳过 ffmpeg 相关检查：' + e.message.split('\n')[0] + '）'); }
    }

    if (FF) {
      console.log('  ffmpeg: ' + FF.version.replace(/^ffmpeg version /, '').slice(0, 40));
      check(await MOD.hasEncoder(FF.bin, 'libmp3lame'), 'ffmpeg 带 libmp3lame（MP3 真正提速的来源）');

      // —— MP3 往返：相关系数必须 ~1。这一条专门盯“交给 stdin 的缓冲被复用覆写”那类静默损坏
      const R = 44100, N = R * 6;
      const lo = new Float32Array(N), ro = new Float32Array(N);
      for (let i = 0; i < N; i++) { lo[i] = Math.sin(2 * Math.PI * 440 * i / R) * 0.4; ro[i] = Math.sin(2 * Math.PI * 620 * i / R) * 0.3; }
      const mp3 = await MOD.encodePcmFfmpeg({ left: lo, right: ro, length: N, sampleRate: R }, { format: 'mp3', bitrate: 320, ffmpeg: FF.bin });
      check(mp3.length > 10000 && (mp3[0] === 0xFF || String.fromCharCode(...mp3.slice(0, 3)) === 'ID3'),
        'ffmpeg 编出的 MP3 有合法帧头/ID3（' + mp3.length + ' 字节）');
      const tmpMp3 = path.join(process.env.TEMP || '.', 'test24-' + process.pid + '.mp3');
      const tmpRaw = tmpMp3 + '.raw';
      fs.writeFileSync(tmpMp3, mp3);
      await new Promise((res, rej) => execFile(FF.bin, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-i', tmpMp3, '-f', 'f32le', '-ac', '2', '-ar', String(R), tmpRaw], (e) => (e ? rej(e) : res())));
      const raw = fs.readFileSync(tmpRaw);
      const back = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
      const n = Math.floor(back.length / 2);
      let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0;
      for (let i = 0; i < n; i++) {
        const x = lo[i], y = back[i * 2];
        sa += x; sb += y; sab += x * y; saa += x * x; sbb += y * y;
      }
      const corr = (n * sab - sa * sb) / Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
      fs.unlinkSync(tmpMp3); fs.unlinkSync(tmpRaw);
      check(corr > 0.99, 'MP3 编解码往返相关系数 ' + corr.toFixed(5) + '（缓冲复用没污染音频）');

      // —— 用 ffmpeg 解码上下文跑整首：.osu 必须与“逐个解码”路径逐字节一致
      if (ojnForOjm) {
        const ojmP = ojnForOjm.replace(/\.ojn$/i, '.ojm');
        const ojnBuf = fs.readFileSync(ojnForOjm);
        const h = C.parseOjnHeader(ojnBuf);
        const dc = C.makeTextDecoder(C.detectEncoding([h.rawTitle, h.rawArtist, h.rawNoter]).encoding);
        const smp = C.parseOjm(fs.readFileSync(ojmP), dc);
        const mk = () => ({ ojnFile: { name: path.basename(ojnForOjm),
                                       arrayBuffer: async () => ojnBuf.buffer.slice(ojnBuf.byteOffset, ojnBuf.byteOffset + ojnBuf.length) },
                            ojmFile: { name: 'x.ojm' }, decode: dc, samples: smp });
        const o = { diffs: [2], od: NaN, hp: 8.2, serverTag: '', useSV: false, audioMode: 'shared',
                    audioFormat: 'wav', mp3Kbps: 320, normalize: true, sampleRate: 44100, suffixMode: 'auto',
                    tagMode: 'keep', tagTemplate: '', autoRepair: true, sampleFallback: true, lnMaxBeats: 0 };
        const c1 = await MOD.createFfmpegAudioContext({ sampleRate: 44100, ffmpeg: FF.bin, cacheMb: 0 });
        const c2 = await MOD.createFfmpegAudioContext({ sampleRate: 44100, ffmpeg: FF.bin, cacheMb: 0 });
        delete c2.decodeBatch;                                 // 强制走逐个 decodeAudioData
        const r1 = await C.convertOneSong(mk(), o, c1, null);
        const r2 = await C.convertOneSong(mk(), o, c2, null);
        const st1 = c1.stats(), st2 = c2.stats();
        c1.dispose(); c2.dispose();
        const textOf = (r) => r.files.filter(f => /\.osu$/.test(f.name)).map(f => new TextDecoder().decode(f.data)).join('');
        check(textOf(r1) === textOf(r2) && textOf(r1).length > 1000, '同一首歌：批量解码与逐个解码产出的 .osu 完全一致');
        const w1 = r1.files.find(f => /\.wav$/.test(f.name)), w2 = r2.files.find(f => /\.wav$/.test(f.name));
        check(!!w1 && !!w2 && Buffer.from(w1.data).equals(Buffer.from(w2.data)),
          '两种解码路径的混音 PCM 逐字节一致（' + (w1 ? w1.data.length.toLocaleString() + ' 字节' : '无音频') + '）');
        check(st1.decoded > 0 && st2.singleDecodes > 0,
          '两条路径都真的解码了样本（批量 ' + st1.decoded + ' 个 / 逐个 ' + st2.singleDecodes + ' 次）');
        check(smp.size === st1.decoded, '整首的样本都在一次批量调用里解完（' + st1.decoded + ' 个，实际 OJM ' + smp.size + ' 个）');
      }

      // —— 样本缓存：跨曲目复用同一个内容只解一次
      const cacheCtx = await MOD.createFfmpegAudioContext({ sampleRate: 44100, ffmpeg: FF.bin, cacheMb: 8 });
      /* 只取小样本：缓存对“超过容量 1/4 的大家伙”本来就不留存（避免一条 74MB 的主音频占满），
         挑大样本会让这条断言测到的是容量策略而不是缓存复用。 */
      const one = [...C.parseOjm(fs.readFileSync(ojnForOjm.replace(/\.ojn$/i, '.ojm')),
        C.makeTextDecoder('gb18030')).entries()].filter(([, s]) => s.bytes.length > 44 && s.bytes.length < 100000).slice(0, 3);
      if (one.length === 3) {
        await cacheCtx.decodeBatch(one.map(([id, s]) => ({ id, bytes: s.bytes, mime: s.mime })));
        const s1 = cacheCtx.stats();
        await cacheCtx.decodeBatch(one.map(([id, s]) => ({ id: id + 500, bytes: s.bytes, mime: s.mime })));
        const s2 = cacheCtx.stats();
        check(s1.cacheMisses === 3 && s2.cacheHits === 3,
          '同样内容的样本第二次直接命中缓存（省一次解码）：命中 ' + s2.cacheHits + '/3');
      } else console.log('  （没找到 3 个合适的小样本，跳过缓存复用检查）');
      cacheCtx.dispose();
    }
  }

  /* ==================================================================
     测试25: 本地 ffmpeg 接口（浏览器靠它拿到 ffmpeg 的速度）
     会真的起一个 tools/serve.js 子进程，并用**浏览器那边同一个模块**去调用
     ================================================================== */
  {
    console.log('\n=== 测试25: 本地 ffmpeg 接口 ===');
    const { spawn } = await import('node:child_process');
    /** 起一个服务器，等它打印真实端口（PORT=0 由系统分配，避免和别的东西抢端口） */
    const startServer = (extraEnv) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(TOOLS, 'serve.js')],
        { env: { ...process.env, PORT: '0', NO_FFMPEG_API: '', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      const to = setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error('启动超时：' + buf)); }, 20000);
      const onData = (d) => {
        buf += d.toString();
        const m = /http:\/\/localhost:(\d+)\//.exec(buf);
        if (m) { clearTimeout(to); resolve({ child, port: Number(m[1]), text: () => buf }); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', c => { clearTimeout(to); reject(new Error('服务器退出 code=' + c + '：' + buf)); });
    });
    const stop = (s) => { try { s.child.kill(); } catch (e) {} };

    let srv = null;
    try {
      srv = await startServer({});
      const base = 'http://localhost:' + srv.port;

      // ① 探测：浏览器用的就是 probeFfmpegBackend
      const st = await C.probeFfmpegBackend({ base, timeoutMs: 5000 });
      check(st.available === true, '探测到本地 ffmpeg 接口（' + (st.version ? st.version.slice(0, 24) : '') + '）');
      check(st.encoders.includes('libmp3lame'), '接口报告 libmp3lame 可用');

      // ② 注册成后端后，encodeAudioAsync 应该走它（这是网页端真实路径）
      check(C.encoderBackend('mp3') === null, '注册前 mp3 没有后端（走内置 lamejs）');
      C.registerFfmpegHttpEncoder(base);
      check(C.encoderBackend('mp3') !== null, '注册后 mp3 有了后端');
      const R = 44100, N = R * 2;
      const lo = new Float32Array(N), ro = new Float32Array(N);
      for (let i = 0; i < N; i++) { lo[i] = Math.sin(2 * Math.PI * 440 * i / R) * 0.4; ro[i] = Math.sin(2 * Math.PI * 550 * i / R) * 0.3; }
      const pcm = { left: lo, right: ro, length: N, sampleRate: R };
      let prog = null;
      const viaHttp = await C.encodeAudioAsync(pcm, 'mp3', 320, { onProgress: (f) => { prog = f; } });
      check(viaHttp.bytes.length > 2000 && (viaHttp.bytes[0] === 0xFF || String.fromCharCode(...viaHttp.bytes.slice(0, 3)) === 'ID3'),
        '经本地 ffmpeg 编出 MP3：' + viaHttp.bytes.length + ' 字节，头 ' + viaHttp.bytes[0].toString(16));
      check(viaHttp.fmt.id === 'mp3' && prog === 1, '格式元数据与进度回调正常（进度收到 ' + prog + '）');

      // ③ 与内置 lamejs 的结果都必须是合法 MP3（体积相近即可，不求字节相同）
      C.unregisterFfmpegBackends();
      check(C.encoderBackend('mp3') === null, '注销后回到内置 lamejs');
      const viaLame = await C.encodeAudioAsync(pcm, 'mp3', 320, {});
      const ratio = viaLame.bytes.length / viaHttp.bytes.length;
      check(ratio > 0.7 && ratio < 1.4, '两条路体积接近（lamejs ' + viaLame.bytes.length + ' vs ffmpeg '
        + viaHttp.bytes.length + '，比值 ' + ratio.toFixed(2) + '）');

      // ④ 参数错误必须被明确拒绝（而不是静默出一个坏文件）
      const bad = await fetch(base + '/api/encode?format=flac', { method: 'POST', body: new Uint8Array(8) });
      check(bad.status === 400, '不支持的格式 → 400');
      const odd = await fetch(base + '/api/encode?format=mp3', { method: 'POST', body: new Uint8Array(10) });
      check(odd.status === 400, '长度不合规 → 400');
      const get = await fetch(base + '/api/encode');
      check(get.status === 405, 'GET → 405');
      const notFound = await fetch(base + '/api/nope');
      check(notFound.status === 404, '不存在的接口 → 404');

      // ⑤ 大请求体后紧接一个错误请求，不能因为连接复用而出错（真踩过：ECONNRESET）
      const big = new Uint8Array(R * 8);                          // 1 秒
      const okBig = await fetch(base + '/api/encode?format=mp3&rate=' + R, { method: 'POST', body: big });
      check(okBig.status === 200, '连续请求中的大请求体正常（' + okBig.status + '）');
      const after = await fetch(base + '/api/encode?format=flac', { method: 'POST', body: new Uint8Array(8) });
      check(after.status === 400, '大请求之后的下一个请求仍能被正常处理（不会被残留数据污染）');
      stop(srv);

      // ⑥ 没有接口时必须干净地报告不可用（页面就靠这个退回 lamejs）
      const srv2 = await startServer({ NO_FFMPEG_API: '1' });
      try {
        const off = await C.probeFfmpegBackend({ base: 'http://localhost:' + srv2.port, timeoutMs: 5000 });
        check(off.available === false && !!off.error, 'NO_FFMPEG_API=1 时报告不可用：' + off.error);
        const r = await fetch('http://localhost:' + srv2.port + '/api/encode?format=mp3', { method: 'POST', body: new Uint8Array(8) });
        check(r.status === 400, '接口关闭时 encode 返回 400（页面据此退回 lamejs）');
      } finally { stop(srv2); }

      // ⑦ 接口根本没有时（例如别的静态服务器）probe 不能抛，要返回不可用
      const dead = await C.probeFfmpegBackend({ base: 'http://localhost:1', timeoutMs: 1500 });
      check(dead.available === false && !!dead.error, '接口不存在时返回不可用而不抛异常');
    } catch (e) {
      if (srv) stop(srv);
      check(false, '本地 ffmpeg 接口测试抛异常：' + e.message);
    }
  }

  /* ==================================================================
     测试27: BMS 解析（随机分支 / 文本编码 / 头信息）
     ================================================================== */
  {
    console.log('\n=== 测试27: BMS 解析 ===');
    const B = C.bms;
    const enc = (s) => new TextEncoder().encode(s);
    const withBytes = (prefix, bytes) => {
      const a = enc(prefix);
      const u = new Uint8Array(a.length + bytes.length);
      u.set(a); u.set(bytes, a.length);
      return u;
    };

    // #RANDOM：只取生效的那一支
    const rnd = ['#TITLE R', '#BPM 150', '#RANDOM 2',
      '#IF 1', '#00111:01', '#ENDIF',
      '#IF 2', '#00112:01', '#ENDIF', '#ENDRANDOM'].join('\n');
    const p1 = B.parseBms(enc(rnd), { random: 1 });
    const p2 = B.parseBms(enc(rnd), { random: 2 });
    check(p1.entries.length === 1 && p1.entries[0].ch === '11', '#RANDOM 取第 1 支 → 只有 ch11 生效');
    check(p2.entries.length === 1 && p2.entries[0].ch === '12', '#RANDOM 取第 2 支 → 只有 ch12 生效');

    // 编码：GBK（国服改版）与 Shift-JIS（日系原版）都要认对
    const pg = B.parseBms(withBytes('#TITLE ', [0xD4, 0xC2, 0xD2, 0xB9]));   // GBK「月夜」
    const ps = B.parseBms(withBytes('#TITLE ', [0x82, 0xA0]));               // SJIS「あ」
    check(pg.encoding === 'gb18030' && pg.meta.title.trim() === '月夜',
      'GBK 谱面 → gb18030 / 月夜（实得 ' + pg.encoding + ' / ' + pg.meta.title + '）');
    check(ps.encoding === 'shift_jis' && ps.meta.title.trim() === 'あ',
      'Shift-JIS 谱面 → shift_jis / あ（实得 ' + ps.encoding + ' / ' + ps.meta.title + '）');

    // 头信息：SUBARTIST 进 Creator、PLAYLEVEL 进等级
    const head = ['#TITLE T', '#ARTIST A', '#SUBARTIST MAKER', '#PLAYLEVEL 9', '#BPM 145',
      '#WAV01 a.wav', '#BPM01 180', '#STOP01 96'].join('\n');
    const ph = B.parseBms(enc(head));
    check(ph.meta.playlevel === 9 && ph.meta.bpm === 145 && ph.meta.subartist[0] === 'MAKER',
      '头信息：等级 9 / BPM 145 / 谱师 MAKER');
    check(ph.wav.size === 1 && ph.bpmIdx.get(1) === 180 && ph.stopIdx.get(1) === 96,
      '#WAV / #BPMxx / #STOPxx 索引都进来了');
  }

  /* ==================================================================
     测试28: BMS 时间轴（BPM 变速 / 小节长度 / STOP / 长音）
     期望值已与 .NET 参考实现 BmsToOsu 逐毫秒对齐（同一份探针）
     ================================================================== */
  {
    console.log('\n=== 测试28: BMS 时间轴 ===');
    const B = C.bms;
    const probe = ['#PLAYER 1', '#TITLE Timing Probe', '#ARTIST probe', '#BPM 120', '#BPM01 240',
      '#PLAYLEVEL 5', '#LNTYPE 1', '#WAV01 kick.wav', '#STOP01 192',
      '#00111:0100010001000100',   // m1 四连（m1 长度 0.5 → 2 拍）
      '#00102:0.5',
      '#00208:0001',               // m2 中点变速到 240
      '#00211:01010101',
      '#00309:0001',               // m3 中点 STOP 1 个全音符
      '#00311:01010101',
      '#00452:0101',               // m4 一条长音
      '#00511:0001000100010001'].join('\n');
    const parsed = B.parseBms(new TextEncoder().encode(probe));
    const ch = B.buildChart(parsed, { keys: 7 });   // 探针只弹前 5 列，显式按 7K 出图
    const lines = ch.hitObjects.map(h => h.type === 128 ? h.time + '-' + h.endTime : String(h.time));
    const want = ['2000', '2250', '2500', '2750', '3000', '3500', '4000', '4250',
                  '4500', '4750', '5000', '6250', '6500-7000', '7625', '7875', '8125', '8375'];
    check(lines.length === want.length, '物件数 ' + lines.length + '（期望 ' + want.length + '）');
    check(lines.join(',') === want.join(','), '时间轴与 .NET 参考实现逐毫秒一致');
    check(ch.timingPoints.length === 2 && ch.timingPoints[1].time === 4000
          && Math.abs(ch.timingPoints[1].beatLength - 250) < 1e-6,
      '变速点：4000ms / beatLength 250（240BPM）');
    check(ch.keys === 7 && ch.hitObjects[0].x === 36, '无皿 → 7K，第 0 列 x=36');
  }

  /* ==================================================================
     测试29: BMS 列布局 / 缺样本容错 / 长音修正
     ================================================================== */
  {
    console.log('\n=== 测试29: BMS 列布局与容错 ===');
    const B = C.bms;
    const enc = (s) => new TextEncoder().encode(s);

    const scr = ['#TITLE S', '#BPM 120', '#WAV01 a.wav', '#00111:01', '#00112:01', '#00119:01', '#00116:01'].join('\n');
    const ps = B.parseBms(enc(scr));
    const c8 = B.buildChart(ps, { plate: 'column' });
    const c7 = B.buildChart(ps, { plate: 'drop' });
    check(c8.keys === 8 && B.layoutLabel(c8.layout) === '7K1S'
          && Math.min(...c8.hitObjects.map(h => h._column)) === 0,
      '皿占一列 → 7K1S / 8 列（共 ' + c8.hitObjects.length + ' 个物件）');
    check(c8.hitObjects.every(h => h.x === Math.floor(512 * (h._column + 0.5) / 8)), '8 列时列中心按 512 等分');
    check(c7.keys === 7 && c7.hitObjects.length === 3 && c7.stats.scratchDropped === 1,
      'drop 模式：皿丢弃，琴键保留（' + c7.hitObjects.length + ' 个 / 皿丢 ' + c7.stats.scratchDropped + '）');

    // 5K1S：只用 11-15 + 16
    const k5 = ['#TITLE K5', '#BPM 120', '#WAV01 a.wav', '#00115:01', '#00116:01'].join('\n');
    const c5 = B.buildChart(B.parseBms(enc(k5)), {});
    check(B.layoutLabel(c5.layout) === '5K1S' && c5.keys === 6,
      '5 键 + 单皿 → 5K1S / 6 列（实得 ' + B.layoutLabel(c5.layout) + ' / ' + c5.keys + '）');

    // 双人谱 + 双手皿：16 在最左、26 在最右
    const dp = ['#TITLE DP', '#BPM 120', '#WAV01 a.wav',
      '#00111:01', '#00116:01', '#00119:01', '#00121:01', '#00126:01', '#00129:01'].join('\n');
    const cdp = B.buildChart(B.parseBms(enc(dp)), {});
    check(B.layoutLabel(cdp.layout) === '14K2S' && cdp.keys === 16,
      '双人 7+7 + 双皿 → 14K2S / 16 列（实得 ' + B.layoutLabel(cdp.layout) + ' / ' + cdp.keys + '）');
    const laneHas = (n) => cdp.hitObjects.some(h => h._column === n);
    check(laneHas(0) && laneHas(15), '左手皿在第 0 列、右手皿在第 15 列');
    check(laneHas(1) && laneHas(7) && laneHas(8) && laneHas(14), '1P 键 1..7 在 1..7 列、2P 键 1..7 在 8..14 列');
    check(cdp.hitObjects.find(h => h._column === 15).x === Math.floor(512 * 15.5 / 16),
      '右手皿贴最右（x=' + cdp.hitObjects.find(h => h._column === 15).x + '）');

    // 显式键型覆盖自动判定
    const force = B.buildChart(B.parseBms(enc(k5)), { keys: 7 });
    check(force.keys === 7 && force.layout.scratch === false && B.layoutLabel(force.layout) === '7K',
      '显式 keys:7 覆盖自动判定（皿不发列）');
    let badKeys = null;
    try { B.layoutFromColumns(9); } catch (e){ badKeys = e.message; }
    check(!!badKeys, '不支持的列数会明确报错（' + badKeys + '）');

    // 缺 #WAV 定义：音符必须保留（这是 BmsToOsu 的老毛病：整首变空谱）
    const miss = ['#TITLE M', '#BPM 120', '#WAV01 a.wav', '#00111:010002000300'].join('\n');
    const cm = B.buildChart(B.parseBms(enc(miss)), {});
    check(cm.hitObjects.length === 3, '缺 #WAV 定义的音符全部保留（' + cm.hitObjects.length + ' 个）');

    // 未闭合长音 → 补 1/2 拍；关掉 repair → 降级为普通音符
    const ln = ['#TITLE L', '#BPM 120', '#LNTYPE 1', '#WAV01 a.wav', '#00151:01'].join('\n');
    const pl = B.parseBms(enc(ln));
    const ok = B.buildChart(pl, { repair: true });
    const off = B.buildChart(pl, { repair: false });
    check(ok.hitObjects[0].type === 128 && (ok.hitObjects[0].endTime - ok.hitObjects[0].time) === 250 && ok.stats.closedHold === 1,
      '未闭合长音补成 1/2 拍（120BPM → 250ms）');
    check(off.hitObjects[0].type === 1 && off.stats.demotedHold === 1, '关掉 repair → 降级为普通音符');

    // #LNOBJ：取值等于 lnobj 的音符用来结束同列上一个音符
    const lno = ['#TITLE N', '#BPM 120', '#LNOBJ ZZ', '#WAV01 a.wav', '#WAVZZ z.wav',
      '#00111:01', '#00211:ZZ'].join('\n');
    const pn = B.parseBms(enc(lno));
    const cn = B.buildChart(pn, {});
    check(cn.hitObjects.length === 1 && cn.hitObjects[0].type === 128,
      '#LNOBJ：后一个音符把前一个变成长音（' + (cn.hitObjects[0] && cn.hitObjects[0].type) + '）');
  }

  /* ==================================================================
     测试30: BMS 端到端（键音模式 → .osu + 样本 + 自检）
     ================================================================== */
  {
    console.log('\n=== 测试30: BMS 端到端 ===');
    const B = C.bms;
    const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bms-e2e-'));
    // 一个最小 WAV（44 字节头 + 少量静音）
    const wav = new Uint8Array(44 + 64);
    const put = (off, s) => { for (let i = 0; i < s.length; i++) wav[off + i] = s.charCodeAt(i); };
    put(0, 'RIFF'); wav[4] = 36 + 64; wav[5] = 0; wav[6] = 0; wav[7] = 0;
    put(8, 'WAVEfmt ');
    fs.writeFileSync(path.join(tmp, 'kick.wav'), Buffer.from(wav));
    // m1 有键音、BGM 在开头（可当音轨），m2 有键音
    fs.writeFileSync(path.join(tmp, 'chart.bms'), [
      '#TITLE E2E Song', '#ARTIST Tester', '#BPM 120', '#PLAYLEVEL 7', '#LNTYPE 1',
      '#WAV01 kick.wav', '#WAV02 bgm.wav',
      '#00101:02', '#00111:01010101', '#00211:01010101', '#00219:01',
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'bgm.wav'), Buffer.from(wav));

    const fake = (name) => ({
      name, webkitRelativePath: name, size: fs.statSync(path.join(tmp, name)).size,
      arrayBuffer: async () => { const b = fs.readFileSync(path.join(tmp, name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    });
    const files = fs.readdirSync(tmp).map(fake);
    const song = await B.prepareSong('', files, { plate: 'column' });
    check(song.diffs.length === 1 && song.title === 'E2E Song' && song.artist === 'Tester',
      'prepareSong：1 个难度 / 标题与艺术家正确');

    const opts = { audioMode: 'keysound', audioFormat: 'wav', mp3Kbps: 320, sampleRate: 44100,
      normalize: true, plate: 'column', keys: null, stops: true, od: NaN, hp: 8.2, serverTag: '',
      tagMode: 'keep', tagTemplate: '', zipPerSong: true };
    const res = await B.convertBmsSong(song, opts, null, null);
    const osu = res.files.find(f => /\.osu$/.test(f.name));
    const text = osu ? Buffer.from(osu.data).toString('utf8') : '';
    check(!!osu, '产出 .osu（' + (osu && osu.name) + '）');
    check(res.files.some(f => f.name === 'kick.wav'), '键音样本被拷进图包');
    check(/Sample,\d+,0,"bgm\.wav",\d+/.test(text), 'BGM 写成 [Events] 的 Sample 行');
    check(/hitSample|0:0:0:\d+:kick\.wav/.test(text), '音符自带键音写进 hitSample');
    check(text.includes('Source:BMS') && text.includes('CircleSize:7'), '元数据走 BMS 口径（Source:BMS / CS 7）');
    check(C.validateOsuText(text).length === 0, '产物通过 .osu 自检（' + C.validateOsuText(text).join(';') + '）');
  }

  /* ==================================================================
     测试33: 同名难度 / zip 重名条目（真实案例：16010 Fly Above）
     SP 与 DP 版本共用同一个 #DIFFICULTY → 生成同名 .osu → .osz 里两条同名条目
     → osu! 导入直接失败（ZipArchiveReader.GetStream 用 SingleOrDefault，抛
       "Sequence contains more than one matching element"，日志只显示 Model creation failed）
     ================================================================== */
  {
    console.log('\n=== 测试33: 同名难度与重名条目 ===');
    const B = C.bms;
    const mk = (player, diff, chans) => ['#PLAYER ' + player, '#TITLE Dup Test', '#ARTIST T',
      '#BPM 150', '#PLAYLEVEL 8', '#DIFFICULTY ' + diff, '#WAV01 a.wav', ...chans].join('\n');
    const spec = [
      ['[Another7].bme', mk(1, 4, ['#00111:01010101', '#00116:01010101', '#00119:01010101'])],
      ['[Another14].bme', mk(3, 4, ['#00111:01010101', '#00116:01010101', '#00119:01010101', '#00121:01010101', '#00126:01010101', '#00129:01010101'])],
      ['[Hyper7].bme', mk(1, 3, ['#00111:01010101', '#00116:01010101', '#00119:01010101'])],
      ['[Hyper14].bme', mk(3, 3, ['#00111:01010101', '#00116:01010101', '#00119:01010101', '#00121:01010101', '#00126:01010101', '#00129:01010101'])],
      ['[Normal7].bme', mk(1, 2, ['#00111:01010101', '#00116:01010101', '#00119:01010101'])],
      ['[Normal14].bme', mk(3, 2, ['#00111:01010101', '#00116:01010101', '#00119:01010101', '#00121:01010101', '#00126:01010101', '#00129:01010101'])],
    ];
    const files = spec.map(([name, text]) => {
      const bytes = new TextEncoder().encode(text);
      const f = {
        name, webkitRelativePath: name, size: bytes.length,
        arrayBuffer: async () => bytes.buffer.slice(0),
      };
      return f;
    });
    const song = await B.prepareSong('', files, { plate: 'column' });
    const names = song.diffs.map(d => d.name);
    check(song.diffs.length === 6, '六个难度都解析出来（' + song.diffs.length + '）');
    check(new Set(names.map(n => n.toLowerCase())).size === 6,
      '难度名互不相同：' + names.join(' / '));
    check(names.some(n => /14K2S/.test(n)) && names.some(n => /7K1S/.test(n)),
      '重名的档位补上了键型（SP 与 DP 不再撞名）');

    const opts = { audioMode: 'none', audioFormat: 'wav', mp3Kbps: 320, sampleRate: 44100,
      normalize: true, plate: 'column', keys: null, stops: true, od: NaN, hp: 8.2, serverTag: '',
      tagMode: 'keep', tagTemplate: '', zipPerSong: true };
    const res = await B.convertBmsSong(song, opts, null, null);
    const allNames = res.files.map(f => f.name.toLowerCase());
    check(new Set(allNames).size === allNames.length, '产出文件无重名（' + res.files.length + ' 个）');
    let zipBytes = null, zipErr = null;
    try { zipBytes = C.makeZip(res.files); } catch (e){ zipErr = e.message; }
    check(!zipErr && zipBytes && zipBytes.length > 200, '整包能打成合法 ZIP' + (zipErr ? '：' + zipErr : ''));

    let dupErr = null;
    try { C.makeZip([{ name: 'a.osu', data: new Uint8Array(1) },
                     { name: 'A.osu', data: new Uint8Array(1) }]); }
    catch (e){ dupErr = e.message; }
    check(!!dupErr && /重名/.test(dupErr), '重名条目当场报错而不是产出坏包（' + (dupErr || '').slice(0, 40) + '…）');
    // osu! 只导入 .osz **根层** 的 .osu（BeatmapImporter.createBeatmapDifficulties 过滤掉含 '/' 的名字），
    // 所以两个面板都不能再把文件塞进 [_xxx_] 子目录里。
    check(!/folder\s*\+\s*'\/'\s*\+\s*f\.name/.test(core),
      '两个面板打包时不再给文件加子目录前缀');
    check(/makeZipChunks\(res\.files\.map\(f => \(\{ name: f\.name, data: f\.data \}\)\)/.test(core) ||
          core.includes('name: f.name, data: f.data'), '打包用的是根层文件名');

    // 真实案例（IIDX16 ~Empress~ - Fly Above）：BMS 写 "01.wav"，磁盘上只有 "01.ogg"。
    // beatoraja / LR2 会换扩展名找；不换就是整首 459 个样本全「找不到」→ 静音。
    const idx = B.buildFileIndex([
      { name: '01.ogg', webkitRelativePath: '01.ogg' },
      { name: '02.ogg', webkitRelativePath: '02.ogg' },
      { name: 'k.bms', webkitRelativePath: 'k.bms' },
    ]);
    const hit = B.resolveSample('01.wav', '', idx);
    check(!!hit && hit.name === '01.ogg', '#WAV 写 .wav / 磁盘只有 .ogg → 换扩展名找到（' + (hit && hit.name) + '）');
    check(B.resolveSample('99.wav', '', idx) === null, '确实不存在的样本仍然返回 null（不乱认）');
    const exact = B.resolveSample('01.ogg', '', idx);
    check(!!exact && exact.name === '01.ogg', '扩展名本来就对时优先精确命中');
  }

  /* ==================================================================
     测试34: ZIP 曲包直读（不解压、不需要解压权限）
     现实：BMS 单曲常以压缩包分发，一个个解压很烦，且源目录有时需要管理员权限。
     ================================================================== */
  {
    console.log('\n=== 测试34: ZIP 曲包直读 ===');
    const zlib = await import('node:zlib');
    const enc = (s) => new TextEncoder().encode(s);

    /** 现场造一个 zip（可选 deflate / 加密标记），用来验证解析而不是依赖现成文件 */
    const buildZip = (entries) => {
      const parts = [], central = [];
      let offset = 0;
      for (const e of entries){
        const nameBytes = enc(e.name);
        const raw = e.data;
        const comp = e.deflate ? new Uint8Array(zlib.deflateRawSync(raw)) : raw;
        const crc = C.crc32(raw) >>> 0;
        const flags = 0x0800 | (e.encrypted ? 1 : 0);
        const method = e.deflate ? 8 : 0;
        const lh = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(lh.buffer);
        lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, flags, true);
        lv.setUint16(8, method, true);
        lv.setUint32(14, crc, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, raw.length, true);
        lv.setUint16(26, nameBytes.length, true);
        lh.set(nameBytes, 30);
        parts.push(lh, comp);
        const cd = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
        cv.setUint16(8, flags, true); cv.setUint16(10, method, true);
        cv.setUint32(16, crc, true); cv.setUint32(20, comp.length, true); cv.setUint32(24, raw.length, true);
        cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true);
        cd.set(nameBytes, 46);
        central.push(cd);
        offset += lh.length + comp.length;
      }
      const cdSize = central.reduce((a, b) => a + b.length, 0);
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
      ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
      const total = parts.reduce((a, b) => a + b.length, 0) + cdSize + 22;
      const out = new Uint8Array(total);
      let p = 0;
      for (const x of parts.concat(central, [eocd])){ out.set(x, p); p += x.length; }
      return out;
    };

    const text = 'kick';
    const bin = new Uint8Array([1, 2, 3, 4, 5]);
    const zip = buildZip([
      { name: 'song/感覚.bms', data: enc('#TITLE T'), deflate: true },
      { name: 'song/01.wav', data: bin, deflate: false },
    ]);

    check(C.looksLikeZip(zip), '识别 ZIP 头');
    check(C.looksLikeZip(new TextEncoder().encode('not a zip')) === false, '非 ZIP 不误判');

    const entries = C.listZipEntries(zip);
    check(entries.length === 2 && entries[0].name === 'song/感覚.bms',
      '中文/日文文件名（UTF-8 flag）能正确解出：' + (entries[0] && entries[0].name));
    check(entries.find(e => e.name === 'song/01.wav').method === 0, 'store 条目 method=0');
    check(entries.find(e => e.name === 'song/感覚.bms').method === 8, 'deflate 条目 method=8');

    {
      const store = await C.readZipEntry(zip, entries.find(e => e.name === 'song/01.wav'));
      check(store.length === bin.length && store.every((v, i) => v === bin[i]), 'store 条目读出字节一致');
      const defl = await C.readZipEntry(zip, entries.find(e => e.name === 'song/感覚.bms'));
      check(Buffer.from(defl).toString('utf8') === '#TITLE T', 'deflate 条目解压正确');
    }

    // 摊平成虚拟文件：前缀 = 压缩包名（不含扩展名），arrayBuffer 懒解压
    const expanded = C.expandZip(zip, 'MyPack');
    check(expanded.files.length === 2 && expanded.files[0].webkitRelativePath === 'MyPack/song/感覚.bms',
      '摊平后路径带压缩包前缀：' + (expanded.files[0] && expanded.files[0].webkitRelativePath));
    {
      const buf = await expanded.files.find(f => f.name === '01.wav').arrayBuffer();
      check(buf.byteLength === bin.length && new Uint8Array(buf)[4] === 5, '虚拟文件的 arrayBuffer() 能取回原始字节');
    }

    // 加密条目：明确跳过并报警，而不是读出乱码
    const encZip = buildZip([{ name: 'a.bms', data: enc('x'), encrypted: true }]);
    const encExp = C.expandZip(encZip, 'Enc');
    check(encExp.files.length === 0 && encExp.warnings.length === 1 && /加密/.test(encExp.warnings[0]),
      '加密条目跳过并给出警告');

    // 端到端：从压缩包里的 BMS + 波形直接产出 .osu
    {
      const wav = new Uint8Array(44 + 64);
      const put = (off, s) => { for (let i = 0; i < s.length; i++) wav[off + i] = s.charCodeAt(i); };
      put(0, 'RIFF'); wav[4] = 36 + 64; put(8, 'WAVEfmt ');
      const songZip = buildZip([
        { name: 'ZipSong/x.bms', data: enc(['#TITLE Zip Song', '#ARTIST T', '#BPM 150', '#PLAYLEVEL 7',
          '#WAV01 a.wav', '#00111:01010101'].join('\n')), deflate: true },
        { name: 'ZipSong/a.wav', data: wav, deflate: true },
      ]);
      const files = C.expandZip(songZip, 'ZipSong.zip').files;
      const song = await C.bms.prepareSong('', files, { plate: 'column' });
      check(!!song && song.diffs.length === 1 && song.title === 'Zip Song',
        '压缩包里的 BMS 能直接解析（' + (song && song.title) + '）');
      const res = await C.bms.convertBmsSong(song, {
        audioMode: 'keysound', audioFormat: 'wav', mp3Kbps: 320, sampleRate: 44100, normalize: true,
        plate: 'column', keys: null, stops: true, od: NaN, hp: 8.2, serverTag: '', tagMode: 'keep',
        tagTemplate: '', zipPerSong: true,
      }, null, null);
      const osu = res.files.find(f => /\.osu$/.test(f.name));
      check(!!osu && res.files.some(f => f.name === 'a.wav'),
        '压缩包里的谱面+样本能产出 .osu 与样本（' + res.files.length + ' 个文件）');
    }
  }


  /* ==================================================================
     测试31: 浏览器侧模块能被导入（语法 / 模块图 / 导出）
     文本级的 DOM 接线检查抓不到语法错误，这一条补上 —— 它真抓到过
     面板里一个重复声明（会让整个页面报废）
     ================================================================== */
  {
    console.log('\n=== 测试31: 浏览器模块可导入 ===');
    let ui = null, fh = null, err = null;
    try {
      ui = await import('../src/modes/o2jam/panel.js');
    } catch (e) { err = e.message; }
    try { fh = await import('../src/core/encoders/ffmpeg-http.js'); } catch (e) { err = err || e.message; }
    check(!err, '各模式面板 / ffmpeg-http.js 导入无错' + (err ? '：' + err : ''));
    check(!!ui && typeof ui.initUI === 'function', 'o2jam 面板导出 initUI');
    check(!!fh && typeof fh.probeFfmpegBackend === 'function' && typeof fh.registerFfmpegHttpEncoder === 'function'
      && typeof fh.unregisterFfmpegBackends === 'function', 'ffmpeg-http.js 三个函数都导出');
    check(typeof C.probeFfmpegBackend === 'function' && typeof C.unregisterEncoder === 'function',
      'barrel（src/index.js）能把它们透出去');
  }

  /* ==================================================================
     测试32: 单文件打包（dist/hub.html）—— 双击 file:// 也能用
     背景：ES 模块在 file:// 下会被 CORS 拦掉，整页脚本不执行（标签页点不动）。
     打包器把模块换成「注册表 + 经典脚本」，这一条守住它不退化。
     ================================================================== */
  {
    console.log('\n=== 测试32: 单文件打包 ===');
    const outFile = path.join(process.env.TEMP || '.', 'hub-bundle-' + process.pid + '.html');
    let buildErr = null;
    await new Promise((res) => {
      execFile(process.execPath, [path.join(TOOLS, 'bundle.mjs'), outFile], { cwd: PROJ },
        (e, so, se) => { if (e) buildErr = (se || e.message || '').trim(); res(); });
    });
    check(!buildErr, '打包器能跑通' + (buildErr ? '：' + buildErr : ''));
    if (!buildErr){
      const html = fs.readFileSync(outFile, 'utf8');
      check(!html.includes('type="module"'), '产物里没有 type="module"（file:// 才不会被拦）');
      check(/__def\("core\/util\.js"/.test(html) && html.includes('__req("ui/shell.js")'),
        '模块注册表与入口都在（' + (html.match(/__def\(/g) || []).length + ' 个模块）');
      check(!/^\s*(?:import|export)\s/m.test(html), '没有残留的 import/export 语句');
      check(html.includes('__MANIA_HUB_BOOTED'), '保留了「file:// 启动失败」提示脚本');
      check(html.includes('lamejs') && html.length > 200000, '内含 lamejs 与全部代码（' + Math.round(html.length / 1024) + ' KB）');
      fs.unlinkSync(outFile);
    }
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
