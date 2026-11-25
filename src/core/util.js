// 基础工具
// 由 o2jam2osu.html 的单文件脚本拆分而来（逻辑未改动；从 @/ 分节 0）

/* =====================================================================
   0. 基础工具
   ===================================================================== */
const OJN_SIGNATURE = 0x006E6A6F;      // "ojn\0"
const OJX_MAGIC = [0x4F, 0x4A, 0x58, 0x31]; // "OJX1"
const GENRES = ["Ballad","Rock","Dance","Techno","Hip-hop","Soul/R&B","Jazz","Funk","Classical","Traditional","Etc"];
const COLUMN_X = [36,109,182,255,328,401,474];
const HOLD_OPEN = -1;                  // 等待 RELEASE 的 LN（对应原版 endTime = -1）
const SHORT_NOTE = -2147483648;        // 原版 Integer.MIN_VALUE 代表短音
const DIFFS = [
  {name:"EX", enum:"EASY",   fileSuffix:" (EX)", verSuffix:" (EX)"},
  {name:"NX", enum:"NORMAL", fileSuffix:" (NX)", verSuffix:" (NX)"},
  {name:"HX", enum:"HARD",   fileSuffix:"",      verSuffix:" (HX)"},
];

const logEl = () => (typeof document !== "undefined" ? document.getElementById("log") : null);
/* 日志接收器：Node 命令行工具（tools/cli.js）装上它就能把每首谱的日志归到那首谱的报告里，
   而不是直接刷屏幕（否则并行处理时日志会交错得没法看）。浏览器不装，行为与以前完全一样。 */
let logSink = null;
function setLogSink(fn){ logSink = fn; }
function log(msg, cls){
  if(logSink){ logSink(msg, cls); return; }
  const el = logEl();
  if(!el){
    // 浏览器里一定有 #log；Node 工具（diag-*）里没有 → 需要时用 OJN_VERBOSE_LOG=1 打开输出
    if(cls === "e") console.error(msg);
    else if(typeof process !== "undefined" && process.env && process.env.OJN_VERBOSE_LOG) console.log(msg);
    return;
  }
  const div = document.createElement("div");
  if(cls) div.className = cls;
  div.textContent = msg;
  el.appendChild(div); el.scrollTop = el.scrollHeight;
}
function sanitizeFilename(s){ return String(s).replace(/[/:"*?<>|\\]/g, "").replace(/\s+$/,"").trim(); }
function pad(n, w){ return String(n).padStart(w, "0"); }

export { COLUMN_X, DIFFS, GENRES, HOLD_OPEN, OJN_SIGNATURE, OJX_MAGIC, SHORT_NOTE, log, logEl, pad,
         sanitizeFilename, setLogSink };
