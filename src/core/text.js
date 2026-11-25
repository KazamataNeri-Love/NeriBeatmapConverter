// 编码检测 / 解码
// 由 o2jam2osu.html 的单文件脚本拆分而来（逻辑未改动；从 @/ 分节 1）

/* =====================================================================
   1. 编码检测 / 解码
   —— 原版用 Mozilla chardet，短串常被猜成 ISO-8859-1 → 乱码。
   这里：先试严格 UTF-8；否则在候选编码里按「中日韩高频字打分」选最优。
   ===================================================================== */
/* 关键发现：O2Jam 的文本字段统一用 **GBK/CP936**，**连日文也是 GBK**。
   同一个字串 d6f1 c8a1 ef77 cfe8：
     gb18030 → "竹取飛翔"    ← 正确
     euc-kr  → "賂혤\ufffdw勸"（谚文 + 替换字）
     shift_jis → "ﾖ｡ﾏ"（半角片假名 —— GBK 字节被当成 Shift-JIS 的典型特征）
     big5    → "罣鵁矧"（同是汉字，但字不对）
   所以评分要给「真实高频字」高权重，并对乱码特征重罚，平局时优先 GB18030。 */
const ENC_CANDIDATES = ["gb18030","euc-kr","shift_jis","big5","windows-1252"];
const FREQ = new Set();
(function buildFreq(){
  const blocks = [
    // 中文高频字
    "的一是不了在人有我他这中大来上国到说们为子和地出也时年得就那要下以生会自着去之过家"+
    "学对可里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所"+
    "见经头面公同三已老从动两长知民样西被但先次些何问最外名提真高间道让比因力点",
    // 韩文高频音节
    "이다는의에가을를은로하고한지어스리니사아세요기수만되신중일들그저정상사람시간나라말것있없"+
    "문더안못때밤꿈사랑노래세상새로운우리마음눈물하늘바람",
    // 日文高频假名
    "のにをたでがとしてするーりあいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ"+
    "まみむめもやゆよらるれろわんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ",
  ];
  for(const b of blocks) for(const ch of b) FREQ.add(ch);
})();

function scoreText(text){
  let total = 0;
  for(const ch of text){
    const o = ch.codePointAt(0);
    if(o === 0xFFFD){ total -= 20; continue; }                     // 替换字符：这个编码解不出来
    if(o < 0x20 || (o >= 0xE000 && o <= 0xF8FF)){ total -= 20; continue; }
    if(FREQ.has(ch)){ total += 8; continue; }                      // 真实高频字：最强信号
    if(o >= 0x3040 && o <= 0x30FF){ total += 4; continue; }        // 假名（GBK 里也含假名 → “GBK 日文”）
    if(o >= 0xFF61 && o <= 0xFF9F){ total -= 8; continue; }        // 半角片假名 = 被误当成 Shift-JIS
    if(o >= 0x4E00 && o <= 0x9FFF){ total += 2; continue; }        // 汉字
    if(o >= 0xAC00 && o <= 0xD7A3){ total += 2; continue; }        // 谚文音节
    if((o >= 0x3000 && o <= 0x303F) || (o >= 0xFF00 && o <= 0xFFEF)){ total += 1; continue; }
    // 其余（拉丁扩展等）不加分
  }
  return total;
}
function decodeWith(bytes, enc){
  try { return new TextDecoder(enc, {fatal:false}).decode(bytes); } catch(e){ return null; }
}
function isStrictUtf8(bytes){
  try { new TextDecoder("utf-8", {fatal:true}).decode(bytes); return true; } catch(e){ return false; }
}
/** 在一组样本上选出最像真实文本的编码（整包统计远比单条准）。forced 可强制指定。 */
function detectEncoding(samples, forced){
  if(forced && forced !== "auto") return {encoding:forced, scores:{}, forced:true};
  const nonAscii = samples.filter(b => b && b.some(x => x >= 0x80));
  if(!nonAscii.length) return {encoding:"utf-8", scores:{}};
  const scores = {};
  let charCount = 0;
  for(const enc of ENC_CANDIDATES){
    let s = 0, bad = false;
    for(const raw of nonAscii){
      const t = decodeWith(raw, enc);
      if(t === null){ bad = true; break; }
      s += scoreText(t);
      if(enc === "gb18030") charCount += t.length;
    }
    scores[enc] = bad ? -1e6 : s;
  }
  const entries = Object.entries(scores).sort((a,b) => b[1] - a[1]);
  let encBest = entries[0][0];
  // windows-1252 是“每个字节都是字符”的兜底项，短样本时经常蒙对分。O2Jam 是 GBK 系，
  // 只要任何一个中日韩编码解得通，就不该选 windows-1252（否则标题会变成 ½ðæ 这种乱码）。
  if(encBest === "windows-1252"){
    const cjk = entries.find(([e, s]) => e !== "windows-1252" && s > -1e6);
    if(cjk) encBest = cjk[0];
  }
  // 平局/接近时优先 GB18030：O2Jam 几乎所有服务器（含日文标题）都是 GBK 系
  const margin = Math.max(6, charCount * 0.06);
  if(scores["gb18030"] !== undefined && scores["gb18030"] >= scores[encBest] - margin) encBest = "gb18030";
  return {encoding:encBest, scores, margin, chars:charCount};
}
/** 单条文本解码：严格 UTF-8 优先，否则用整包选出的编码。顺带去掉尾部填充空格
    （OJN 的字段是定长空格填充的，原版会把 "BeautifulDay  " 原样写进 Title 和文件名）*/
function makeTextDecoder(packEncoding){
  return function decode(rawBytes){
    let zero = rawBytes.indexOf(0);                       // 截到 \0（对齐 ByteHelper.toString）
    const bytes = zero >= 0 ? rawBytes.subarray(0, zero) : rawBytes;
    if(!bytes.length) return "";
    if(packEncoding !== "utf-8" && bytes.some(b => b >= 0x80) && isStrictUtf8(bytes))
      return new TextDecoder("utf-8").decode(bytes).trim();   // 混排包里的单条 UTF-8
    return (decodeWith(bytes, packEncoding) || decodeWith(bytes, "windows-1252") || "").trim();
  };
}

export { ENC_CANDIDATES, FREQ, decodeWith, detectEncoding, isStrictUtf8, makeTextDecoder, scoreText };
