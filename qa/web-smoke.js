'use strict';
/* ============================================================
 * 安卓端 Web UI 离线冒烟测试
 *
 * 本机没有安卓模拟器/真机，无法直接运行 APK。本脚本用 Electron
 * （与 Android WebView 同为 Chromium 内核）加载**安卓工程里的**
 * assets/web/index.html，配合 mock 版 AndroidHost，
 * 验证以下链路是否真的能跑通：
 *
 *   index.html → mobile-bridge.js（建立 window.lmc）
 *              → renderer.js 的 init() 链
 *              → 各接口返回值 → 界面渲染
 *
 * 用法:  node_modules/.bin/electron qa/web-smoke.js
 * 产物:  qa/out/android-web-smoke.png + 控制台报告
 * ============================================================ */
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_DIR = path.resolve(__dirname, '../app/src/main/assets/web');
const OUT_DIR = path.resolve(__dirname, 'out');
const SHOT = path.join(OUT_DIR, 'android-web-smoke.png');
const WAIT_MS = Number(process.env.SMOKE_WAIT_MS || 7000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

const logs = [];
const errors = [];

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const file = path.join(WEB_DIR, rel);
      // 防目录穿越（仅测试用途，仍按生产标准写）
      if (!path.resolve(file).startsWith(path.resolve(WEB_DIR)) ||
          !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
      });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

(async () => {
  await app.whenReady();
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const srv = await startServer();
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}/index.html`;

  // 横屏手机比例：与 AndroidManifest 里的 landscape 保持一致
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    backgroundColor: '#0f1116',
    webPreferences: {
      preload: path.join(__dirname, 'web-preload.js'),
      contextIsolation: false,   // 仅测试环境：让 preload 能直接触达页面里的 __xlcResolve
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['debug', 'info', 'warn', 'error'][level] || String(level);
    const line1 = `[${tag}] ${message}  @${path.basename(sourceId || '')}:${line}`;
    logs.push(line1);
    if (level >= 2) errors.push(line1);
  });

  win.webContents.on('did-fail-load', (_e, code, desc, u) => {
    errors.push(`[load] ${code} ${desc} ${u}`);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    errors.push('[crash] 渲染进程退出: ' + JSON.stringify(details));
  });

  console.log('[smoke] 加载 ' + url);
  await win.loadURL(url);
  await sleep(WAIT_MS);

  /* ---------- 页面状态探针 ---------- */
  const probe = await win.webContents.executeJavaScript(`(function () {
    var mask = document.getElementById('bootMask');
    var names = window.lmc ? Object.keys(window.lmc) : [];
    var unimplemented = window.__xlcStubCalls || [];
    return {
      hasLmc: !!window.lmc,
      lmcCount: names.length,
      hasGetConfig: typeof window.lmc?.getConfig === 'function',
      maskExists: !!mask,
      maskHidden: mask ? mask.classList.contains('hide') : null,
      visibleText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
      nodeCount: document.querySelectorAll('*').length,
      title: document.title
    };
  })()`).catch((e) => ({ probeError: String(e) }));

  /* ---------- 截图 ---------- */
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(SHOT, img.toPNG());
  } catch (e) {
    errors.push('[screenshot] ' + e.message);
  }

  /* ---------- 报告 ---------- */
  console.log('\n================ 探针结果 ================');
  console.log(JSON.stringify(probe, null, 2));
  console.log('\n================ 控制台日志（末 40 条）================');
  logs.slice(-40).forEach((l) => console.log('  ' + l));
  console.log('\n================ 错误（' + errors.length + '）================');
  errors.slice(0, 30).forEach((l) => console.log('  ' + l));
  console.log('\n截图: ' + SHOT);

  const pass =
    probe.hasLmc === true &&
    probe.lmcCount >= 100 &&
    probe.maskExists === false &&      // 启动遮罩必须已被移除，否则界面卡死在加载态
    errors.filter((e) => /\[error\]/.test(e)).length === 0;

  console.log('\n结论: ' + (pass ? 'PASS' : 'FAIL'));

  srv.close();
  app.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error('[smoke] 致命错误', e);
  app.exit(2);
});
