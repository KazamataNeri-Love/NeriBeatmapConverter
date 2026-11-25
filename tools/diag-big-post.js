// 排查：大请求体（浏览器上传整首 PCM 会有几十 MB）为什么会被 reset。
// 用 http.request 和 fetch 两种客户端分别打，看是客户端库的问题还是服务器的问题。
import http from 'node:http';

const baseUrl = new URL(process.argv[2] || 'http://localhost:5183');
const base = baseUrl.origin;                 // 注意：URL 对象转字符串会带根路径的斜杠，拼出 '//api/...' 变成 404
const sizes = (process.argv[3] || '10,30,60,120,240').split(',').map(Number);

function postHttp(bytes) {
  return new Promise((resolve) => {
    const body = Buffer.alloc(bytes);
    const t0 = Date.now();
    const req = http.request({ host: base.hostname, port: base.port,
      path: '/api/encode?format=mp3&bitrate=320&rate=44100', method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } }, (res) => {
      let n = 0;
      res.on('data', c => { n += c.length; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, got: n, ms: Date.now() - t0 }));
      res.on('error', e => resolve({ ok: false, err: 'res:' + e.code, ms: Date.now() - t0 }));
    });
    req.on('error', e => resolve({ ok: false, err: 'req:' + e.code, ms: Date.now() - t0 }));
    // 分块写，模拟浏览器的流式上传
    let p = 0;
    const CH = 1 << 22;
    const pump = () => {
      while (p < body.length) {
        const n = Math.min(CH, body.length - p);
        const ok = req.write(body.subarray(p, p + n));
        p += n;
        if (!ok) { req.once('drain', pump); return; }
      }
      req.end();
    };
    pump();
  });
}

async function postFetch(bytes) {
  const body = new Uint8Array(bytes);
  const t0 = Date.now();
  try {
    const r = await fetch(base + '/api/encode?format=mp3&bitrate=320&rate=44100', { method: 'POST', body });
    const b = await r.arrayBuffer();
    return { ok: true, status: r.status, got: b.byteLength, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, err: (e.cause && e.cause.code) || e.message, ms: Date.now() - t0 };
  }
}

console.log('秒数   请求体     http.request            fetch');
console.log('-'.repeat(72));
for (const sec of sizes) {
  const bytes = sec * 44100 * 8;
  const a = await postHttp(bytes);
  const b = await postFetch(bytes);
  const f = (r) => r.ok ? `OK ${r.status} ${(r.got / 1048576).toFixed(1)}MB ${r.ms}ms` : `✗ ${r.err} ${r.ms}ms`;
  console.log(String(sec).padStart(5) + ' ' + String((bytes / 1048576).toFixed(0) + 'MB').padStart(9)
    + '  ' + f(a).padEnd(24) + ' ' + f(b));
}
