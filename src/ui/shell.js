// 多模式外壳：tab 切换 + 共用控件（选曲、通用选项、列表壳、转换/日志/预览）
//
// 设计边界（很重要）：
//   · 外壳只做「不随来源变化的事」：拖入分诊、共用选项、列表容器、进度、日志、下载、编码器探测。
//   · 每个模式（modes/xxx/panel.js）自己决定：接受哪些扩展名、自己的选项、列表列、怎么转。
//   · .osu 文本只有 core/osu/writer.js 能拼；模式只产出数据。
//
// 为什么不用多页面：编码器后端（encoders/index.js 的 BACKENDS）是模块级全局，
// 多页面会各注册一份、行为还不一致；单页 tab 能保证「探测一次、全模式共用」。

import { log } from '../core/util.js';
import { AUDIO_FORMATS, MP3_BITRATES, formatById, lameReady, setLameCodec } from '../core/encoders/index.js';
import { probeFfmpegBackend, registerFfmpegHttpEncoder, unregisterFfmpegBackends } from '../core/encoders/ffmpeg-http.js';
import { expandArchives } from '../core/unzip.js';

// 告诉 index.html 里那段「经典脚本」：模块已经进来了，不要弹「必须用 http 打开」的提示。
// 放在模块顶层的副作用里 —— 只要能执行到这一行，说明模块图没被 CORS 拦住。
if (typeof window !== 'undefined') window.__MANIA_HUB_BOOTED = true;

