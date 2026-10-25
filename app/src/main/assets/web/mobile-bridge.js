/* ============================================================
 * XLC Android —— 渲染层桥接（替代桌面端的 Electron preload.js）
 *
 * 桌面端由 preload.js 通过 contextBridge 暴露 window.lmc；
 * 安卓 WebView 里没有 Node 环境，这里用完全相同的 API 形状重建一遍，
 * 全部转发给原生 LmcBridge。renderer.js 因此无需任何改动。
 *
 * 调用约定（全异步，避免阻塞 WebView 的 JS 线程）：
 *   JS   → 原生   AndroidHost.invoke(method, argsJson, cbId)
 *   原生 → JS     window.__xlcResolve(cbId, resultJson)
 *   原生 → JS     window.__xlcEmit(channel, dataJson)    主进程侧主动推送
 *
 * MAP 的键必须与 preload.js 暴露的方法名逐一对应，值为主进程 IPC 通道名。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__xlcBridgeInstalled) return;
  window.__xlcBridgeInstalled = true;

  const HOST = window.AndroidHost;
  const PENDING = new Map();
  const LISTENERS = {};
  let seq = 0;

  /* 单次调用超时：原生侧一旦异常没回调，Promise 会永挂 → 界面卡在加载态，
     这里强制兜底，让渲染层至少能拿到一个失败的返回值继续往下走。 */
  const CALL_TIMEOUT = 20000;

  /* 长耗时接口单独放宽：拉版本清单（约 2MB）/ 探测下载源，20 秒在弱网下不够用。
     下载类接口按「文件可能多大」给预算 —— MOD 几十 MB、整合包可能上 GB，
     超时只是 JS 侧兜底，不宜过紧，否则会在下载还在正常推进时误报失败。 */
  const LONG_TIMEOUT = {
    'manifest:get': 90000,
    'net:ping': 30000,
    'install:start': 60000,
    'modrinth:search': 90000,
    'modrinth:detail': 90000,
    'modrinth:install-mod': 600000,
    'modrinth:install-pack': 900000,
    'modrinth:install-modpack': 3600000,
    'custom:download': 3600000,
    'mods:list': 60000,
    'mods:enrich': 180000,
    'saves:list': 120000,
    'loader:probe': 90000,
    'loader:builds': 90000,
    'optifine:asMod': 300000,
    'version:loader-change': 1800000,
    'version:loader-uninstall': 900000,
    'java:download': 1800000,
    'java:test': 60000,
    'java:overview': 30000,
    'java:storage-status': 20000,
    'java:storage-request': 300000,
    'update:check': 60000,
    'account:ms-web-login': 300000,
    'account:ms-login-wait': 300000,
    'account:ms-login-start': 300000,
    'account:ms-poll': 60000,
    'account:ms-start': 30000,
    'account:ms-net-check': 30000,
    'account:authlib-detect': 60000,
    'account:authlib-login': 60000,
    /* 皮肤：用户要在系统图片选择器里慢慢挑，20 秒远远不够 */
    'account:skin': 180000
  };

  function call(method, args) {
    return new Promise((resolve) => {
      if (!HOST || typeof HOST.invoke !== 'function') {
        resolve({ ok: false, error: '原生桥接未就绪' });
        return;
      }
      const id = ++seq;
      const budget = LONG_TIMEOUT[method] || CALL_TIMEOUT;
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        PENDING.delete(id);
        resolve(v);
      };

      PENDING.set(id, done);
      try {
        HOST.invoke(method, JSON.stringify(args || []), String(id));
      } catch (e) {
        done({ ok: false, error: '桥接调用失败: ' + ((e && e.message) || e) });
        return;
      }
      setTimeout(() => done({ ok: false, error: '桥接调用超时: ' + method }), budget);
    });
  }

  /* 原生回调入口 */
  window.__xlcResolve = function (id, json) {
    const done = PENDING.get(Number(id));
    if (!done) return;
    let v;
    try { v = JSON.parse(json); } catch (_) { v = { ok: false, error: '返回值解析失败' }; }
    done(v);
  };

  /* 原生主动推送入口（app:status / app:toast / install:progress …） */
  window.__xlcEmit = function (channel, json) {
    const list = LISTENERS[channel];
    if (!list || !list.length) return;
    let data;
    try { data = JSON.parse(json); } catch (_) { data = null; }
    list.slice().forEach((cb) => {
      try { cb(data); } catch (e) { console.error('[bridge] 事件处理异常 ' + channel, e); }
    });
  };

  /* ---------- API 名 → IPC 通道（严格照抄 preload.js） ---------- */
  const MAP = {
    getConfig: 'config:get',
    saveConfig: 'config:save',
    pickFolder: 'dir:pick',
    openPath: 'shell:open',
    copyText: 'clipboard:write',
    confirmBox: 'ui:confirm',
    scan: 'dir:scan',
    savesList: 'saves:list',
    savesPreview: 'saves:preview',
    savesDelete: 'saves:delete',
    getManifest: 'manifest:get',
    loaderProbe: 'loader:probe',
    loaderBuilds: 'loader:builds',
    optifineAsMod: 'optifine:asMod',
    install: 'install:start',
    installCancel: 'install:cancel',
    detectJava: 'java:detect',
    rendererError: 'app:renderer-error',
    javaDownload: 'java:download',
    // 安卓专属扩展（桌面端 preload 里没有，只给 android-extra.js 用）
    javaTest: 'java:test',
    javaRemove: 'java:remove',
    javaOverview: 'java:overview',
    javaStorageStatus: 'java:storage-status',
    javaStorageRequest: 'java:storage-request',
    pingSource: 'net:ping',
    launch: 'launch:start',
    exportModpack: 'modpack:export',
    importModpack: 'modpack:import',
    versionInfo: 'version:info',
    loaderChange: 'version:loader-change',
    loaderUninstall: 'version:loader-uninstall',
    customDownload: 'custom:download',
    modrinthSearch: 'modrinth:search',
    modrinthDetail: 'modrinth:detail',
    modrinthCfDesc: 'modrinth:cf-desc',
    modrinthTranslate: 'modrinth:translate',
    modrinthInstallMod: 'modrinth:install-mod',
    modrinthInstallModpack: 'modrinth:install-modpack',
    modrinthInstallPack: 'modrinth:install-pack',
    pickBg: 'personalize:pick-bg',
    getBg: 'personalize:get-bg',
    sysMem: 'sys:meminfo',
    instanceRename: 'instance:rename',
    instanceDelete: 'instance:delete',
    modsList: 'mods:list',
    modsEnrich: 'mods:enrich',
    openUrl: 'shell:open-external',
    mpStatus: 'mp:status',
    mpDownload: 'mp:download',
    mpStart: 'mp:start',
    mpState: 'mp:state',
    mpAct: 'mp:act',
    mpStop: 'mp:stop',
    modsToggle: 'mods:toggle',
    modsDelete: 'mods:delete',
    diagLauncher: 'diag:launcher',
    diagGame: 'diag:game',
    diagAi: 'diag:ai',
    accountList: 'account:list',
    accountAdd: 'account:add',
    accountSwitch: 'account:switch',
    accountRename: 'account:rename',
    accountDelete: 'account:delete',
    accountSkin: 'account:skin',
    accountSkinRemove: 'account:skin-remove',
    accountMsLoginStart: 'account:ms-login-start',
    accountMsLoginWait: 'account:ms-login-wait',
    accountMsLoginCancel: 'account:ms-login-cancel',
    accountMsWebLogin: 'account:ms-web-login',
    accountMsWebCancel: 'account:ms-web-cancel',
    accountMsAppInfo: 'account:ms-app-info',
    accountMsNetCheck: 'account:ms-net-check',
    accountMsStart: 'account:ms-start',
    accountMsPoll: 'account:ms-poll',
    accountAuthlibDetect: 'account:authlib-detect',
    accountAuthlibLogin: 'account:authlib-login',
    accountModel: 'account:model',
    friendsGet: 'friends:get',
    friendsAdd: 'friends:add',
    friendsRemove: 'friends:remove',
    friendsPresence: 'friends:presence',
    friendsSignalPoll: 'friends:signal-poll',
    friendsSignalSend: 'friends:signal-send',
    /* 插件 */
    pluginList: 'plugin:list',
    pluginToggle: 'plugin:toggle',
    seedmapPlatforms: 'plugin:seedmap-platforms',
    seedmapOpen: 'plugin:seedmap-open',
    /* 插件：一键开服 */
    serverCores: 'server:cores',
    serverVersions: 'server:versions',
    serverList: 'server:list',
    serverCreate: 'server:create',
    serverStart: 'server:start',
    serverStop: 'server:stop',
    serverKill: 'server:kill',
    serverCmd: 'server:cmd',
    serverDelete: 'server:delete',
    serverOpenDir: 'server:open-dir',
    serverSyncMods: 'server:sync-mods',
    serverJavas: 'server:javas',
    /* 启动器版本更新 */
    updateCheck: 'update:check',
    updateChangelog: 'update:changelog',
    updateSeen: 'update:seen',
    updateCached: 'update:cached',
    updateIgnore: 'update:ignore',
    updateDownload: 'update:download',
    updateCancel: 'update:cancel',
    updateRun: 'update:run',
    updateReveal: 'update:reveal',
    updateSelfReplace: 'update:self-replace',
    updateQuit: 'update:quit-for-update'
  };

  const api = {};
  Object.keys(MAP).forEach((name) => { api[name] = (...a) => call(MAP[name], a); });

  api.on = function (channel, cb) {
    if (typeof cb !== 'function') throw new Error('on() 需要一个回调函数');
    (LISTENERS[channel] || (LISTENERS[channel] = [])).push(cb);
    return () => {
      const l = LISTENERS[channel];
      if (!l) return;
      const i = l.indexOf(cb);
      if (i >= 0) l.splice(i, 1);
    };
  };

  api.win = {
    minimize: () => call('win:minimize', []),
    maximizeToggle: () => call('win:maximize-toggle', []),
    close: () => call('win:close', [])
  };

  window.lmc = api;
  console.log('[bridge] window.lmc 已就绪，接口 ' + Object.keys(api).length + ' 个');
})();
