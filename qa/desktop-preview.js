'use strict';
/* ============================================================
 * XLC 安卓版 · 桌面预览器
 *
 * 用途：本机没有安卓模拟器/真机时，用 Electron（与 Android WebView
 *       同为 Chromium 内核）承载**安卓工程里的** assets/web 界面，
 *       配合 JS 版桥接 mock，让你在电脑上直接看、直接点。
 *
 * 说明：它只验证「Web UI + 桥接返回值」这一层，跑的不是安卓系统，
 *       也不涉及 JRE / 图形转译。真机性能请以真机为准。
 *
 * 用法：双击 启动预览器.bat，或
 *       electron.exe --no-sandbox --disable-gpu qa/desktop-preview.js
 * ============================================================ */
const { app, BrowserWindow, Menu, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_DIR = path.resolve(__dirname, '../app/src/main/assets/web');
const OUT_DIR = path.resolve(__dirname, 'out');
const SHOT = path.join(OUT_DIR, 'desktop-preview.png');
const AUTOCLOSE = Number(process.env.PREVIEW_AUTOCLOSE_MS || 0); // >0 时用于自测

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function startServer() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(WEB_DIR)) {
      reject(new Error('未找到 ' + WEB_DIR + '，请先运行 sync-web.sh 同步界面'));
      return;
    }
    const srv = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const file = path.join(WEB_DIR, rel);
      if (!path.resolve(file).startsWith(path.resolve(WEB_DIR)) ||
          !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
      });
      fs.createReadStream(file).pipe(res);
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

let mainWin = null;

(async () => {
  await app.whenReady();
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  let srv;
  try {
    srv = await startServer();
  } catch (e) {
    console.error('[preview] 启动失败: ' + e.message);
    app.exit(2);
    return;
  }
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}/index.html`;

  mainWin = new BrowserWindow({
    width: 1280,
    height: 720,      // 与 AndroidManifest 的 landscape 一致
    minWidth: 480,
    minHeight: 480,
    show: true,
    backgroundColor: '#0f1116',
    title: 'XLC 安卓版 · 桌面预览器（非真机，仅供界面验证）',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'web-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false
    }
  });

  /* 菜单：方便切换模拟的设备尺寸 / 刷新 / 开发者工具 */
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '设备尺寸',
      submenu: [
        { label: '手机横屏 1280×720', click: () => mainWin.setContentSize(1280, 720) },
        { label: '手机竖屏 720×1280', click: () => mainWin.setContentSize(720, 1280) },
        { label: '平板 1024×768', click: () => mainWin.setContentSize(1024, 768) },
        { type: 'separator' },
        { label: '自由缩放（拖窗口边）', enabled: false }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开工程目录（D:\\XLC-Android）',
          click: () => shell.openPath(path.resolve(__dirname, '..'))
        },
        {
          label: '关于：这是预览器，不是真机',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox(mainWin, {
              type: 'info',
              title: '关于桌面预览器',
              message: '桌面预览器（Chromium 承载 + 桥接 mock）',
              detail:
                '它加载的是安卓工程 app/src/main/assets/web 里的真实界面文件，\n' +
                '桥接返回值由 qa/mock-dispatch.js 提供。\n\n' +
                '可以验证：界面渲染、启动链路、交互与确认框、布局。\n' +
                '不能验证：安卓系统权限、文件系统、JRE、图形转译、真机性能。\n\n' +
                '这些需要模拟器或真机。'
            });
          }
        }
      ]
    }
  ]));

  mainWin.webContents.on('did-fail-load', (_e, code, desc, u) => {
    console.error(`[preview] 加载失败 ${code} ${desc} ${u}`);
  });
  mainWin.webContents.on('render-process-gone', (_e, d) => {
    console.error('[preview] 渲染进程退出: ' + JSON.stringify(d));
  });
  mainWin.on('closed', () => { mainWin = null; });
  app.on('window-all-closed', () => {
    if (srv) srv.close();
    app.quit();
  });

  console.log('[preview] 界面目录: ' + WEB_DIR);
  console.log('[preview] 打开: ' + url);
  await mainWin.loadURL(url);

  if (AUTOCLOSE > 0) {
    await sleep(AUTOCLOSE);
    try {
      const img = await mainWin.webContents.capturePage();
      fs.writeFileSync(SHOT, img.toPNG());
      console.log('[preview] 自测截图: ' + SHOT);
    } catch (e) {
      console.error('[preview] 截图失败: ' + e.message);
    }
    if (srv) srv.close();
    app.exit(0);
  }
})().catch((e) => {
  console.error('[preview] 致命错误', e);
  app.exit(2);
});