function esc(s){ return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

export function createShell(){
  const $ = (id) => document.getElementById(id);
  const modes = new Map();
  let activeId = null;
  let audioCtx = null;
  let ffBackend = { available: false, error: '还没探测' };
  let ffRegistered = false;
  let lastPaint = 0;

  /* ---------- 共用小工具 ---------- */
  function paint(frac, text){
    const t = performance.now();
    if (t - lastPaint < 80 && frac < 1) return;
    lastPaint = t;
    const bar = $('bar');
    if (bar && bar.firstElementChild) bar.firstElementChild.style.width = Math.min(100, frac * 100) + '%';
    if (text) $('goInfo').textContent = text;
  }
  function info(text){ const el = $('goInfo'); if (el) el.textContent = text; }
  function setBusy(on){ const b = $('go'); if (b) b.disabled = !!on; }
  function download(data, filename, mime){
    const blob = (data instanceof Blob) ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }
  /** 取共用的 AudioContext（采样率跟随「采样率」下拉） */
  async function getAudioCtx(rate){
    if (!audioCtx){
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate });
      if (audioCtx.state === 'suspended') await audioCtx.resume();
    }
    return audioCtx;
  }
  /** 通用选项（所有模式共用；模式自己的选项由模式自己读） */
  function sharedOpts(){
    const val = (id, d) => { const el = $(id); return el ? el.value : d; };
    const num = (id, d) => { const v = parseFloat(val(id, '')); return isFinite(v) ? v : d; };
    const chk = (id) => { const el = $(id); return el ? el.checked : false; };
    const odRaw = String(val('od', '')).trim();
    return {
      od: odRaw === '' ? NaN : parseFloat(odRaw),
      hp: num('hp', 8.2),
      serverTag: String(val('server', '')).trim(),
      encoding: val('encoding', 'auto'),
      audioMode: val('audioMode', 'per-diff'),
      audioFormat: val('audioFormat', 'mp3'),
      mp3Kbps: parseInt(val('mp3Kbps', '320'), 10) || 320,
      normalize: chk('normalize'),
      sampleRate: parseInt(val('rate', '44100'), 10) || 44100,
      zipPerSong: chk('zipPerSong'),
      tagMode: val('tagMode', 'keep'),
      tagTemplate: String(val('tagTemplate', '')).trim(),
    };
  }

  /* ---------- 编码器后端（ffmpeg / lamejs） ---------- */
  function syncEncoderBackend(){
    const box = $('useFfmpeg');
    const want = !!(ffBackend.available && box && box.checked);
    if (want && !ffRegistered){ registerFfmpegHttpEncoder(''); ffRegistered = true; }
    if (!want && ffRegistered){ unregisterFfmpegBackends(); ffRegistered = false; }
    return want;
  }
  function showFfmpegState(){
    const el = $('ffmpegState'), box = $('useFfmpeg');
    if (!el) return;
    if (ffBackend.available){
      el.textContent = '✓ 本地 ffmpeg 可用：MP3 由 ffmpeg 编码（快约 10 倍）'
        + (ffBackend.encoders && ffBackend.encoders.length ? '（' + ffBackend.encoders.join('/') + '）' : '');
      el.className = 'hint ok';
    } else {
      el.textContent = '本地 ffmpeg 不可用（' + (ffBackend.error || '未知') + '）→ 用内置 lamejs；想要快就确保用 npm start 启动，且机器上装了 ffmpeg';
      el.className = 'hint warn';
      if (box){ box.checked = false; box.disabled = true; }
    }
  }
  function initEncoders(){
    if (typeof globalThis.lamejs !== 'undefined') setLameCodec(globalThis.lamejs);
    const fmtSel = $('audioFormat'), brSel = $('mp3Kbps');
    if (fmtSel){
      const f0 = formatById('mp3');
      fmtSel.innerHTML = AUDIO_FORMATS.filter(f => !f.nodeOnly).map(f =>
        '<option value="' + f.id + '"' + (f.id === 'mp3' ? ' selected' : '') + '>' + esc(f.label) + '</option>').join('');
      brSel.innerHTML = MP3_BITRATES.map(k =>
        '<option value="' + k + '"' + (k === f0.defaultBitrate ? ' selected' : '') + '>' + k + '</option>').join('');
      const sync = () => {
        const f = formatById(fmtSel.value);
        brSel.disabled = !f.bitrates.length;
        const brWrap = $('brWrap'); if (brWrap) brWrap.style.opacity = f.bitrates.length ? '1' : '0.4';
      };
      fmtSel.addEventListener('change', sync);
      sync();
    }
    log(lameReady() ? 'MP3 编码器就绪（lamejs，纯 JS）'
                    : 'MP3 编码器未加载：选 MP3 时会回退到 WAV（确认 vendor/lamejs/lame.min.js 存在）',
        lameReady() ? 's' : 'w');
  }

  /* ---------- 模式注册 / 切换 ---------- */
  function registerMode(mode){
    modes.set(mode.id, mode);
    if (mode.hint){
      const tab = document.querySelector('.mode-tab[data-mode="' + mode.id + '"]');
      if (tab) tab.title = mode.hint;
    }
  }
  function setMode(id){
    const m = modes.get(id);
    if (!m) return;
    activeId = id;
    for (const mid of modes.keys()){
      const el = $('panel-' + mid);
      if (el) el.classList.toggle('active', mid === id);
      const tab = document.querySelector('.mode-tab[data-mode="' + mid + '"]');
      if (tab) tab.classList.toggle('active', mid === id);
    }
    if (location.hash !== '#/' + id) history.replaceState(null, '', '#/' + id);
    const hint = $('dropHint');
    if (hint && m.acceptHint) hint.textContent = '当前模式：' + m.acceptHint;
    if (!m._inited){ m._inited = true; m.init(api); }
    else if (m.activate) m.activate();
    else m.render();
    log('模式：' + m.label, 's');
  }

  const api = {
    $, esc, log, paint, info, setBusy, download, getAudioCtx, sharedOpts,
    useFfmpegBackend: syncEncoderBackend,
    setMode,
    active: () => modes.get(activeId),
    ffmpegReady: () => ffBackend.available,
  };

  /* ---------- 页面级接线（只做一次） ---------- */
  function boot(){
    initEncoders();

    // tab
    for (const tab of document.querySelectorAll('.mode-tab')){
      const id = tab.dataset.mode;
      if (modes.has(id)) tab.onclick = () => setMode(id);
      else { tab.disabled = true; tab.textContent += '（接入中）'; }
    }

    // 选曲：拖入 / 选文件 / 选文件夹 → 交给当前模式分诊
    const pickFiles = $('pickFiles'), pickDir = $('pickDir'), fileInput = $('fileInput'), dirInput = $('dirInput');
    const drop = $('drop');

    /** 拖进来的 .zip 就地摊平成虚拟文件（不解压到磁盘、不需要解压权限） */
    async function expandIfZip(fileList){
      const list = Array.from(fileList || []);
      const heavy = list.filter(f => /\.(rar|7z)$/i.test(f.name || ''));
      if (heavy.length)
        log('  ⚠ 浏览器里只能直读 .zip；这 ' + heavy.length + ' 个 .rar/.7z 请用命令行'
            + '（会自动调用 7-Zip / WinRAR），或先解压再拖入', 'w');
      const usable = list.filter(f => !/\.(rar|7z)$/i.test(f.name || ''));
      const zips = usable.filter(f => /\.zip$/i.test(f.name || ''));
      if (!zips.length) return usable;
      log('展开 ' + zips.length + ' 个压缩包（内存里读，不落地）…');
      const r = await expandArchives(usable);
      for (const w of r.warnings) log('  ⚠ ' + w, 'w');
      for (const a of r.archives)
        log('  压缩包 ' + a.name + '：' + a.files + ' 个文件（' + (a.bytes / 1048576).toFixed(1) + ' MB）', 's');
      if (!r.archives.length) log('  ⚠ 没有成功展开任何压缩包', 'w');
      return r.files;
    }

    /** 统一入口：先摊平 .zip，再交给当前模式（也暴露在 api 上，方便自动化测试） */
    async function intakeFiles(files){
      const m = modes.get(activeId);
      if (!m || !m.intake) return;
      await m.intake(await expandIfZip(files));
    }
    const handOff = intakeFiles;
    api.intakeFiles = intakeFiles;
    if (pickFiles) pickFiles.onclick = () => fileInput.click();
    if (pickDir) pickDir.onclick = () => dirInput.click();
    if (fileInput) fileInput.onchange = (e) => handOff(e.target.files);
    if (dirInput) dirInput.onchange = (e) => handOff(e.target.files);
    if ($('clearAll')) $('clearAll').onclick = () => { const m = modes.get(activeId); if (m && m.clear) m.clear(); };

    if (drop){
      ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hot'); }));
      ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hot'); }));
      drop.addEventListener('drop', async (e) => {
        const items = e.dataTransfer.items;
        if (items && items.length && items[0].webkitGetAsEntry){
          const files = [];
          const walkEntry = async (entry) => {
            if (entry.isFile) files.push(await new Promise(res => entry.file(res)));
            else if (entry.isDirectory){
              const reader = entry.createReader();
              const entries = await new Promise(res => reader.readEntries(res));
              for (const en of entries) await walkEntry(en);
            }
          };
          for (const it of items){ const en = it.webkitGetAsEntry(); if (en) await walkEntry(en); }
          await handOff(files);
        } else await handOff(e.dataTransfer.files);
      });
    }

    // 列表工具条：一律转给当前模式
    const call = (name) => { const m = modes.get(activeId); if (m && m[name]) m[name](); };
    if ($('selAll')) $('selAll').onclick = () => call('selectAll');
    if ($('selNone')) $('selNone').onclick = () => call('selectNone');
    if ($('filter')) $('filter').oninput = () => call('render');

    // 转换
    if ($('go')) $('go').onclick = async () => {
      const m = modes.get(activeId);
      if (!m) return;
      await m.convert();
    };

    // ffmpeg 探测（一次，全模式共用同一个后端注册表）
    probeFfmpegBackend({}).then(r => {
      ffBackend = r;
      showFfmpegState();
      log(r.available ? '本地 ffmpeg 接口可用 → MP3/OGG 会交给它编码（' + (r.version || '') + '）'
                      : '本地 ffmpeg 不可用（' + r.error + '）→ 用内置 lamejs', r.available ? 's' : 'w');
    });
  }

  return { api, boot, registerMode, setMode };
}

