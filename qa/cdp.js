/* CDP 驱动 WebView：精确执行 JS，绕开触屏坐标换算 */
const http = require('http');

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (r) => {
      let s = '';
      r.on('data', (d) => (s += d));
      r.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const port = process.env.CDP_PORT || '9222';
  const expr = process.env.CDP_EXPR;
  const waitMs = parseInt(process.env.CDP_WAIT || '0', 10);

  const targets = await getJson(port, '/json');
  const page = targets.find((t) => t.type === 'page' && /appassets|file/.test(t.url));
  if (!page) { console.error('未找到 WebView 页面: ' + JSON.stringify(targets.map(t => t.url))); process.exit(2); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true
  });
  const v = r.result && r.result.result ? r.result.result : r.result;
  console.log(JSON.stringify(v.value !== undefined ? v.value : v, null, 2));
  if (waitMs > 0) await sleep(waitMs);
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('CDP 失败: ' + e.message); process.exit(1); });
