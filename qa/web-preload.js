'use strict';
/* ============================================================
 * Electron 侧预加载：把 AndroidHost 注入到页面
 *
 * 安卓端由 WebView.addJavascriptInterface(LmcBridge, "AndroidHost") 提供；
 * 这里用一份 JS 复刻实现替代，以便在本机没有模拟器/真机的情况下
 * 验证「桥接 + 渲染层」整条链路。
 *
 * 为让 preload 能直接触达页面里的 window.__xlcResolve，
 * 测试窗口关闭了 contextIsolation（仅测试环境如此，生产 WebView 不受影响）。
 * ============================================================ */
const { dispatch } = require('./mock-dispatch.js');

window.AndroidHost = {
  invoke(method, argsJson, cbId) {
    let args;
    try { args = JSON.parse(argsJson || '[]'); } catch (_) { args = []; }

    // 模拟原生侧在后台线程执行后异步回推
    setTimeout(() => {
      let payload;
      try {
        payload = JSON.stringify(dispatch(method, args));
      } catch (e) {
        payload = JSON.stringify({ ok: false, error: 'mock 异常: ' + e.message });
      }
      if (typeof window.__xlcResolve === 'function') {
        window.__xlcResolve(cbId, payload);
      } else {
        console.error('[preload] window.__xlcResolve 尚未就绪，调用丢失:', method);
      }
    }, 2);
  }
};

console.log('[preload] AndroidHost 已注入');
