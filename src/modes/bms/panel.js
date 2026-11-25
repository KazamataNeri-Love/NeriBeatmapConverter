// BMS 模式面板（.bms/.bme/.bml/.bmx → osu!）
//
// 「一首歌」= 一个文件夹：里面每个 .bms 是一个难度，#WAV 指向的文件就近取。
// 拖入分诊、通用选项、进度、日志、下载都由 src/ui/shell.js 提供。

import { buildOsuText, describeRepairs } from '../../core/osu/writer.js';
import { log, sanitizeFilename } from '../../core/util.js';
import { makeZipChunks } from '../../core/zip.js';
import { buildChart, layoutLabel } from './chart.js';
import { prepareSong, groupFiles } from './song.js';
import { convertBmsSong } from './pipeline.js';

export function createBmsPanel(){
  const state = { songs: [], sel: new Set() };
  let shell = null;
  const $ = (id) => shell.$(id);
  const esc = (s) => shell.esc(s);

  const has = (f, re) => re.test(f.name || f.webkitRelativePath || '');

  /* ---------- 载入 ---------- */
  async function addFiles(fileList){
    const files = Array.from(fileList);
    const bms = files.filter(f => has(f, /\.(bms|bme|bml|bmx)$/i));
    if (!bms.length){
      if (files.some(f => has(f, /\.ojn$/i))) log('这批是 O2Jam 文件（.ojn），请切到「O2Jam → osu!」tab。', 'w');
      else log('没有发现 .bms/.bme/.bml/.bmx 文件。', 'w');
      return;
    }
    const buckets = groupFiles(files);
    let added = 0, failed = 0;
    for (const [dir, list] of buckets){
      if (!list.some(f => has(f, /\.(bms|bme|bml|bmx)$/i))) continue;
      const song = await prepareSong(dir, list, { plate: $('bmsPlate').value, keys: keysOpt() });
      if (!song){ continue; }
      song.files = list;
      const dup = state.songs.find(s => s.dir === dir);
      if (dup) state.songs[state.songs.indexOf(dup)] = song;
      else state.songs.push(song);
      added++;
      failed += song.diffs.filter(d => d.error).length;
    }
    state.songs.sort((a, b) => (a.dir || '').localeCompare(b.dir || ''));
    render();
    const diffs = state.songs.reduce((a, s) => a + s.diffs.filter(d => d.parsed).length, 0);
    $('loadStat').innerHTML = '已载入 <b>' + state.songs.length + '</b> 首歌 / <b>' + diffs + '</b> 个难度'
      + (failed ? '，<b style="color:var(--err)">' + failed + '</b> 个文件解析失败' : '');
    log('载入完成：' + added + ' 首歌。', 's');
  }

  /* ---------- 列表 ---------- */
  const COLUMNS = ['', '乐曲名', '艺术家', '难度', '键数', '样本', '编码', '状态'];
  function render(){
    const tbl = $('tbl');
    if (!tbl) return;
    tbl.querySelector('thead').innerHTML = '<tr>' + COLUMNS.map(c => '<th>' + c + '</th>').join('') + '</tr>';
    const q = ($('filter').value || '').trim().toLowerCase();
    const tb = tbl.querySelector('tbody');
    tb.innerHTML = '';
    for (const s of state.songs){
      const ok = s.diffs.filter(d => d.parsed);
      const text = (s.title + ' ' + s.artist + ' ' + s.dir).toLowerCase();
      if (q && !text.includes(q)) continue;
      const tr = document.createElement('tr');
      const cbTd = document.createElement('td');
      const chk = document.createElement('input');
      chk.type = 'checkbox'; chk.checked = state.sel.has(s);
      chk.onchange = () => { chk.checked ? state.sel.add(s) : state.sel.delete(s); updateSelInfo(); renderPreview(s); };
      cbTd.appendChild(chk); tr.appendChild(cbTd);

      const diffTxt = ok.map(d => esc(d.name) + ' <span class="hint">Lv.' + (d.level || '?') + '</span>').join('<br>');
      const keys = [...new Set(ok.map(d => (d.layout ? layoutLabel(d.layout) : d.keys + 'K')))].join('/');
      const samp = ok.length ? ok[0].samples : 0;
      const enc = ok.length ? (ok[0].encoding || '-') : '-';
      tr.insertAdjacentHTML('beforeend',
        '<td>' + esc(s.title || s.dir) + '</td>' +
        '<td>' + esc(s.artist) + '</td>' +
        '<td class="diff">' + (diffTxt || '—') + '</td>' +
        '<td class="num">' + esc(keys) + '</td>' +
        '<td class="num">' + samp + '</td>' +
        '<td><span class="badge ' + (enc === 'utf-8' ? 'b-ok' : 'b-dim') + '">' + esc(String(enc).toUpperCase()) + '</span></td>' +
        '<td>' + (ok.length ? "<span class='badge b-ok'>可转换</span>" : "<span class='badge b-bad'>解析失败</span>") + '</td>');
      tr.onclick = (ev) => { if (ev.target.tagName !== 'INPUT'){ chk.checked = !chk.checked; chk.onchange(); } renderPreview(s); };
      tb.appendChild(tr);
    }
    updateSelInfo();
  }
  function updateSelInfo(){
    const n = state.sel.size;
    const d = [...state.sel].reduce((a, s) => a + s.diffs.filter(x => x.parsed).length, 0);
    $('selInfo').textContent = n ? ('已选中 ' + n + ' 首，共 ' + d + ' 个难度') : '未选中';
  }

  /* ---------- 预览 ---------- */
  function preview(s){
    if (!s) return;
    const d = s.diffs.find(x => x.parsed);
    if (!d){ $('preview').textContent = '（没有可解析的 BMS）'; return; }
    try {
      const built = buildChart(d.parsed, { layout: d.layout, plate: $('bmsPlate').value, stops: $('bmsStop').checked });
      const m = d.parsed.meta;
      const text = buildOsuText({
        header: { fileName: d.rel, bpm: m.bpm },
        chart: { level: d.level || 0, noteCount: built.hitObjects.length },
        meta: { title: (m.title + (m.subtitle ? ' ' + m.subtitle : '')).trim(), artist: m.artist,
                noter: m.subartist[0] || m.maker || m.artist, tags: 'preview',
                od: parseFloat($('od').value) || undefined, hp: parseFloat($('hp').value) || 8.2,
                diffName: ' ' + d.name, source: 'BMS', versionPrefix: '', circleSize: built.keys },
        timingPoints: built.timingPoints, hitObjects: built.hitObjects,
        audioFilename: 'preview.mp3', musicOffset: 0, coverName: '', stats: built.stats,
      });
      const rep = describeRepairs(built.stats);
      $('prevName').textContent = d.name + ' · ' + d.rel + (rep ? '　修正：' + rep : '');
      $('preview').textContent = text.split('\n').slice(0, 60).join('\n')
        + '\n… 共 ' + text.split('\n').length + ' 行 / ' + built.hitObjects.length + ' 个物件';
      updateSelInfo();
    } catch (e){ $('preview').textContent = '预览失败：' + e.message; }
  }

  /* ---------- 选项 ---------- */
  /** 键型选择：auto → null（按谱面内容猜），其余是列数 5/6/7/8/10/12/14/16 */
  function keysOpt(){
    const v = $('bmsKeys') ? $('bmsKeys').value : 'auto';
    return (!v || v === 'auto') ? null : Number(v);
  }
  function options(){
    const shared = shell.sharedOpts();
    return Object.assign({}, shared, {
      plate: $('bmsPlate').value,          // column | sample | drop
      keys: keysOpt(),
      stops: $('bmsStop').checked,
      repair: $('bmsLnfair').checked,
      random: randomOf(),
      diffs: [],                 // BMS：一个文件夹里的难度全转
    });
  }
  function randomOf(){
    const v = $('bmsRandom') ? $('bmsRandom').value : 'first';
    return v === 'first' ? 1 : (parseInt(v, 10) || 1);
  }

  /** 改了「皿 / 键型 / 随机分支」要重新解析（三者都发生在解析阶段） */
  async function reparse(){
    if (!state.songs.length) return;
    for (const s of state.songs){
      const fresh = await prepareSong(s.dir, s.files || [], { plate: $('bmsPlate').value, random: randomOf(), keys: keysOpt() });
      if (fresh){ fresh.files = s.files; Object.assign(s, fresh); }
    }
    render();
    log('已按新的皿/键型/随机分支设置重新解析 ' + state.songs.length + ' 首歌。', 's');
  }

  /* ---------- 转换 ---------- */
  async function convert(){
    const o = options();
    const list = [...state.sel].filter(s => s.diffs.some(d => d.parsed));
    if (!list.length){ alert('请先在列表里勾选要转换的歌。'); return; }
    const audioCtx = (o.audioMode !== 'none' && o.audioMode !== 'keysound')
      ? await shell.getAudioCtx(o.sampleRate) : null;

    shell.setBusy(true);
    let done = 0;
    const allFiles = [];
    const onProgress = (ev) => {
      if (typeof ev === 'number') return;
      if (ev && ev.phase === 'encode')
        shell.paint((done + 0.5 * ev.frac) / list.length, '转换中 ' + (done + 1) + '/' + list.length
          + '  编码中 ' + Math.round(ev.frac * 100) + '%');
    };
    shell.useFfmpegBackend();
    for (const s of list){
      $('goInfo').textContent = '转换中 ' + (done + 1) + '/' + list.length + '：' + (s.title || s.dir);
      shell.paint(done / list.length);
      log('── ' + (s.title || s.dir) + '（' + s.dir + '）──');
      try {
        const res = await convertBmsSong(s, o, audioCtx, onProgress);
        for (const w of res.warnings) log('  ⚠ ' + w, 'w');
        if (res.preview){
          $('prevName').textContent = res.preview.name;
          $('preview').textContent = res.preview.text.split('\n').slice(0, 60).join('\n');
        }
        const folder = '[_BMS_] ' + sanitizeFilename((s.artist ? s.artist + ' - ' : '') + (s.title || 'BMS'));
        if (o.zipPerSong){
          const blob = new Blob(makeZipChunks(res.files.map(f => ({ name: f.name, data: f.data }))),
            { type: 'application/zip' });
          shell.download(blob, folder + '.osz', 'application/zip');
          log('  ✅ 打包 ' + folder + '.osz（' + res.files.length + ' 个文件）', 's');
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
    shell.info('完成：' + done + ' 首 / ' + allFiles.length + ' 个文件');
    log('═══ 全部完成 ═══', 's');
  }

  const mode = {
    id: 'bms',
    label: 'BMS → osu!',
    hint: 'BMS：一个文件夹 = 一首歌，每个 .bms 一个难度',
    acceptHint: 'BMS（.bms/.bme/.bml/.bmx + 同目录样本；也支持 .zip 直读）',

    init(sh){
      shell = sh;
      for (const id of ['bmsKeys','bmsLnfair','bmsStop','hp','server','audioMode',
                        'rate','audioFormat','mp3Kbps','normalize','od','tagMode','tagTemplate','zipPerSong'])
        $(id).addEventListener('change', () => { if (state.sel.size) preview([...state.sel][0]); });
      for (const id of ['bmsPlate','bmsKeys','bmsRandom']) $(id).addEventListener('change', () => { reparse(); });
      $('tagMode').addEventListener('change', () => { $('tagTemplate').disabled = $('tagMode').value === 'keep'; });
      render();
    },

    intake: addFiles,
    render,
    activate: render,
    selectAll(){ state.songs.forEach(s => state.sel.add(s)); render(); },
    selectNone(){ state.sel.clear(); render(); },
    clear(){ state.songs = []; state.sel.clear(); render(); $('loadStat').textContent = ''; log('已清空。'); },
    preview,
    options,
    convert,
  };
  return mode;
}

export function initUI(shell){ return createBmsPanel().init(shell); }
