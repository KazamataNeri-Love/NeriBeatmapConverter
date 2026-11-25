#!/usr/bin/env node
// 把多模块项目打成「一个 HTML」：dist/hub.html
//
// 为什么需要它：ES 模块（<script type="module"> + import）在 file:// 下会被浏览器
// 以 CORS 拦掉（origin 'null'），双击 index.html 等于整页脚本不执行。
// 这个打包器把每个模块包进一个极小的注册表（__def/__req），把 import/export
// 改写成该注册表的调用，最后内联 vendor/lamejs —— 产物是**经典脚本**，
// 双击、微信传、放 U 盘都能直接跑（代价：本地 ffmpeg 加速不可用，自动退回 lamejs）。
//
// 只支持本项目实际用到的语法：具名 import、具名 export、`export * from`、
// `export * as ns from`、以及 shell.js 里那两行动态 import()。遇到别的形态会构建失败（宁可报错不产坏包）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(TOOLS, '..');
const SRC = path.join(PROJ, 'src');
const ENTRY = 'ui/shell.js';
const OUT_DIR = path.join(PROJ, 'dist');
const OUT_FILE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(OUT_DIR, 'hub.html');

const posix = (p) => p.split(path.sep).join('/');

function walkJs(dir, out = []){
  for (const e of fs.readdirSync(dir, { withFileTypes: true })){
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (/\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 把相对 specifier 解析成「相对 src 的 posix id」 */
function resolveId(fromId, spec){
  const fromDir = fromId.includes('/') ? fromId.slice(0, fromId.lastIndexOf('/')) : '';
  const parts = (fromDir ? fromDir.split('/') : []).concat(spec.split('/'));
  const stack = [];
  for (const seg of parts){
    if (seg === '.' || seg === '') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}

/** 单文件变换：import/export → 注册表；返回 { id, code, deps } */
function transform(id, src){
  const deps = new Set();
  let code = src;
  const exprs = [];          // [公开名, 表达式]

  // export * as ns from '...'（要先于 export * 处理）
  code = code.replace(/export\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]\s*;?/g, (m, ns, spec) => {
    const dep = resolveId(id, spec); deps.add(dep);
    exprs.push([ns, `__req(${JSON.stringify(dep)})`]);
    return '';
  });

  // export * from '...'
  code = code.replace(/export\s*\*\s*from\s*['"]([^'"]+)['"]\s*;?/g, (m, spec) => {
    const dep = resolveId(id, spec); deps.add(dep);
    return `Object.assign(__exp, __req(${JSON.stringify(dep)}));`;
  });

  // import { a, b as c } from '...'
  code = code.replace(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g, (m, names, spec) => {
    const dep = resolveId(id, spec); deps.add(dep);
    const mapped = names.split(',').map(s => s.trim()).filter(Boolean)
      .map(s => s.replace(/\s+as\s+/, ': ')).join(', ');
    return `const { ${mapped} } = __req(${JSON.stringify(dep)});`;
  });

  // 动态 import('...')
  code = code.replace(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, (m, spec) => {
    if(!spec.startsWith('.')) return m;   // 裸模块（node:zlib 等）原样保留：只在 Node 分支里执行
    const dep = resolveId(id, spec); deps.add(dep);
    return `Promise.resolve(__req(${JSON.stringify(dep)}))`;
  });

  // export { a, b as c };（可跨行）
  code = code.replace(/export\s*\{([^}]*)\}\s*;?/g, (m, names) => {
    for (const raw of names.split(',').map(s => s.trim()).filter(Boolean)){
      const mm = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(raw);
      if (!mm) throw new Error(`${id}: 不认识的 export 形态 "${raw}"`);
      exprs.push([mm[2] || mm[1], mm[1]]);
    }
    return '';
  });

  // export function / export async function
  code = code.replace(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/g, (m, asyncKw, name) => {
    exprs.push([name, name]);
    return `${asyncKw || ''}function ${name}`;
  });

  // export const / let / var
  code = code.replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (m, kw, name) => {
    exprs.push([name, name]);
    return `${kw} ${name}`;
  });

  const leftover = code.match(/^\s*(?:import|export)\b/m);
  if (leftover) throw new Error(`${id}: 还有没处理掉的模块语法 → ${leftover[0].trim()}`);

  const tail = exprs.map(([pub, expr]) => `__exp[${JSON.stringify(pub)}] = ${expr};`).join('\n');
  return { id, code: code + '\n' + tail + '\n', deps };
}

/* ---------------- 构建 ---------------- */
const files = walkJs(SRC);
const mods = [];
const seen = new Set();
for (const abs of files){
  const id = posix(path.relative(SRC, abs));
  const t = transform(id, fs.readFileSync(abs, 'utf8'));
  mods.push(t);
  seen.add(id);
}
// 入口与依赖必须都在
const allIds = new Set(mods.map(m => m.id));
for (const m of mods) for (const d of m.deps) if (!allIds.has(d)) throw new Error(`${m.id}: 依赖不存在 ${d}`);
if (!allIds.has(ENTRY)) throw new Error('入口不存在：' + ENTRY);

const src = fs.readFileSync(path.join(PROJ, 'index.html'), 'utf8');
const lame = fs.readFileSync(path.join(PROJ, 'vendor/lamejs/lame.min.js'), 'utf8');
const safeInline = (s) => s.replace(/<\/script/gi, '<\\/script');

const moduleText = mods.map(m =>
  `__def(${JSON.stringify(m.id)}, function(__exp, __req){\n${m.code}\n});`
).join('\n');

const bundle = `<script>
/* ===== 本地化的 MP3 编码器（vendor/lamejs/lame.min.js 原样内联）===== */
${safeInline(lame)}
</script>
<script>
/* ===== 极简模块注册表：把 ES 模块换成经典脚本，使 file:// 下也能跑 ===== */
(function(){
  var __defs = {}, __cache = {};
  window.__def = function(id, fn){ __defs[id] = fn; };
  window.__req = function(id){
    if (__cache[id]) return __cache[id];
    var exp = {}; __cache[id] = exp;              // 先入缓存：容忍循环依赖
    var fn = __defs[id];
    if (!fn) throw new Error('module not found: ' + id);
    fn(exp, window.__req);
    return exp;
  };
})();
${moduleText}
/* 入口：ui/shell.js 自己在 DOMContentLoaded 里启动 */
window.__req(${JSON.stringify(ENTRY)});
</script>`;

// 替换掉 index.html 尾部那两个 script（vendor + type=module）
const marker = '<script src="./vendor/lamejs/lame.min.js"></script>';
const modScript = '<script type="module" src="./src/ui/shell.js"></script>';
if (!src.includes(marker) || !src.includes(modScript))
  throw new Error('index.html 结构与预期不符（找不到 vendor/module 两个 script 标签）');
let html = src.replace(marker + '\n' + modScript, bundle);
if (html.includes('type="module"')) throw new Error('产物里还有 type="module"（会被 file:// 拦）');

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, html, 'utf8');

// 自检：产物里不应再有模块语法残留
const leftoverInHtml = html.match(/^\s*(?:import\s|\s*export\s)/m);
if (leftoverInHtml) throw new Error('产物里仍有模块语法：' + leftoverInHtml[0].trim());

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`打包完成：${path.relative(PROJ, OUT_FILE)}（${kb(Buffer.byteLength(html))}）`);
console.log(`  模块 ${mods.length} 个 · 入口 ${ENTRY}`);
console.log('  用法：直接双击 dist/hub.html（不需要 node、不需要 http 服务）');
