// O2Jam 模式面板（.ojn + .ojm → osu!）
//
// 只负责「O2Jam 特有的事」：OJN/OJM 配对、三难度（EX/NX/HX）、编码检测、列表列、预览、逐首转换。
// 拖入分诊、通用选项、进度条、日志、下载都由 src/ui/shell.js 提供。
//
// 逻辑来自原 src/ui.js（拆分时未改行为；唯一修正是 renderPreview 里 `o` 的 TDZ 引用
// —— 原来先用了 `o.autoRepair` 再 `const o = opts()`，导致预览永远显示“预览失败”）。

import { buildOsuText, buildTags, describeRepairs } from '../../core/osu/writer.js';
import { buildChart } from './chart.js';
import { parseOjm } from './ojm.js';
import { OjxError, parseOjnEvents, parseOjnHeader } from './ojn.js';
import { convertOneSong } from './pipeline.js';
import { detectEncoding, makeTextDecoder } from '../../core/text.js';
import { DIFFS, log, sanitizeFilename } from '../../core/util.js';
import { makeZipChunks } from '../../core/zip.js';

export function createO2JamPanel(){
  const state = { songs: [], sel: new Set(), samplesByDir: new Map(), encByDir: new Map(), globalEnc: 'utf-8' };
  let shell = null;
  const $ = (id) => shell.$(id);
  const esc = (s) => shell.esc(s);

  /* ---------- 编码检测（可重复调用：改了“文本编码”就重新解码已载入的谱面） ---------- */
  function encOf(dir){ return state.encByDir.get(dir || '') || state.globalEnc; }
  function detectAll(forced){
    const all = [].concat(...state.samplesByDir.values());
    state.globalEnc = detectEncoding(all, forced).encoding;
    state.encByDir = new Map();
    for (const [d, arr] of state.samplesByDir)
      state.encByDir.set(d, forced !== 'auto' ? forced
                    : (arr.length >= 8 ? detectEncoding(arr).encoding : state.globalEnc));
  }
  function applyEncoding(forced){
    detectAll(forced);
    for (const s of state.songs){
      if (s.ojx) continue;
      s.encoding = encOf(s.dir);
      s.decode = makeTextDecoder(s.encoding);
      s.latin1Title = new TextDecoder('windows-1252').decode(s.header.rawTitle).replace(/\0.*$/, '').trim();
    }
    log('文本编码：' + [...new Set(state.encByDir.values())].join(' / ')
        + (forced === 'auto' ? '（自动检测；O2Jam 是 GBK 系，连日文标题也是 GBK）' : '（手动指定 ' + forced + '）'));
  }

  /* ---------- 载入文件 ---------- */
  async function addFiles(fileList){
    const files = Array.from(fileList);
    const ojnFiles = files.filter(f => /\.ojn$/i.test(f.name));
    if (!ojnFiles.length){ log('没有发现 .ojn 文件。', 'w'); return; }
    log('读取 ' + ojnFiles.length + ' 个 .ojn …');

    // 先按「同目录 + 同基名」找 .ojm，找不到就按 ojn 头里的 ojm_file 名兜底
    const byDirName = new Map();
    for (const f of files) byDirName.set(((f.webkitRelativePath || f.name).replace(/[^/]*$/, '') + f.name).toLowerCase(), f);

    const headers = [];
    for (const f of ojnFiles){
      try {
        const headBuf = await f.slice(0, 300).arrayBuffer();
        const h = parseOjnHeader(headBuf);
        h.fileName = f.name;
        headers.push({ file: f, header: h, dir: (f.webkitRelativePath || f.name).replace(/[^/]*$/, '') });
      } catch (e){
        if (e instanceof OjxError) headers.push({ file: f, ojx: true });
        else log('跳过 ' + f.name + '：' + e.message, 'w');
      }
    }
    if (!headers.length){ log('没有可解析的 OJN。', 'e'); return; }

    // 整包编码检测：先用所有 OJN 的 title/artist/noter 原始字节投票
    const samplesByDir = new Map();
    for (const it of headers){
      if (!it.header) continue;
      const d = it.dir || '';
      if (!samplesByDir.has(d)) samplesByDir.set(d, []);
      const g = samplesByDir.get(d);
      g.push(it.header.rawTitle, it.header.rawArtist, it.header.rawNoter);
    }
    state.samplesByDir = samplesByDir;
    detectAll($('encoding').value);

    // 建立列表（decode 稍后由 applyEncoding 统一填上）
    for (const it of headers){
      if (it.ojx) continue;
      const h = it.header;
      const decode = makeTextDecoder(encOf(it.dir));
      const ojmName = decode(h.rawOjm);
      let ojm = byDirName.get((it.dir + ojmName).toLowerCase());
      if (!ojm){
        const guess = h.fileName.replace(/\.ojn$/i, '.ojm');
        ojm = files.find(f => f.name.toLowerCase() === guess.toLowerCase()
              && ((f.webkitRelativePath || '').replace(/[^/]*$/, '') === it.dir));
      }
      state.songs.push({ ojnFile: it.file, ojmFile: ojm || null, header: h, dir: it.dir, samples: null });
    }
    applyEncoding($('encoding').value);   // 填 decode / encoding / latin1Title，并打日志
    state.songs.sort((a, b) => (a.dir||'').localeCompare(b.dir||'') || a.ojnFile.name.localeCompare(b.ojnFile.name));
    // OJX 的也列出来
    for (const it of headers) if (it.ojx) state.songs.push({
      ojnFile: it.file, ojx: true, dir: it.dir,
      header: { songid: parseInt((it.file.name.match(/(\d+)$/) || [0,0])[1], 10) || 0,
                levels: [0,0,0], noteCounts: [0,0,0], bpm: 0 },
      decode: (b) => new TextDecoder().decode(b), encoding: '-',
    });
    renderTable();
    $('loadStat').innerHTML =
      '已载入 <b>' + state.songs.length + '</b> 个 OJN，其中 <b>' +
      state.songs.filter(s => !s.ojx).length + '</b> 个可解析、<b>' +
      state.songs.filter(s => s.ojx).length + '</b> 个 OJX1 加密；' +
      '配到 OJM 的 <b>' + state.songs.filter(s => s.ojmFile).length + '</b> 个';
    log('载入完成。', 's');
  }

  /* ---------- 列表渲染 ---------- */
  const COLUMNS = ['', 'OJN编号', '乐曲名', '艺术家', '谱师', 'EX', 'NX', 'HX', 'BPM', '编码', '音频', '状态'];
  function renderTable(){
    const tbl = $('tbl');
    if (!tbl) return;
    tbl.querySelector('thead').innerHTML = '<tr>' + COLUMNS.map(c => '<th>' + c + '</th>').join('') + '</tr>';
    const q = ($('filter').value || '').trim().toLowerCase();
    const tb = tbl.querySelector('tbody');
    tb.innerHTML = '';
    for (const s of state.songs){
      const h = s.header;
      const title = s.ojx ? '(OJX1 加密)' : s.decode(h.rawTitle);
      const artist = s.ojx ? '' : s.decode(h.rawArtist);
      const noter = s.ojx ? '' : s.decode(h.rawNoter);
      if (q && !((title + ' ' + artist + ' ' + noter + ' ' + h.songid).toLowerCase().includes(q))) continue;

      const tr = document.createElement('tr');
      tr.dataset.key = s.ojnFile.name + '|' + s.dir;
      const cb = document.createElement('td');
      const chk = document.createElement('input');
      chk.type = 'checkbox'; chk.disabled = !!s.ojx;
      chk.checked = state.sel.has(s);
      chk.onchange = () => { chk.checked ? state.sel.add(s) : state.sel.delete(s); updateSelInfo(); renderPreview(s); };
      cb.appendChild(chk); tr.appendChild(cb);

      tr.insertAdjacentHTML('beforeend',
        "<td class='num'>" + (s.ojx ? h.songid : h.songid) + "</td>" +
        '<td>' + esc(title) + '</td><td>' + esc(artist) + '</td>');

      const encTd = document.createElement('td');
      const encBadge = document.createElement('span');
      if (s.ojx){ encBadge.className = 'badge b-dim'; encBadge.textContent = '-'; }
      else if (s.encoding === 'utf-8'){ encBadge.className = 'badge b-ok'; encBadge.textContent = 'UTF-8'; }
      else {
        const naive = s.latin1Title !== s.decode(s.header.rawTitle);
        encBadge.className = 'badge ' + (naive ? 'b-fix' : 'b-dim');
        encBadge.textContent = s.encoding.toUpperCase() + (naive ? ' · 已修复' : '');
        if (naive) encBadge.title = '原版（Latin-1 兜底）：' + s.latin1Title;
      }
      encTd.appendChild(encBadge);

      const tds = [];
      tds.push('<td>' + esc(noter) + '</td>');
      for (let i = 0; i < 3; i++){
        const n = s.ojx ? 0 : h.noteCounts[i];
        tds.push("<td class='diff'>" + (n > 0 ? 'Lv' + h.levels[i] + ' · ' + n : '—') + '</td>');
      }
      tds.push("<td class='num'>" + (s.ojx ? '' : h.bpm.toFixed(1)) + '</td>');
      tr.insertAdjacentHTML('beforeend', tds.join(''));
      tr.appendChild(encTd);
      tr.insertAdjacentHTML('beforeend',
        '<td>' + (s.ojx ? '' : (s.ojmFile ? esc(s.ojmFile.name) + ' (' + (s.ojmFile.size/1048576).toFixed(1) + 'MB)'
                                        : "<span style='color:var(--err)'>缺 OJM</span>")) + '</td>');
      tr.insertAdjacentHTML('beforeend',
        '<td>' + (s.ojx ? "<span class='badge b-bad'>OJX1 加密</span>" : "<span class='badge b-ok'>可转换</span>") + '</td>');

      tr.onclick = (ev) => { if (ev.target.tagName !== 'INPUT'){ chk.checked = !chk.checked; chk.onchange(); } renderPreview(s); };
      tb.appendChild(tr);
    }
    updateSelInfo();
  }
  function updateSelInfo(){
    const n = state.sel.size;
    $('selInfo').textContent = n ? ('已选中 ' + n + ' 首，共 ' + [...state.sel].reduce((a, s) => {
      return a + (s.ojx ? 0 : s.header.noteCounts.filter(x => x > 0).length); }, 0) + ' 个难度') : '未选中';
  }
  function updateTagPreview(tags){
    const el = $('tagPreview');
    if (el) el.textContent = tags === undefined ? '' : ('Tags: ' + tags);
  }

  /* ---------- 预览 ---------- */
  async function renderPreview(s){
    if (!s || s.ojx){ $('preview').textContent = '（OJX1 加密容器，无法读取元数据）'; $('prevName').textContent = ''; return; }
    try {
      const o = options();
      const buf = await s.ojnFile.arrayBuffer();
      const u8 = new Uint8Array(buf);
      const idx = o.diffs[0] ?? 2;
      const events = parseOjnEvents(u8, s.header.noteOffsets[idx],
        idx < 2 ? s.header.noteOffsets[idx+1] : s.header.coverOffset);
      const built = buildChart(s.header.bpm, events, $('useSV').checked,
        { enabled: o.autoRepair, maxBeats: o.lnMaxBeats });
      const noter = s.decode(s.header.rawNoter);
      const title = s.decode(s.header.rawTitle), artist = s.decode(s.header.rawArtist);
      const tagCtx = { file: s.header.fileName, noter, songid: s.header.songid, title, artist,
                       diff: DIFFS[idx].name, level: s.header.levels[idx] };
      const tags = buildTags(o, tagCtx);
      const text = buildOsuText({
        header: s.header, chart: { level: s.header.levels[idx], noteCount: s.header.noteCounts[idx] },
        meta: { title, artist, noter, tags, od: o.od, hp: o.hp, serverTag: o.serverTag,
                diffName: DIFFS[idx].verSuffix },
        timingPoints: built.timingPoints, hitObjects: built.hitObjects,
        audioFilename: 'preview.wav', musicOffset: 0, coverName: s.header.coverSize > 0 ? 'bg.jpg' : '',
        stats: built.stats,
      });
      updateTagPreview(tags);
      const rep = describeRepairs(built.stats);
      $('prevName').textContent = DIFFS[idx].name + ' · ' + s.ojnFile.name + (rep ? '　修正：' + rep : '');
      $('preview').textContent = text.split('\n').slice(0, 60).join('\n')
        + '\n… 共 ' + text.split('\n').length + ' 行 / ' + built.hitObjects.length + ' 个物件';
    } catch (e){ $('preview').textContent = '预览失败：' + e.message; }
  }

  /* ---------- 选项 ---------- */
  function options(){
    const shared = shell.sharedOpts();
    return Object.assign({}, shared, {
      diffs: [0,1,2].filter(i => $('d' + i).checked),
      useSV: $('useSV').checked,
      suffixMode: $('suffixMode').value,
      autoRepair: $('autoRepair').checked,
      sampleFallback: $('sampleFallback').checked,
      lnMaxBeats: parseFloat($('lnMaxBeats').value) || 0,
    });
  }

  /* ---------- 转换 ---------- */
  async function convert(){
    const o = options();
    if (!o.diffs.length){ alert('至少要勾选一个难度（EX / NX / HX）。'); return; }
    const list = [...state.sel].filter(s => !s.ojx);
    if (!list.length){ alert('请先在列表里勾选要转换的谱面。'); return; }
    const audioCtx = o.audioMode !== 'none' ? await shell.getAudioCtx(o.sampleRate) : null;

    shell.setBusy(true);
    let done = 0, encTxt = '';
    const allFiles = [];
    const onProgress = (ev) => {
      if (typeof ev === 'number') return;                 // 旧式调用
      if (ev && ev.phase === 'encode'){
        encTxt = '编码中 ' + Math.round(ev.frac * 100) + '%';
        shell.paint((done + 0.5 * ev.frac) / list.length, '转换中 ' + (done + 1) + '/' + list.length + '  ' + encTxt);
      }
    };
    // MP3 走本地 ffmpeg 还是内置 lamejs：注册/注销后端要在**开始转换之前**决定
    const useFf = shell.useFfmpegBackend();
    const encTxtStart = useFf ? '（ffmpeg）' : '（lamejs）';
    for (const s of list){
      $('goInfo').textContent = '转换中 ' + (done+1) + '/' + list.length + '：' + s.ojnFile.name;
      shell.paint(done / list.length);
      log('── ' + s.ojnFile.name + ' ——' + (o.audioFormat === 'mp3' ? encTxtStart : ''));
      try {
        // 懒加载 OJM 样本
        if (s.samples === null){
          s.samples = new Map();
          if (s.ojmFile){
            try { s.samples = parseOjm(await s.ojmFile.arrayBuffer(),
                                       (bytes) => new TextDecoder('windows-1252').decode(bytes)); }
            catch (e){ log('  ⚠ OJM 解析失败：' + e.message + '（将生成静音音轨）', 'w'); }
          } else {
            log('  ⚠ 没找到同名 .ojm（请把 .ojn 和 .ojm 一起拖进来；将生成静音音轨）', 'w');
          }
          if (!s.samples.size) log('  ⚠ 没有可用样本 → 会生成静音音轨，请检查 .ojm 是否齐全', 'w');
        }
        const res = await convertOneSong(s, o, audioCtx, onProgress);
        for (const w of res.warnings) log('  ⚠ ' + w, 'w');
        if (res.preview){
          $('prevName').textContent = res.preview.name;
          $('preview').textContent = res.preview.text.split('\n').slice(0,60).join('\n');
        }
        const folder = '[_O2Jam_] ' + sanitizeFilename(s.decode(s.header.rawArtist) + ' - ' + s.decode(s.header.rawTitle).replace(/\.+$/, ''));
        if (o.zipPerSong){
          // 用分块交给 Blob，避免再拼一份和 .osz 等大的内存（大曲子很容易在打包环节炸内存）
          const blob = new Blob(makeZipChunks(res.files.map(f => ({ name: f.name, data: f.data }))),
            { type: 'application/zip' });
          const name = (frac) => frac.replace(/\.osu$/i, '.osz').replace(/[\\/]/g, '');
          const osuFirst = res.files.filter(f => /\.osu$/i.test(f.name)).map(f => name(f.name)).join(' + ');
          shell.download(blob, (folder + '.osz').replace(/[\\/]/g, ''), 'application/zip');
          log('  ✅ 已下载 ' + osuFirst + ' → 打包 ' + folder + '.osz（' + res.files.length + ' 个文件）', 's');
        } else {
          for (const f of res.files) shell.download(f.data, f.name,
            f.mime || (/\.osu$/i.test(f.name) ? 'text/plain;charset=utf-8' : 'application/octet-stream'));
          log('  ✅ 已下载 ' + res.files.length + ' 个文件', 's');
        }
        allFiles.push(...res.files);
      } catch (e){
        log('  ❌ 失败：' + e.message, 'e');
      }
      done++;
      shell.paint(done / list.length);
    }
    shell.setBusy(false);
    shell.info('完成：' + done + ' 首 / ' + allFiles.length + ' 个文件（浏览器已按下载策略逐个保存）');
    log('═══ 全部完成 ═══', 's');
  }

  /* ---------- 模式接口 ---------- */
  const mode = {
    id: 'o2jam',
    label: 'O2Jam → osu!',
    hint: 'OJN/OJM：一首歌内含 EX/NX/HX 三个难度',

    init(sh){
      shell = sh;
      // 选项变化 → 立刻刷新预览（先保证有选中项）
      const ids = ['d0','d1','d2','hp','server','useSV','audioMode','rate','suffixMode','zipPerSong','od',
                   'tagMode','tagTemplate','autoRepair','lnMaxBeats','audioFormat','mp3Kbps','normalize','sampleFallback'];
      for (const id of ids) $(id).addEventListener('change', () => renderPreview([...state.sel][0]));
      $('encoding').addEventListener('change', () => {
        if (state.songs.length){ applyEncoding($('encoding').value); renderTable(); }
        renderPreview([...state.sel][0]);
      });
      $('tagMode').addEventListener('change', () => { $('tagTemplate').disabled = $('tagMode').value === 'keep'; });
      $('tagTemplate').disabled = $('tagMode').value === 'keep';
      renderTable();
    },

    intake: addFiles,
    render: renderTable,
    activate: renderTable,
    selectAll(){ state.songs.forEach(s => { if (!s.ojx) state.sel.add(s); }); renderTable(); },
    selectNone(){ state.sel.clear(); renderTable(); },
    clear(){ state.songs = []; state.sel.clear(); renderTable(); $('loadStat').textContent = ''; log('已清空。'); },
    preview: renderPreview,
    options,
    convert,
  };
  return mode;
}

/** 兼容旧入口（测试与外部脚本）：拿到面板对象 */
export function initUI(shell){ return createO2JamPanel().init(shell); }