/** 浏览器入口：注册所有模式并启动外壳 */
export async function bootShell(){
  const shell = createShell();
  // 把脚本错误也写进日志面板：否则页面「看起来能动但什么都不发生」，排查得开控制台
  if (typeof window !== 'undefined'){
    window.addEventListener('error', e => { try { log('脚本错误：' + (e.message || e.error), 'e'); } catch (x){} });
    window.addEventListener('unhandledrejection', e => {
      try { log('未处理异常：' + ((e.reason && e.reason.message) || e.reason), 'e'); } catch (x){}
    });
  }
  const [{ createO2JamPanel }, { createBmsPanel }] = await Promise.all([
    import('../modes/o2jam/panel.js'),
    import('../modes/bms/panel.js'),
  ]);
  shell.registerMode(createO2JamPanel());
  shell.registerMode(createBmsPanel());
  shell.boot();
  // 调试/自动化钩子：控制台里 __HUB__.api.active() 能拿到当前模式对象
  if (typeof window !== 'undefined') window.__HUB__ = shell;
  const want = (location.hash || '').replace(/^#\//, '');
  shell.setMode(modesHas(shell, want) ? want : 'o2jam');
  if (location.hash === '') history.replaceState(null, '', '#/o2jam');
  log('就绪：拖入谱面文件或整个歌曲文件夹即可。', 's');
  log('提示：本工具对编码做了整包统计，同一文件夹里混排 UTF-8 与 GBK 也能正确解码。');
  return shell;
}
function modesHas(shell, id){
  return id === 'o2jam' || id === 'bms';
}

export { esc };

// 浏览器里自动启动（ES 模块必须经 http 加载：npm start）
if (typeof document !== 'undefined'){
  const start = () => { bootShell().catch(e => console.error(e)); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
