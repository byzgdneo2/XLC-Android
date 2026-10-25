'use strict';
/* ============================================================
 * XLC Launcher - 渲染进程
 * ============================================================ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const el = (tag, cls, html) => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html !== undefined) d.innerHTML = html;
  return d;
};
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

/* ---------------- 全局状态 ---------------- */
const S = {
  config: null,
  manifest: null,
  manifestVia: '',
  installed: [],   // [{id, folder, loader, hasJar}]
  broken: [],      // 残留实例目录 [{folder, path, reason}]（目录在但版本 JSON 缺失/损坏）
  brokenHinted: false,
  saves: [],
  launching: false
};
const LOADERS = ['Vanilla', 'Forge', 'Fabric', 'Quilt', 'NeoForge', 'OptiFine'];
const LOADER_INFO = {
  Vanilla: '官方原版客户端，无模组支持',
  Forge: '老牌模组加载器，生态最大（静默安装器）',
  Fabric: '轻量快速，新版本跟进最快',
  Quilt: 'Fabric 分支，兼容 Fabric 模组',
  NeoForge: 'Forge 社区分支，面向新版本（1.20.1+）',
  OptiFine: '画质优化与增强'
};

/* ---------------- 确认框 ---------------- */
/* 一律走主进程的原生确认框，不要用 window.confirm：
   后者是阻塞式的，弹出时渲染进程停摆 —— 界面画着但点什么都没反应、打不了字（还会跑到窗口后面，
   表现为「启动器卡死」）。await 期间界面照常响应，且对话框一定挂在启动器窗口上。
   用法：if (!(await askConfirm('确定删除…', { danger: true, detail: '…' }))) return; */
async function askConfirm(message, opts) {
  const o = opts || {};
  try {
    const r = await window.lmc.confirmBox({
      message,
      detail: o.detail || '',
      danger: !!o.danger,
      okText: o.okText || '确定',
      cancelText: o.cancelText || '取消'
    });
    if (r && r.error) {
      /* 对话框没弹出来：明确告知，别让用户以为点了没反应 */
      toast('确认框打开失败：' + r.error, 'error');
      return false;
    }
    return !!(r && r.ok);
  } catch (e) {
    /* 极端情况下（主进程未就绪）保守返回 false，避免误删 */
    toast('确认框调用失败：' + ((e && e.message) || e), 'error');
    return false;
  }
}

/* ---------------- Toast / 状态 ---------------- */
function toast(msg, type) {
  const box = $('#toasts');
  /* 防洪：同时最多 6 条，超出的移除最旧的（长按回车连点会瞬间堆几十条） */
  while (box.children.length >= 6) box.firstChild.remove();
  const t = el('div', 'toast' + (type && type !== 'ok' ? ' ' + type : ''), esc(msg));
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 3400);
}
window.lmc.on('app:toast', (d) => toast(d.msg, d.type));
function setStatus(text, busy) {
  $('#stText').textContent = text;
  $('#stDot').className = 'st-dot' + (busy ? ' busy' : '');
}
window.lmc.on('app:status', (d) => setStatus(d.text, d.busy));

/* 渲染端 JS 错误上报主进程留档（渲染进程崩溃主进程此前无从感知） */
function reportRrError(m) { try { window.lmc.rendererError(m); } catch (_) {} }
window.addEventListener('error', (e) => {
  if (e && (e.error || e.message)) reportRrError('error: ' + ((e.error && (e.error.stack || e.error.message)) || e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  reportRrError('unhandledrejection: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

/* ---------------- 工具 ---------------- */
function parseVer(id) {
  const m = String(id).match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [1, +m[1], +m[2]] : null;
}
function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}
function fmtDate(iso) {
  try { return new Date(iso).toISOString().slice(0, 10); } catch (_) { return ''; }
}
function typeName(t) {
  return { release: '正式版', snapshot: '快照', old_beta: 'Beta', old_alpha: 'Alpha' }[t] || t;
}

/* 加载器兼容性
 * ============================================================
 * 这里只是「初判」（同步、不联网），让弹窗一打开就有东西可渲染。
 * 真实结论一律以各家官方元数据为准 —— 见 loaderCompatAsync() / loader:probe IPC。
 *
 * 【为什么不能硬编码】各加载器对「快照版 / 预发布版」的支持规则完全不同，
 * 而且同一加载器对不同版本也不一样（Quilt 有 26.3-snapshot-1 却没有 26.4-snapshot-2）。
 * 实测矩阵（2026-10-04，构建数量）：
 *            1.21.11   26.1   26.2   26.3   26.4-snapshot-2
 *   Fabric     253      253    253    253        253        ← 快照也支持
 *   Quilt      307      307    307    307        ✗ 404       ← 正式版都支持，快照看具体版本
 *   Forge       31        8     14      8        ✗           ← 不为快照提供构建
 *   NeoForge    ✗       161     89     47        ✗           ← 版本号按次版本号走，不为快照提供
 *   OptiFine    18       ✗      1       ✗        ✗           ← 只在该版本有发布时才有（26.2 有 1 个预览）
 *
 * 结论：除 Vanilla 外全部必须联网确认。这里只对「明显不可能」的情况做快速否定，
 * 其余一律先给 ok:true + pending，等元数据回填后刷新界面。 */
function loaderCompat(v) {
  const rel = v.type === 'release';
  const p = parseVer(v.id);
  const isOld = v.type === 'old_beta' || v.type === 'old_alpha';
  const pending = { ok: true, why: '', pending: true };
  return {
    Vanilla:  { ok: true, why: '' },
    /* 远古版（old_beta / old_alpha，如 b1.7.3、a1.2.6）连 Forge 都没有，直接否定且不联网。
       注意 pending 必须为 false，否则界面会永远停在「检测中」而不是明确的「不兼容」。 */
    Forge:    isOld ? { ok: false, why: '远古版本无 Forge 构建' }
                    : (rel ? { ok: true, why: '' } : pending),
    Fabric:   isOld ? { ok: false, why: '远古版本无 Fabric 构建' }
                    : (rel && p && cmpVer(p, [1, 14, 0]) < 0
                        ? { ok: false, why: 'Fabric 支持自 1.14 开始' }
                        : pending),
    Quilt:    isOld ? { ok: false, why: '远古版本无 Quilt 构建' }
                    : (rel && p && cmpVer(p, [1, 14, 0]) < 0
                        ? { ok: false, why: 'Quilt 支持自 1.14 开始' }
                        : pending),
    NeoForge: isOld ? { ok: false, why: '远古版本无 NeoForge 构建' }
                    : (rel && p && cmpVer(p, [1, 20, 1]) < 0
                        ? { ok: false, why: 'NeoForge 仅支持 1.20.1 及以上版本' }
                        : pending),
    /* OptiFine 以前写死 ok:false（提示「后续版本支持」），但实际 BMCLAPI 有完整的
       OptiFine 版本清单，26.2 都已经有预览版了。改为联网查清单判断。 */
    OptiFine: isOld ? { ok: false, why: '远古版本无 OptiFine 构建' } : pending
  };
}

/* 需要联网确认的加载器（Vanilla 不需要，任何版本都是原版） */
const LOADER_VERSIONED = { Forge: true, Fabric: true, Quilt: true, NeoForge: true, OptiFine: true };
/* 联网确认结果：按 MC 版本 id 存，供 compatOf() 覆盖初判。
   注意这里不做「跨次复用」的长缓存 —— 用户要求每次安装都实时查询一遍，
   所以每次 refineLoaderCompat()/loaderCompatAsync() 都会重新请求；这个 Map 只用于
   「本次弹窗会话内」，并且是**增量写入**的（每个加载器单独回来就单独合并），
   这样界面可以先显示已确定的那几个，不必等最慢的那个。 */
const loaderCompatOverride = new Map();
/* 是否正在查询（供界面显示「检测中」） */
let loaderProbing = false;
/* 查询单个加载器并把结论写进本次弹窗会话的覆盖表。
 * 【为什么拆成单加载器】一次并发查 5 个加载器时，弹窗要等「最慢的那个」才重绘，
 * 用户盯着「… 检测中」的时间 = 5 个请求里最慢的那个（常见是被墙的 NeoForge 官方源）。
 * 拆开后「选中的加载器」优先查、回来立刻重绘，其余在后台并行补，感知延迟降到 1 个请求。
 * 另外同一 (kind, 版本) 在途请求会去重（inFlight），切换单选项来回点不会重复发请求。 */
const loaderProbeInFlight = new Map();     /* key = kind + '@' + verId → Promise<结果> */
function probeOneLoader(kind, verId, force) {
  const key = kind + '@' + verId;
  if (loaderProbeInFlight.has(key)) return loaderProbeInFlight.get(key);
  const p = (async () => {
    try {
      const r = await window.lmc.loaderProbe(kind, verId, !!force);
      return (r && r.ok)
        ? { ok: true, why: '', loaderVer: r.loaderVer || '', builds: r.builds || 0, preview: !!r.preview, at: Date.now() }
        : { ok: false, unknown: !!r.unknown, slow: !!r.slow,
            why: (r && r.why) || (kind + ' 尚未提供 ' + verId + ' 的构建'), builds: 0, at: Date.now() };
    } catch (e) {
      return { ok: false, why: kind + ' 构建信息获取失败（网络不可达）：' + ((e && e.message) || e), at: Date.now() };
    }
  })();
  loaderProbeInFlight.set(key, p);
  /* 落地后从在途表移除 —— 这样下一次 force 查询会重新发请求（不做跨次缓存） */
  p.finally(() => { if (loaderProbeInFlight.get(key) === p) loaderProbeInFlight.delete(key); });
  return p;
}
/* 把单个加载器的结论合并进覆盖表（增量写入，供界面随时读取已回来的部分） */
function mergeLoaderResult(verId, kind, res) {
  const cur = loaderCompatOverride.get(verId) || {};
  cur[kind] = res;
  loaderCompatOverride.set(verId, cur);
  return cur;
}
/* 批量查询（opts.kinds 可指定只查哪些；缺省查全部）。
 * 逐个落地、逐个合并：调用方可以在每个 onOne 回调里重绘，先回来的先显示。 */
async function loaderCompatAsync(v, opts) {
  const want = (opts && opts.kinds)
    ? (Array.isArray(opts.kinds) ? opts.kinds : [opts.kinds]).filter(k => LOADER_VERSIONED[k])
    : Object.keys(LOADER_VERSIONED);
  loaderProbing = true;
  const onOne = opts && opts.onOne;
  try {
    await Promise.all(want.map(async (kind) => {
      const res = await probeOneLoader(kind, v.id, !!(opts && opts.force));
      mergeLoaderResult(v.id, kind, res);
      if (typeof onOne === 'function') { try { onOne(kind, res); } catch (_) {} }
    }));
  } finally {
    loaderProbing = false;
  }
  return loaderCompatOverride.get(v.id) || {};
}

/* ---------------- 导航 ---------------- */
/* 侧边栏滑动指示条：跟随当前页平滑移动（弹性缓动 + 辉光，见 #railInd 样式） */
let railIndPlaced = false;   /* 首次落位直接摆到位：否则会看到指示条从侧栏顶端一路滑下来 */
function moveRailInd() {
  const ind = $('#railInd');
  const btn = $('#railNav .rail-btn.active');
  if (!ind) return;
  if (!btn) { ind.style.opacity = '0'; return; }   // 二级页（存档管理等）无侧栏入口 → 隐藏指示条
  const rb = btn.getBoundingClientRect(), rr = $('#rail').getBoundingClientRect();
  if (!rr.height) return;
  if (!railIndPlaced) ind.style.transition = 'none';   /* 只跳过这一次的过渡 */
  ind.style.top = (rb.top - rr.top + rb.height * 0.24) + 'px';
  ind.style.height = (rb.height * 0.52) + 'px';
  ind.style.opacity = '1';
  if (!railIndPlaced) {
    railIndPlaced = true;
    requestAnimationFrame(() => { ind.style.transition = ''; });   /* 恢复 CSS 里的弹性过渡 */
  }
}
window.addEventListener('resize', moveRailInd);
function gotoPage(name) {
  $$('#railNav .rail-btn').forEach(x => x.classList.toggle('active', x.dataset.page === name));
  moveRailInd();
  $$('.page').forEach(p => p.classList.remove('active'));
  const page = $('#page-' + name);
  if (page) page.classList.add('active');
  /* 切页回到顶部：#content 是所有页面共用的滚动容器，不回顶会「继承」上一页的滚动位置 */
  const content = $('#content');
  if (content) content.scrollTop = 0;
  if (name === 'instances') renderInstances();
  if (name === 'account') loadAccounts();
  if (name === 'diag') {
    const di = $('#diagInstance');
    const prev = di.value;
    di.innerHTML = S.installed.map(v => '<option value="' + esc(v.id) + '">' + esc(v.id) + '</option>').join('') +
      '<option value="">（全局 .minecraft）</option>';
    if (prev && S.installed.some(v => v.id === prev)) di.value = prev;
    refreshDiagLauncher();
  }
  if (name === 'mp') mpOnEnter(); else mpStopPolling();
  if (name === 'friends') { loadFriends(); frStartPolling(); } else frStopPolling();
  if (name === 'saves') renderSavesPage();
  if (name === 'tools') renderTools();
  if (name === 'plugins') {
    renderPlugins();
    /* 停留在一键开服面板时，回页顺带刷新服务器列表与控制台（进程状态可能已变化） */
    if (PLG.pane === 'server') loadServerList();
  }
  if (name === 'download') requestAnimationFrame(() => moveTabInd($('#dlTabs'))); // 页面显示后再定位（隐藏时 offsetWidth 为 0）
  if (name === 'settings') refreshUpdatePane();
}
$$('#railNav .rail-btn').forEach(b => {
  b.addEventListener('click', () => gotoPage(b.dataset.page));
});

/* ---------------- 窗口控制 ---------------- */
$('#btnMin').addEventListener('click', () => window.lmc.win.minimize());
$('#btnMax').addEventListener('click', () => window.lmc.win.maximizeToggle());
$('#btnClose').addEventListener('click', () => window.lmc.win.close());
/* 最大化状态同步（主进程事件 → body class，可供样式区分最大化形态） */
window.lmc.on('win:maximized', (on) => document.body.classList.toggle('maximized', !!on));

/* ---------------- 启动日志 ---------------- */
const logPanel = $('#logPanel');
function appendLog(line, cls) {
  const d = el('div', cls || '', esc(line));
  logPanel.appendChild(d);
  while (logPanel.children.length > 500) logPanel.firstChild.remove();
  logPanel.scrollTop = logPanel.scrollHeight;
}
$('#btnClearLog').addEventListener('click', () => { logPanel.innerHTML = '<div class="t-dim">已清空</div>'; });
window.lmc.on('launch:log', (d) => {
  let cls = '';
  if (/ERROR|Exception|错误|失败/i.test(d)) cls = 't-err';
  else if (/WARN|警告/i.test(d)) cls = 't-warn';
  appendLog(d, cls);
});
window.lmc.on('launch:exit', (d) => {
  appendLog('[XLC] 游戏进程已退出 (code ' + d.code + ')', d.code === 0 ? 't-dim' : 't-warn');
  S.launching = false;
  $('#btnLaunch').disabled = false;
  $('#heroState').textContent = '就绪';
  if (d.diag && d.diag.found) {
    /* 异常退出且诊断出结果：自动跳到诊断页展示 */
    S.lastDiag = d.diag;
    document.querySelector('[data-page="diag"]').click();
    const di = $('#diagInstance');
    if (d.diag.instance && S.installed.some(v => v.id === d.diag.instance)) di.value = d.diag.instance;
    renderDiagResult(d.diag);
    toast('检测到游戏崩溃，已自动诊断 —— 见「诊断」页', 'warn');
  }
});

/* ---------------- 配置 ---------------- */
async function loadConfigUI() {
  S.config = await window.lmc.getConfig();
  /* 窗口标题 / 侧栏 logo 提示跟着主进程版本号走（index.html 里写的是静态兜底值）——
     发版只改 main.js 的 APP_VERSION，这里自动同步，不会出现标题停在旧版本的情况。 */
  if (S.config && S.config.appVersion) {
    const t = 'Xero Lite Craft Launcher ' + S.config.appVersion;
    if (document.title !== t) document.title = t;
    const lg = document.querySelector('.rail-logo');
    if (lg && lg.title !== t) lg.title = t;
  }
  $('#inpName').value = S.config.username || '';
  $('#heroName').textContent = S.config.username || 'Steve';
  $('#setUsername').value = S.config.username || '';
  $('#setJavaPath').value = S.config.javaPath || '';
  $('#setMem').value = S.config.mem || 4;
  $('#memVal').textContent = (S.config.mem || 4) + ' GB';
  $('#setGameDir').value = S.config.gameDir || '';
  $('#setCustomSrc').value = S.config.customSource || '';
  $('#setDlThreads').value = S.config.dlThreads || 16;
  /* 版本更新 */
  $('#updCurVer').textContent = S.config.appVersion || '—';
  /* 更新源锁定：地址栏只读，永远显示官方地址（不接受自定义） */
  const updUrlEl = $('#setUpdateUrl');
  if (updUrlEl) { updUrlEl.value = S.config.updateDefaultUrl || ''; updUrlEl.readOnly = true; }
  $('#setAutoUpd').checked = S.config.autoCheckUpdate !== false;
  $$('#page-settings input[name=src]').forEach(r => { r.checked = r.value === S.config.source; });
  const ai = S.config.aiApi || {};
  $('#aiBase').value = ai.base || '';
  $('#aiKey').value = ai.key || '';
  $('#aiModel').value = ai.model || 'gpt-4o-mini';
  $('#gsMemAuto').checked = S.config.memAuto !== false;
  $('#gsMemManualRow').style.display = S.config.memAuto !== false ? 'none' : '';
  $('#gsMem').value = S.config.mem || 4;
  $('#gsMemVal').textContent = (S.config.mem || 4) + ' GB';
  $('#gsJvm').value = S.config.jvmArgs || '';
  $('#gsChinese').checked = S.config.forceChinese !== false;
  refreshMemHint();
  applyPersonalize();
  $('#tbSource').textContent = S.config.source === 'official' ? '官方源' :
    S.config.source === 'custom' ? '自定义源' : 'BMCLAPI';
  updateStatusBarRight();
}
async function refreshMemHint() {
  try {
    const m = await window.lmc.sysMem();
    if (!m.ok) return;
    $('#gsMemHint').textContent = '物理内存 ' + m.totalGB + ' GB · 当前可用 ' + m.availGB + ' GB · 智能推荐 ' + m.recommendGB + ' GB（按可用内存动态调整）';
    if ($('#gsMemAuto').checked) { $('#gsMem').value = m.recommendGB; $('#gsMemVal').textContent = m.recommendGB + ' GB'; }
  } catch (_) {}
}
function updateStatusBarRight() {
  $('#stRight').textContent = (S.config ? (S.config.source === 'official' ? '官方源' : S.config.source === 'custom' ? '自定义镜像' : 'BMCLAPI 镜像') : '—') +
    ' · Java ' + (S.javaMajor || '?') + ' · 内存 ' + (S.config ? S.config.mem : 4) + ' GB';
}

/* ---------------- 主页 ---------------- */
function refreshHome() {
  const sel = $('#selVersion');
  sel.innerHTML = '';
  if (!S.installed.length) {
    sel.innerHTML = '<option value="">尚未安装版本 · 去「下载」页安装</option>';
  } else {
    S.installed.forEach(v => {
      const o = el('option', '', v.id + (v.loader !== 'Vanilla' ? '  (' + v.loader + ')' : ''));
      o.value = v.id;
      sel.appendChild(o);
    });
  }
  const cur = sel.value;
  $('#heroVer').textContent = cur || '未安装';
  renderVsel();
  // 存档下拉：当前实例有版本隔离存档 → 显示实例存档；否则显示全局存档（两者都显示时标注归属）
  rebuildWorldOptions();
}
function rebuildWorldOptions() {
  const sw = $('#selWorld');
  const ver = $('#selVersion').value;
  /* 只显示与当前选中版本匹配的存档：版本隔离实例 → 该实例目录里的存档；否则 → 全局存档 */
  const iso = S.saves.filter(w => w.instance === ver);
  const list = iso.length ? iso : S.saves.filter(w => !w.instance);
  sw.innerHTML = '<option value="">不指定 · 进入游戏后选择</option>';
  list.forEach(w => {
    const o = el('option', '', esc(w.name));
    o.value = w.name;
    sw.appendChild(o);
  });
  if (!list.length) {
    const o = el('option', '', '（该版本暂无存档）');
    o.disabled = true;
    sw.appendChild(o);
  }
}
/* 选中版本统一入口：persist=true 时写入配置，重启后自动恢复上次选择 */
function selectVersion(id, persist) {
  $('#selVersion').value = id;
  $('#heroVer').textContent = id || '未安装';
  renderVsel();
  rebuildWorldOptions();
  renderWorlds();
  if (persist && id) {
    S.config.lastVersion = id;
    window.lmc.saveConfig({ lastVersion: id });
  }
}

/* ---------------- 自定义版本下拉（每行带 设置/删除 实例操作） ---------------- */
function renderVsel() {
  const sel = $('#selVersion');
  const cur = sel.value;
  const curV = S.installed.find(v => v.id === cur);
  $('#vselBtn').innerHTML =
    '<span class="cv-name">' + (cur ? esc(cur + (curV && curV.loader !== 'Vanilla' ? ' (' + curV.loader + ')' : '')) : '尚未安装版本 · 去「下载」页安装') + '</span>' +
    '<svg class="ic sm cv-chev"><use href="#i-chev-d"/></svg>';
  const panel = $('#vselPanel');
  panel.innerHTML = '';
  if (!S.installed.length) {
    panel.innerHTML = '<div class="vsel-empty">尚未安装版本 · 去「下载」页安装</div>';
    return;
  }
  S.installed.forEach(v => {
    const row = el('div', 'vsel-row' + (v.id === cur ? ' cur' : ''));
    row.title = '点击切换到该版本；悬浮显示 设置 / 删除 按钮';
    row.innerHTML =
      '<span class="vr-name">' + esc(v.id) + (v.loader !== 'Vanilla' ? '<i class="vr-loader">' + esc(v.loader) + '</i>' : '') + '</span>' +
      '<span class="vr-act">' +
      '<button type="button" class="vsel-ico" title="实例设置（基础参数 / MOD 管理）"><svg class="ic sm"><use href="#i-settings"/></svg></button>' +
      '<button type="button" class="vsel-ico vr-del" title="删除实例"><svg class="ic sm"><use href="#i-trash"/></svg></button>' +
      '</span>';
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      selectVersion(v.id, true);
      closeVsel();
    });
    row.querySelector('.vsel-ico').addEventListener('click', (ev) => { ev.stopPropagation(); openInstSettings(v.id); });
    row.querySelector('.vr-del').addEventListener('click', (ev) => { ev.stopPropagation(); deleteInstance(v.id); });
    panel.appendChild(row);
  });
}
function openVsel() { $('#vsel').classList.add('open'); }
function closeVsel() { $('#vsel').classList.remove('open'); }
$('#vselBtn').addEventListener('click', () => $('#vsel').classList.toggle('open'));
document.addEventListener('click', (ev) => { if (!ev.target.closest('#vsel')) closeVsel(); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeVsel(); });

/* 齿轮 → 打开该实例的游戏设置（MOD 管理 tab 定位到该实例） */
function openInstSettings(id) {
  closeVsel();
  selectVersion(id, false);
  gotoPage('gsettings');
  $$('#gsTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.gs === 'mods'));
  $('#gsBasic').style.display = 'none';
  $('#gsMods').style.display = '';
  const mt = $('#modTarget');
  if ([...mt.options].some(o => o.value === id)) mt.value = id;
  loadMods();
}
/* 垃圾桶 → 删除实例（含版本隔离目录） */
async function deleteInstance(id) {
  if (!(await askConfirm('确定删除实例「' + id + '」吗？', { danger: true, detail: '该实例版本隔离目录里的 mods、saves、资源包等文件会一并删除，无法恢复！' }))) return;
  const r = await window.lmc.instanceDelete({ id });
  if (!r || !r.ok) { toast('删除失败: ' + ((r && r.error) || '未知错误'), 'error'); return; }
  toast('实例「' + id + '」已删除');
  await scanDir();
  if (!$('#selVersion').value && S.installed.length) selectVersion(S.installed[0].id, true);
}
$('#selVersion').addEventListener('change', () => {
  selectVersion($('#selVersion').value, true);  /* 记住选择 + 刷新存档下拉 */
  renderWorlds();                                /* 存档卡片跟随当前实例 */
});
$('#inpName').addEventListener('input', () => {
  const v = $('#inpName').value.trim();
  $('#heroName').textContent = v || 'Steve';
  $('#avatar').textContent = (v || 'S').charAt(0).toUpperCase();
  $('#setUsername').value = $('#inpName').value;
  heroHeadFor(v);
});
/* 设置页改玩家名 → 主页实时联动 */
$('#setUsername').addEventListener('input', () => {
  const v = $('#setUsername').value.trim();
  $('#heroName').textContent = v || 'Steve';
  $('#avatar').textContent = (v || 'S').charAt(0).toUpperCase();
  $('#inpName').value = $('#setUsername').value;
  heroHeadFor(v);
});
$('#btnLaunch').addEventListener('click', async () => {
  if (S.launching) { toast('游戏正在启动/运行中，请稍候', 'warn'); return; }
  const versionId = $('#selVersion').value;
  if (!versionId) { toast('请先在「下载」页安装一个版本', 'warn'); return; }
  S.launching = true;
  $('#btnLaunch').disabled = true;
  $('#heroState').textContent = '启动中…';
  logPanel.innerHTML = '';
  appendLog('[XLC] 准备启动 ' + versionId + ' …', 't-dim');
  try {
    const r = await window.lmc.launch({
      versionId,
      username: $('#inpName').value.trim() || 'Steve',
      world: $('#selWorld').value || null,
      /* 智能分配开启时不传 mem，由主进程按物理内存推荐 */
      mem: S.config.memAuto === false ? S.config.mem : undefined
    });
    if (r && r.started === false) { /* 主进程启动锁拒绝：复位本地状态 */
      S.launching = false;
      $('#btnLaunch').disabled = false;
      $('#heroState').textContent = '就绪';
      toast(r.error || '已有游戏正在运行，无法重复启动', 'warn');
    }
  } catch (e) {
    toast('启动失败: ' + e.message, 'error');
    S.launching = false;
    $('#btnLaunch').disabled = false;
  }
});

/* 存档/最近游玩 渲染：只显示当前选中实例自己的存档（版本隔离实例 → 实例目录；非隔离 → 全局 saves） */
function renderWorlds() {
  const box = $('#worldList');
  const ver = $('#selVersion').value;
  const iso = S.saves.filter(w => w.instance === ver);
  const list = iso.length ? iso : S.saves.filter(w => !w.instance);
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty-sm">该实例暂无存档</div>';
    return;
  }
  list.forEach(w => {
    const item = el('div', 'mini-item',
      '<div class="dot-ic"><svg class="ic sm"><use href="#i-globe"/></svg></div>' +
      '<div class="mi-main"><b>' + esc(w.name) + '</b><span>' + (w.instance ? esc(w.instance) + ' · ' : '') + esc(w.path) + '</span></div>' +
      '<button class="btn ghost mi-act" title="用该存档所属版本启动"><svg class="ic sm" style="color:var(--acc2)"><use href="#i-play"/></svg></button>');
    item.querySelector('button').addEventListener('click', () => {
      /* 实例隔离存档 → 自动切到所属实例启动；全局存档 → 用当前选中版本 */
      if (w.instance && S.installed.some(v => v.id === w.instance)) selectVersion(w.instance, true);
      const versionId = $('#selVersion').value;
      if (!versionId) { toast('请先安装并选择一个版本', 'warn'); return; }
      S.launching = true;
      $('#btnLaunch').disabled = true;
      $('#heroState').textContent = '启动中…';
      logPanel.innerHTML = '';
      appendLog('[XLC] 以存档「' + w.name + '」启动 ' + versionId + ' …', 't-dim');
      window.lmc.launch({
        versionId,
        username: $('#inpName').value.trim() || 'Steve',
        world: w.name,
        mem: S.config.memAuto === false ? S.config.mem : undefined
      }).then(r => {
        if (r && r.started === false) { /* 主进程启动锁拒绝：复位本地状态 */
          S.launching = false;
          $('#btnLaunch').disabled = false;
          $('#heroState').textContent = '就绪';
          toast(r.error || '已有游戏正在运行，无法重复启动', 'warn');
        }
      }).catch(e => toast('启动失败: ' + e.message, 'error'));
    });
    box.appendChild(item);
  });
}

/* 最近游玩：主进程在游戏进程成功拉起后记录（同名去重，最多 5 条） */
function renderRecent() {
  const box = $('#playList');
  const rec = (S.config && S.config.recent) || [];
  if (!rec.length) { box.innerHTML = '<div class="empty-sm">暂无记录</div>'; return; }
  box.innerHTML = '';
  rec.forEach(r => {
    const inst = S.installed.find(v => v.id === r.id);
    if (!inst) return; // 已删除的实例不再展示
    const item = el('div', 'mini-item',
      '<div class="dot-ic"><svg class="ic sm"><use href="#i-clock"/></svg></div>' +
      '<div class="mi-main"><b>' + esc(r.id) + '</b><span>' + fmtTime(r.time) + '</span></div>' +
      '<button class="btn ghost mi-act" title="快速启动"><svg class="ic sm" style="color:var(--acc2)"><use href="#i-play"/></svg></button>');
    item.querySelector('button').addEventListener('click', () => {
      selectVersion(r.id, true);
      $('#btnLaunch').click();
    });
    box.appendChild(item);
  });
  if (!box.children.length) box.innerHTML = '<div class="empty-sm">暂无记录</div>';
}
function fmtTime(ts) {
  try {
    const d = new Date(ts), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    return sameDay ? '今天 ' + hm : (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  } catch (_) { return ''; }
}

/* ---------------- 扫描本地目录 ---------------- */
async function scanDir() {
  const r = await window.lmc.scan();
  S.installed = r.versions || [];
  S.broken = r.broken || [];
  S.saves = r.saves || [];
  $('#curGameDir').textContent = r.gameDir;
  $('#scanSummary').innerHTML = r.exists
    ? '已识别 <b>' + S.installed.length + '</b> 个版本 · <b>' + S.saves.length + '</b> 个存档' +
      (S.broken.length ? ' · <b style="color:var(--warn,#f59e0b)">' + S.broken.length + '</b> 个残留目录' : '')
    : '目录不存在，将在安装时自动创建';
  /* 残留目录提示：只说一次，避免每次扫描都弹（可在「实例」页处理） */
  if (S.broken.length && !S.brokenHinted) {
    S.brokenHinted = true;
    toast('检测到 ' + S.broken.length + ' 个未安装完成的残留目录（如 ' + S.broken[0].folder + '），已跳过；可到「实例」页删除', 'warn');
  }
  /* 恢复选中：本次会话选择 > 上次选择（重启记住） > 默认启动实例 > 留空 */
  const cur = $('#selVersion').value;
  refreshHome();
  const want = cur ||
    (S.config && S.config.lastVersion && S.installed.some(v => v.id === S.config.lastVersion) ? S.config.lastVersion : '') ||
    (S.config && S.config.defaultVersion && S.installed.some(v => v.id === S.config.defaultVersion) ? S.config.defaultVersion : '');
  if (want) selectVersion(want, false);
  rebuildWorldOptions();
  renderWorlds();
  refreshAuxSelects();
  renderRecent();
  if (S.manifest) renderVersionList(); /* 下载页的「已安装 / 残留」标记跟随扫描结果刷新 */
}
/* 资源页/导出用的版本下拉（带加载器的版本排前）+ 数据包存档下拉 */
function refreshAuxSelects() {
  const target = $('#resTarget');
  const exp = $('#expVersion');
  const dw = $('#dpWorld');
  const prevT = target.value, prevE = exp.value, prevW = dw.value;
  const withLoader = S.installed.filter(v => v.loader && v.loader !== 'Vanilla');
  const rest = S.installed.filter(v => !withLoader.includes(v));
  const opts = (list) => list.map(v => '<option value="' + esc(v.id) + '">' +
    esc(v.id) + (v.loader !== 'Vanilla' ? ' (' + esc(v.loader) + ')' : '') + '</option>').join('');
  /* 目标版本：首项固定为「全部」（不筛 MC 版本与加载器，全站资源都能看到、都能直接安装）
   * 默认停在「全部」—— 下载时不需要先装版本；想按版本筛适配再手动选具体实例 */
  target.innerHTML = '<option value="__all__">全部</option>' + (opts(withLoader.concat(rest)) || '<option value="">（无已安装版本）</option>');
  exp.innerHTML = opts(S.installed) || '<option value="">（无已安装版本）</option>';
  /* 数据包存档下拉：实例隔离存档 value = "实例|世界名"，安装时写入实例目录的 datapacks */
  dw.innerHTML = S.saves.map(s =>
    '<option value="' + esc(s.instance ? s.instance + '|' + s.name : s.name) + '">' +
    esc(s.name) + (s.instance ? '（' + esc(s.instance) + '）' : '') + '</option>').join('') || '<option value="">（无存档，先启动一次游戏创建世界）</option>';
  // 游戏设置：默认启动实例
  const dv = $('#gsDefaultVer');
  const prevD = dv.value;
  dv.innerHTML = '<option value="">（每次启动时选择）</option>' + (opts(S.installed) || '');
  if (prevD && S.installed.some(v => v.id === prevD)) dv.value = prevD;
  else if (S.config.defaultVersion && S.installed.some(v => v.id === S.config.defaultVersion)) dv.value = S.config.defaultVersion;
  // MOD 管理目标实例（支持版本隔离：选实例读 versions/<实例>/mods，全局读 mods/）
  const mt = $('#modTarget');
  const prevM = mt.value;
  mt.innerHTML = '<option value="">🌐 全局 mods 目录</option>' + (opts(withLoader.concat(rest)) || '');
  if (prevM && (prevM === '' || S.installed.some(v => v.id === prevM))) mt.value = prevM;
  // 版本管理 tab 实例下拉
  const vs = $('#vsInstance');
  const prevVs = vs.value;
  vs.innerHTML = opts(S.installed) || '<option value="">（无已安装版本）</option>';
  if (prevVs && S.installed.some(v => v.id === prevVs)) vs.value = prevVs;
  else {
    const want = $('#selVersion').value || (S.config && S.config.lastVersion);
    if (want && S.installed.some(v => v.id === want)) vs.value = want;
  }
  /* 目标版本回填：保留用户选择；「全部」也保留；首次进入默认停在「全部」（不强制挑版本） */
  if (prevT === '__all__' || !prevT) target.value = '__all__';
  else if (S.installed.some(v => v.id === prevT)) target.value = prevT;
  else target.value = '__all__';
  if (prevE && S.installed.some(v => v.id === prevE)) exp.value = prevE;
  if (prevW && S.saves.some(s => s.name === prevW)) dw.value = prevW;
}
/* ---------------- 存档管理页（启动旁 ⋮ / 侧栏「存档」进入） ---------------- */
const SAVE_HUB = { list: [], sel: -1 };
function fmtSizeB(n) {
  if (!n || n < 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtFull(ts) {
  try {
    const d = new Date(Number(ts));
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  } catch (_) { return '—'; }
}
/* ---------------- 工具箱：MC 实用网站资源集合 ---------------- */
const TOOL_SITES = [
  { g: '百科攻略', items: [
    { n: 'Minecraft Wiki', d: '最权威的中文百科', u: 'https://zh.minecraft.wiki' },
    { n: 'MC百科', d: '中文 Mod 百科镜像站', u: 'https://www.mcmod.cn' },
    { n: 'DigMinecraft', d: '全球通用教程站', u: 'https://www.digminecraft.com' }
  ] },
  { g: '模组与整合包', items: [
    { n: 'CurseForge', d: '全球最大 Mod 整合包平台', u: 'https://www.curseforge.com' },
    { n: 'Modrinth', d: '新兴开源 Mod 平台', u: 'https://modrinth.com' },
    { n: 'Planet Minecraft', d: '全球最大 MC 社区', u: 'https://www.planetminecraft.com' },
    { n: 'MCPEDL', d: '基岩版资源大全', u: 'https://mcpedl.com' }
  ] },
  { g: '玩家社区', items: [
    { n: 'MineBBS', d: '国内外 MC 中文论坛', u: 'https://www.minebbs.com' },
    { n: '苦力怕论坛', d: '资源丰富的中文社区', u: 'https://klpbbs.com' },
    { n: 'Bilibili MC', d: '视频教程 / 直播 / 攻略', u: 'https://www.bilibili.com' }
  ] },
  { g: '材质与光影', items: [
    { n: 'ResourcePack', d: '海量材质包下载', u: 'https://resourcepack.net' },
    { n: 'ShadersMods', d: '光影资源合集', u: 'https://shadersmods.com' },
    { n: 'Vanilla Tweaks', d: '原版增强调整包', u: 'https://vanillatweaks.net' }
  ] },
  { g: '地图与建筑', items: [
    { n: '投影工坊', d: 'Litematica 投影分享下载', u: 'https://www.mcimg.com' },
    { n: 'Plotz', d: '圆环 / 球体建筑生成', u: 'https://www.plotz.co.uk' },
    { n: 'Block Palettes', d: '方块配色方案库', u: 'https://www.blockpalettes.com' },
    { n: 'Minecraft Maps', d: '地图介绍与地图下载', u: 'https://www.minecraftmaps.com' }
  ] },
  { g: '在线工具', items: [
    { n: 'Chunkbase', d: '种子地图 / 结构定位', u: 'https://www.chunkbase.com' },
    { n: 'MCStacker', d: '命令生成器', u: 'https://mcstacker.net' },
    { n: 'MC Tools', d: '合成器 / 结构预览', u: 'https://mctools.org' },
    { n: 'Misode', d: '数据包 / 世界生成器', u: 'https://misode.github.io' },
    { n: 'mclo.gs', d: '游戏日志分析工具', u: 'https://mclo.gs' },
    { n: 'Minecraft Heads', d: '头颅数据库 /give 命令', u: 'https://minecraft-heads.com' },
    { n: 'Colorize FUN', d: 'MC 彩色文本生成器', u: 'https://colorize.fun' },
    { n: 'Textcraft', d: 'MC 风格 Logo 生成', u: 'https://textcraft.net' }
  ] },
  { g: '皮肤资源', items: [
    { n: 'NameMC', d: '正版皮肤 / UUID 查询', u: 'https://namemc.com' },
    { n: 'LittleSkin', d: '国内皮肤站', u: 'https://littleskin.cn' },
    { n: 'Nova Skin', d: '3D 皮肤编辑器', u: 'https://minecraft.novaskin.me' },
    { n: 'The Skindex', d: '正版皮肤分享社区', u: 'https://www.minecraftskins.com' },
    { n: 'SkinMC', d: '3D 皮肤编辑器 / 披风', u: 'https://skinmc.net' }
  ] },
  { g: '服务器与插件', items: [
    { n: 'FindMCServer', d: 'Mojang 官方服务器列表', u: 'https://findmcserver.com' },
    { n: 'MC Servers', d: '服务器排行榜', u: 'https://minecraftservers.org' },
    { n: 'SpigotMC', d: '服务端插件 (Spigot)', u: 'https://www.spigotmc.org' },
    { n: 'PaperMC', d: '高性能服务端 / 插件', u: 'https://papermc.io' }
  ] },
  { g: '资源导航', items: [
    { n: 'MC Versions', d: '原版版本下载站', u: 'https://mcversions.net' },
    { n: 'Fabric 官网', d: 'Fabric 加载器官网', u: 'https://fabricmc.net' },
    { n: 'Forge 官网', d: 'Forge 加载器下载', u: 'https://files.minecraftforge.net' },
    { n: 'NeoForge 官网', d: 'NeoForge 加载器官网', u: 'https://neoforged.net' }
  ] }
];
const TOOL_IC_COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#6366f1'];
function renderTools(force) {
  const wrap = $('#toolsWrap');
  if (wrap.dataset.done && !force) return;
  wrap.innerHTML = TOOL_SITES.map(g =>
    '<h3 class="tools-group">' + esc(g.g) + '</h3>' +
    '<div class="tools-grid">' + g.items.map(it => {
      const dom = it.u.replace(/^https?:\/\//, '').split('/')[0];
      const c = TOOL_IC_COLORS[(it.n.charCodeAt(0) + dom.length) % TOOL_IC_COLORS.length];
      return '<a class="tool-card" href="javascript:void(0)" data-url="' + esc(it.u) + '" title="' + esc(it.u) + '">' +
        '<span class="tool-ic" data-dom="' + esc(dom) + '" style="background:' + c + '22;color:' + c + '">' + esc(it.n[0].toUpperCase()) + '</span>' +
        '<b>' + esc(it.n) + '</b><span>' + esc(it.d) + '</span></a>';
    }).join('') + '</div>').join('');
  wrap.dataset.done = '1';
  /* favicon 懒加载：站点 /favicon.ico → 国内镜像源 → 保留字母色块 */
  $$('#toolsWrap .tool-ic').forEach(el => {
    const dom = el.dataset.dom;
    const tryLoad = (src, next) => {
      const img = new Image();
      img.onload = () => { el.textContent = ''; el.style.background = '#fff'; el.appendChild(img); };
      img.onerror = next;
      img.src = src;
    };
    tryLoad('https://' + dom + '/favicon.ico', () =>
      tryLoad('https://api.iowen.cn/favicon/' + dom + '.png', () => {}));
  });
  $$('#toolsWrap .tool-card').forEach(c =>
    c.addEventListener('click', () => {
      toast('正在打开：' + c.dataset.url);
      window.lmc.openUrl(c.dataset.url);
    }));
}

async function renderSavesPage(force) {
  const box = $('#savesList');
  if (force || !SAVE_HUB.list.length) {
    box.innerHTML = '<div class="empty-sm">扫描存档中…</div>';
    const r = await window.lmc.savesList();
    if (!r.ok) { box.innerHTML = '<div class="empty-sm">扫描失败：' + esc(r.error || '') + '</div>'; return; }
    SAVE_HUB.list = r.saves || [];
    SAVE_HUB.sel = -1;
    /* 同步主页存档数据（selWorld 下拉 / 我的存档卡片共用） */
    S.saves = SAVE_HUB.list.map(w => ({ name: w.name, path: w.path, instance: w.instance }));
  }
  box.innerHTML = '';
  if (!SAVE_HUB.list.length) {
    box.innerHTML = '<div class="empty-sm">没有找到存档<br><span style="font-size:11px">进入游戏创建世界后会出现在这里</span></div>';
    $('#savesDetail').innerHTML = '<div class="empty-sm">暂无存档</div>';
    return;
  }
  SAVE_HUB.list.forEach((w, i) => {
    const card = el('div', 'save-card' + (i === SAVE_HUB.sel ? ' sel' : ''),
      '<div class="save-thumb">' + (w.icon ? '<img src="' + w.icon + '" alt="">' : '<svg class="ic"><use href="#i-globe"/></svg>') + '</div>' +
      '<div class="sc-main"><b>' + esc(w.levelName || w.name) + '</b>' +
      '<span>' + (w.instance ? esc(w.instance) + ' · 版本隔离' : '全局存档') + (w.mcVersion ? ' · ' + esc(w.mcVersion) : '') + '</span>' +
      '<span>' + fmtSizeB(w.size) + ' · ' + (w.lastPlayed ? fmtFull(w.lastPlayed) : '从未进入') + (w.hardcore ? ' · <b style="color:#e5484d">硬核</b>' : '') + '</span></div>' +
      '<div class="sc-acts">' +
      '<button class="btn ghost" data-act="preview" title="地图预览"><svg class="ic sm"><use href="#i-map"/></svg></button>' +
      '<button class="btn ghost" data-act="folder" title="打开目录"><svg class="ic sm"><use href="#i-folder"/></svg></button>' +
      '<button class="btn ghost" data-act="del" title="删除（移入回收站）"><svg class="ic sm"><use href="#i-trash"/></svg></button>' +
      '</div>');
    const select = () => { SAVE_HUB.sel = i; $$('#savesList .save-card').forEach((c, j) => c.classList.toggle('sel', j === i)); showSaveDetail(w); };
    card.addEventListener('click', (e) => { if (!e.target.closest('button')) select(); });
    card.querySelector('[data-act=preview]').addEventListener('click', select);
    card.querySelector('[data-act=folder]').addEventListener('click', () => window.lmc.openPath(w.path));
    card.querySelector('[data-act=del]').addEventListener('click', () => deleteSave(w));
    box.appendChild(card);
  });
  /* 懒加载地图缩略图（没有游戏内截图的存档用生成的地图顶上），串行避免 I/O 风暴 */
  (async () => {
    for (const [i, w] of SAVE_HUB.list.entries()) {
      if (w.icon || !w.hasRegion) continue;
      try {
        const pv = await window.lmc.savesPreview({ path: w.path });
        if (!pv.ok) continue;
        w._map = pv.png;
        const card = box.children[i];
        const thumb = card && card.querySelector('.save-thumb');
        if (thumb && !thumb.querySelector('img')) thumb.innerHTML = '<img src="' + pv.png + '" alt="">';
      } catch (_) {}
    }
  })();
}
/* 存档地图交互：滚轮以鼠标为锚点缩放 + 拖拽平移 + 双击/⟲ 复位 */
function setupMapZoom(box, img) {
  const view = el('div', 'map-view');
  img.replaceWith(view);
  view.appendChild(img);

  const tag = el('div', 'map-zoom-tag', '100%');
  const tools = el('div', 'map-tools');
  const mkBtn = (label, title, fn) => {
    const b = el('button', null, label); b.title = title; b.addEventListener('click', fn); tools.appendChild(b);
  };

  let s = 1, tx = 0, ty = 0;
  const MIN = 1, MAX = 12;
  const apply = () => {
    img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    tag.textContent = Math.round(s * 100) + '%';
    view.classList.toggle('zoomed', s > 1.001);
  };
  const reset = () => { s = 1; tx = 0; ty = 0; apply(); };

  /* 放大后限制平移范围：图片至少留 80px 在视野内，避免拖丢 */
  const clampPan = () => {
    if (s <= 1) { tx = 0; ty = 0; return; }
    const W = img.offsetWidth, H = img.offsetHeight, VW = view.clientWidth, VH = view.clientHeight;
    const bx = (VW - W) / 2, by = (VH - H) / 2;   // 布局居中偏移
    const keep = 80;
    const lo = (v, a, b) => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
    tx = lo(tx, keep - (bx + s * W), VW - keep - bx);
    ty = lo(ty, keep - (by + s * H), VH - keep - by);
  };

  const zoomAt = (cx, cy, factor) => {
    const ns = Math.min(MAX, Math.max(MIN, s * factor));
    if (Math.abs(ns - s) < 1e-4) return;
    const r = img.getBoundingClientRect();
    const px = (cx - r.left) / s, py = (cy - r.top) / s;   // 鼠标点 → 图片自身坐标
    tx += px * (s - ns);
    ty += py * (s - ns);
    s = ns;
    if (s <= 1.001) { s = 1; tx = 0; ty = 0; } else clampPan();
    apply();
  };

  view.addEventListener('wheel', (e) => {
    if (!img.offsetWidth) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  }, { passive: false });

  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    if (s <= 1 || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, tx, ty, id: e.pointerId };
    view.classList.add('dragging');
    try { view.setPointerCapture(e.pointerId); } catch (_) {}
  });
  view.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    tx = drag.tx + (e.clientX - drag.x);
    ty = drag.ty + (e.clientY - drag.y);
    clampPan(); apply();
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null; view.classList.remove('dragging');
    try { view.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  view.addEventListener('dblclick', reset);

  const midZoom = (f) => { const r = view.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); };
  mkBtn('+', '放大', () => midZoom(1.4));
  mkBtn('−', '缩小', () => midZoom(1 / 1.4));
  mkBtn('⟲', '复位（双击地图亦可）', reset);

  view.appendChild(tag);
  view.appendChild(tools);
  apply();
}

async function showSaveDetail(w) {
  const d = $('#savesDetail');
  const gameType = ['生存', '创造', '冒险'][w.gameType] || w.gameType;
  const diffZh = { peaceful: '和平', easy: '简单', normal: '普通', hard: '困难' };
  const diffTxt = w.difficultyName ? (diffZh[w.difficultyName] || w.difficultyName) : (['和平', '简单', '普通', '困难'][w.difficulty] || w.difficulty);
  const metaRows = [
    ['种子', (w.seed === null || w.seed === undefined) ? '—' : String(w.seed)],
    ['生成点', w.spawn ? 'X ' + w.spawn.x + ' · Y ' + w.spawn.y + ' · Z ' + w.spawn.z : '—'],
    ['游戏版本', w.mcVersion || '—'],
    ['模式', gameType + (w.hardcore ? ' · 硬核' : '') + ' · ' + diffTxt],
    ['已游玩', w.day + ' 个游戏日'],
    ['最后进入', w.lastPlayed ? fmtFull(w.lastPlayed) : '从未'],
    ['占用空间', fmtSizeB(w.size)],
    ['位置', w.instance ? w.instance + '（版本隔离）' : '全局 saves']
  ];
  d.innerHTML =
    '<h3 style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><svg class="ic sm"><use href="#i-map"/></svg> ' + esc(w.levelName || w.name) + '</h3>' +
    '<div class="map-box" id="saveMapBox"><div class="empty-sm">正在渲染已加载区块…</div></div>' +
    '<div class="meta-grid">' + metaRows.map(r => '<div class="k">' + r[0] + '</div><div class="v">' + esc(r[1]) + '</div>').join('') + '</div>' +
    '<div class="sc-btns">' +
    '<button class="btn primary" id="sdLaunch"><svg class="ic sm"><use href="#i-play"/></svg> 启动到此存档</button>' +
    '<button class="btn ghost" id="sdSeedMap"><svg class="ic sm"><use href="#i-external"/></svg> 种子地图</button>' +
    '<button class="btn ghost" id="sdCopySeed">复制种子</button>' +
    '<button class="btn ghost" id="sdFolder"><svg class="ic sm"><use href="#i-folder"/></svg> 打开目录</button>' +
    '<button class="btn ghost" id="sdDel" style="margin-left:auto"><svg class="ic sm"><use href="#i-trash"/></svg> 删除存档</button>' +
    '</div>';
  $('#sdLaunch').addEventListener('click', () => launchToWorld(w));
  $('#sdSeedMap').addEventListener('click', () => {
    if (w.seed === null || w.seed === undefined) { toast('该存档没有记录种子', 'warn'); return; }
    toast('正在打开种子地图（Chunkbase）…');
    window.lmc.openUrl('https://www.chunkbase.com/apps/seed-map#seed=' + w.seed);
  });
  $('#sdCopySeed').addEventListener('click', async () => {
    if (w.seed === null || w.seed === undefined) return toast('该存档没有记录种子', 'warn');
    const txt = String(w.seed);
    let okCopy = false;
    try { await navigator.clipboard.writeText(txt); okCopy = true; } catch (_) {}
    if (!okCopy) { try { okCopy = !!(await window.lmc.copyText(txt)); } catch (_) {} }
    if (okCopy) toast('种子已复制：' + txt); else toast('复制失败，请手动选择种子文本复制', 'error');
  });
  $('#sdFolder').addEventListener('click', () => window.lmc.openPath(w.path));
  $('#sdDel').addEventListener('click', () => deleteSave(w));
  const box = $('#saveMapBox');
  if (!w.hasRegion) {
    box.innerHTML = '<div class="empty-sm">该存档还没有已加载的区块（尚未进入过世界）<br><span style="font-size:11px">进一次世界后再来预览</span></div>';
    return;
  }
  async function renderMap(dimKey) {
    if (dimKey !== undefined) w._dim = dimKey;
    box.innerHTML = '<div class="empty-sm">正在渲染已加载区块…</div>';
    try {
      const pv = await window.lmc.savesPreview({ path: w.path, dim: w._dim || '' });
      if (!pv.ok) { box.innerHTML = '<div class="empty-sm">' + esc(pv.error || '渲染失败') + '</div>'; return; }
      w._map = pv.png;
      box.innerHTML = '<img src="' + pv.png + '" alt="存档地图">';
      setupMapZoom(box, box.querySelector('img'));
      const cap = el('div', 'map-cap');
      if (pv.dims && pv.dims.length > 1) {
        const sel = el('select', 'dim-sel');
        sel.innerHTML = pv.dims.map(dd =>
          '<option value="' + esc(dd.key) + '"' + (dd.key === pv.dim ? ' selected' : '') + '>' + esc(dd.label) + '（' + dd.count + ' 个区块文件）</option>').join('');
        sel.addEventListener('change', () => renderMap(sel.value));
        cap.appendChild(sel);
      }
      cap.appendChild(el('span', null,
        esc((pv.dimLabel ? '【' + pv.dimLabel + '】' : '') + 'X ' + pv.bounds.x0 + '~' + pv.bounds.x1 + ' · Z ' + pv.bounds.z0 + '~' + pv.bounds.z1 +
          ' · 已加载区块 ' + pv.chunksLoaded + ' 个 · 深色 = 未探索') + (pv.spawnPx ? ' · <b style="color:#e5484d">红十字 = 生成点</b>' : '')));
      cap.appendChild(el('em', null, '滚轮缩放 · 拖拽平移 · 双击复位'));
      box.appendChild(cap);
    } catch (e) { box.innerHTML = '<div class="empty-sm">渲染失败: ' + esc(e.message) + '</div>'; }
  }
  renderMap(w._dim || '');
}
async function deleteSave(w) {
  if (!(await askConfirm('确定删除存档「' + (w.levelName || w.name) + '」吗？', { danger: true, detail: '整个存档目录会移入系统回收站（可在回收站还原），不影响其他存档。' }))) return;
  const r = await window.lmc.savesDelete({ path: w.path });
  if (!r.ok) { toast(r.error || '删除失败', 'error'); return; }
  SAVE_HUB.list = []; SAVE_HUB.sel = -1;
  await renderSavesPage(true);
  await scanDir();   // 同步主页的存档下拉与列表
}
function launchToWorld(w) {
  if (w.instance && S.installed.some(v => v.id === w.instance)) selectVersion(w.instance, true);
  const versionId = $('#selVersion').value;
  if (!versionId) { toast('请先安装并选择一个版本', 'warn'); return; }
  S.launching = true;
  $('#btnLaunch').disabled = true;
  $('#heroState').textContent = '启动中…';
  $('#logPanel').innerHTML = '';
  appendLog('[XLC] 以存档「' + w.name + '」启动 ' + versionId + ' …', 't-dim');
  window.lmc.launch({
    versionId,
    username: $('#inpName').value.trim() || 'Steve',
    world: w.name,
    mem: S.config.memAuto === false ? S.config.mem : undefined
  }).then(r => {
    if (r && r.started === false) {
      S.launching = false;
      $('#btnLaunch').disabled = false;
      $('#heroState').textContent = '就绪';
      toast(r.error || '已有游戏正在运行，无法重复启动', 'warn');
    }
  }).catch(e => {
    toast('启动失败: ' + e.message, 'error');
    S.launching = false;
    $('#btnLaunch').disabled = false;
  });
}
$('#btnSaveHub').addEventListener('click', () => gotoPage('saves'));
$('#btnSaveBack').addEventListener('click', () => gotoPage('home'));
$('#btnSaveRefresh').addEventListener('click', () => { toast('正在重新扫描存档…'); renderSavesPage(true); });

$('#btnRescan').addEventListener('click', async () => { await scanDir(); toast('已重新扫描游戏目录'); });
/* 首页致谢：社会边Studio（点击前往抖音主页） */
$('#creditSsb').addEventListener('click', () => {
  window.lmc.openUrl('https://www.douyin.com/user/MS4wLjABAAAAMqBxn7WBQJcUA26bgPRDjk7Mgp3RZeRA7HUX3OEbLpI?from_tab_name=main');
  toast('正在打开抖音主页：社会边Studio');
});
$('#btnOpenDir').addEventListener('click', () => window.lmc.openPath(S.config.gameDir));

/* ---------------- 下载页 ---------------- */
let dlCat = 'release', dlQuery = '';
const TYPE_GROUPS = { release: ['release'], snapshot: ['snapshot'], old: ['old_beta', 'old_alpha'], all: ['release', 'snapshot', 'old_beta', 'old_alpha'] };

/* 分类指示条：绿色长条在标签下方滑动跟随当前选中项 */
function moveTabInd(tabsEl) {
  if (!tabsEl) return;
  let ind = tabsEl.querySelector('.tab-ind');
  if (!ind) { ind = document.createElement('i'); ind.className = 'tab-ind'; tabsEl.appendChild(ind); }
  const act = tabsEl.querySelector('.tab.active');
  if (!act) { ind.style.opacity = '0'; return; }
  ind.style.opacity = '1';
  ind.style.left = (act.offsetLeft + 8) + 'px';
  ind.style.width = (act.offsetWidth - 16) + 'px';
}
/* 内容区切换时的短淡入：避免整个列表「啪」地换掉（连点也能重播） */
function paneIn(el) {
  if (!el) return;
  el.classList.remove('pane-in');
  void el.offsetWidth;                    /* 强制重排 */
  el.classList.add('pane-in');
}
/* 下载页顶部标题随分类切换。
   以前标题写死为「下载游戏 · 官方版本清单…Vanilla/Fabric/Forge」，点 MOD / 整合包 /
   资源包 / 数据包 时顶栏纹丝不动 —— 用户会以为「页面没切过去，还是游戏下载」。 */
const DL_HEAD = {
  release: ['下载游戏', '官方版本清单 · 支持 <b>BMCLAPI 镜像</b> 与 Mojang 官方源 · Vanilla / Fabric / Quilt / Forge / NeoForge · <b>多线程下载</b>'],
  snapshot: ['下载游戏', '官方版本清单 · 支持 <b>BMCLAPI 镜像</b> 与 Mojang 官方源 · Vanilla / Fabric / Quilt / Forge / NeoForge · <b>多线程下载</b>'],
  old: ['下载游戏', '官方版本清单 · 支持 <b>BMCLAPI 镜像</b> 与 Mojang 官方源 · Vanilla / Fabric / Quilt / Forge / NeoForge · <b>多线程下载</b>'],
  all: ['下载游戏', '官方版本清单 · 支持 <b>BMCLAPI 镜像</b> 与 Mojang 官方源 · Vanilla / Fabric / Quilt / Forge / NeoForge · <b>多线程下载</b>'],
  mod: ['下载 MOD', '从 <b>Modrinth</b> / <b>CurseForge</b> 搜索模组，直接装入指定实例的 <b>mods</b> 文件夹'],
  modpack: ['下载整合包', '搜索整合包并一键下载安装，自动创建带加载器的实例'],
  resourcepack: ['下载资源包', '搜索资源包并装入游戏目录的 <b>resourcepacks</b>'],
  datapack: ['下载数据包', '搜索数据包并装入指定存档的 <b>datapacks</b> 文件夹（进入世界后自动生效）']
};
function updateDlHead(cat) {
  const h = DL_HEAD[cat] || DL_HEAD.release;
  const t = $('#dlTitle'), s = $('#dlSub');
  if (t) t.textContent = h[0];
  if (s) s.innerHTML = h[1];
}
$$('#dlTabs .tab').forEach(t => t.addEventListener('click', () => {
  $$('#dlTabs .tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  moveTabInd($('#dlTabs'));
  dlCat = t.dataset.cat;
  updateDlHead(dlCat);
  const res = DL_RES_TABS[dlCat];
  // 版本列表 / 各资源区三选一显示；资源类隐藏版本列表与版本搜索框
  Object.values(DL_RES_TABS).forEach(x => { $('#' + x.area).style.display = 'none'; });
  $('#verList').style.display = res ? 'none' : '';
  $('#verSearch').closest('.searchbox').style.display = res ? 'none' : '';
  if (res) {
    const area = $('#' + res.area);
    area.style.display = '';
    paneIn(area);
    const pg = res.page();
    if (!pg.loaded) { pg.loaded = true; pg.search(); } // 首次切到该 tab 自动拉热门
  } else {
    $('#verList').style.display = '';
    paneIn($('#verList'));
    renderVersionList();
  }
}));
window.addEventListener('resize', () => moveTabInd($('#dlTabs')));
$('#verSearch').addEventListener('input', () => { dlQuery = $('#verSearch').value.trim().toLowerCase(); renderVersionList(); });

async function loadManifest() {
  $('#verList').innerHTML = '<div class="empty-sm">正在获取版本清单…</div>';
  const r = await window.lmc.getManifest();
  if (!r.ok) {
    $('#verList').innerHTML = '<div class="empty-sm">清单获取失败：' + esc(r.error) + '<br>请到设置中切换下载源后重试</div>';
    return;
  }
  S.manifest = r.manifest;
  S.manifestVia = r.via;
  renderVersionList();
}
function installedIds() { return new Set(S.installed.map(v => v.id)); }
function renderVersionList() {
  const box = $('#verList');
  if (!S.manifest) return;
  box.innerHTML = '';
  const cats = TYPE_GROUPS[dlCat] || ['release'];
  let list = S.manifest.versions.filter(v => dlQuery ? v.id.toLowerCase().includes(dlQuery) : cats.includes(v.type));
  const instSet = installedIds();
  const latest = S.manifest.latest && S.manifest.latest.release;
  list.slice(0, 400).forEach(v => {
    const isLatest = v.id === latest;
    const installed = instSet.has(v.id);
    const residual = !installed && (S.broken || []).some(b => b.folder === v.id);
    const row = el('div', 'ver-row',
      '<div class="v-name">' + esc(v.id) + (isLatest ? '<span class="badge">最新</span>' : '') +
        (residual ? '<span class="badge" style="background:rgba(245,158,11,.16);color:#f59e0b" title="上次安装未完成，留下的不完整目录；点安装会自动归档并重装">残留</span>' : '') + '</div>' +
      '<div class="v-type"><span class="pill ' + esc(v.type) + '">' + esc(typeName(v.type)) + '</span></div>' +
      '<div class="v-date">' + fmtDate(v.releaseTime) + '</div>' +
      '<div class="v-act"></div>');
    const act = row.querySelector('.v-act');
    if (installed) {
      act.innerHTML = '<span class="ok-tag"><svg class="ic sm"><use href="#i-check"/></svg>已安装</span>';
      const re = el('button', 'btn ghost', '<svg class="ic sm"><use href="#i-refresh"/></svg> 再装一份');
      re.title = '重新下载安装（可修复损坏的实例）或以自定义名称再装一份';
      re.addEventListener('click', () => openInstallModal(v, true));
      act.appendChild(re);
    } else {
      const btn = el('button', 'btn primary', '<svg class="ic sm"><use href="#i-download"/></svg> 安装');
      btn.addEventListener('click', () => openInstallModal(v));
      act.appendChild(btn);
    }
    box.appendChild(row);
  });
  if (!list.length) box.innerHTML = '<div class="empty-sm">没有匹配的版本</div>';
  else if (list.length > 400) box.appendChild(el('div', 'empty-sm', '仅显示前 400 个结果，请使用搜索缩小范围'));
}

/* ---------------- 安装弹窗 ---------------- */
let modalVer = null, modalLoader = null, modalReinstall = false;
const modalMask = $('#modalMask'), modalBox = $('#modalBox');
/* 「开始安装」按钮的原始样子：安装中转后台后要能还原 */
const GO_IDLE_HTML = '<svg class="ic sm"><use href="#i-download"/></svg> 开始安装';

/* ---- 弹窗统一开合：进出场都有动画 + 遮罩点击分级 ----
 * openModal(maskClose)：
 *   maskClose === false → 该弹窗点遮罩空白不关闭（更新公告、账户引导等「必须看完/必须选择」的内容）。
 * closeModal()：先播 175ms 退场动画，再 display:none；用令牌防止「刚关又开」时旧定时器误伤新弹窗。 */
let modalClosing = false, modalCloseToken = 0;
/* 系统开了「减少动态效果」时，退场动画时长压到 0（不能让用户白等 180ms 才看到窗口消失） */
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MODAL_EXIT_MS = REDUCED_MOTION ? 0 : 180;
function openModal(maskClose) {
  modalCloseToken++;                                  /* 作废上一次没播完的关闭定时器 */
  modalClosing = false;
  modalMask.classList.remove('closing');
  modalMask.dataset.maskClose = (maskClose === false) ? 'off' : 'on';
  modalMask.style.display = 'flex';
}
function closeModal() {
  if (!modalMask || modalMask.style.display === 'none' || modalClosing) return;
  modalClosing = true;
  modalMask.classList.add('closing');
  const token = modalCloseToken;
  setTimeout(() => {
    if (token !== modalCloseToken) return;            /* 期间又打开了新弹窗 → 不要动它 */
    modalMask.style.display = 'none';
    modalMask.classList.remove('closing');
    modalClosing = false;
    const box = $('#modalBox');
    if (box) box.classList.remove('cl-wide');         /* 更新公告专用的加宽只在公告里生效 */
    if (!installingNow) { modalVer = null; modalReinstall = false; }
  }, MODAL_EXIT_MS);
}
/* 点空白但当前不允许关闭 → 抖一下给出反馈（不然用户会以为界面卡了） */
function modalNudge() {
  const box = $('#modalBox');
  if (!box) return;
  box.classList.remove('nudge');
  void box.offsetWidth;                               /* 强制重排：连点也能重播动画 */
  box.classList.add('nudge');
  setTimeout(() => box.classList.remove('nudge'), 400);
}
modalMask.addEventListener('click', e => {
  if (e.target !== modalMask) return;
  /* 下载/安装进行中：点空白不关闭（要退出请点「转入后台」，要中止请点「停止安装」） */
  if (installingNow) { modalNudge(); toast('正在下载，请用弹窗里的「转入后台」或「停止安装」按钮', 'warn'); return; }
  if (modalMask.dataset.maskClose === 'off') { modalNudge(); return; }
  closeModal();
});
/* Esc 与「点空白」同一套规则：不允许关的弹窗按 Esc 也只抖一下（不再像以前那样关得掉或关不掉全凭运气） */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || modalMask.style.display === 'none') return;
  if (installingNow) { modalNudge(); return; }
  if (modalMask.dataset.maskClose === 'off') { modalNudge(); return; }
  closeModal();
});
/* 安装中关闭弹窗 = 转入后台：主进程下载不中断，进度在右下角「下载任务」浮窗里看，完成时会 toast + 自动刷新 */
function closeToBackground() {
  closeModal();
  toast('安装已转入后台继续下载，进度见右下角「下载任务」浮窗；完成后会自动刷新版本列表', 'warn');
}

function openInstallModal(v, reinstall) {
  modalVer = v;
  modalLoader = 'Vanilla';
  modalReinstall = !!reinstall;
  /* 先清掉上一版的结果，避免用户看到别的版本残留的结论 */
  loaderCompatOverride.delete(v.id);
  renderModal();
  openModal(true);   /* 安装弹窗：没有任务在跑时点空白可以关（下载开始后由遮罩逻辑拦住） */
  /* 每次打开安装弹窗都实时查询一遍（用户要求：必须确认加载器是否适配、要实时同步）。
     默认选中 Vanilla（不需要联网），所以优先查「最可能用到」的 Fabric —— 它是新版本跟进
     最快的加载器，用户大概率会选它；其余加载器在后台并行补齐。 */
  refineLoaderCompat(v, () => { if (modalVer === v) { renderModal(); } }, { priority: 'Fabric' });
}
/* 实时确认各加载器对该版本的真实可用性，然后重渲染。
 * 除 Vanilla 外所有加载器都要查（规则差异太大，硬编码必错）；远古版没必要查。
 * 注意：不做跨次缓存，每次调用都重新联网 —— 「每次安装都要查询一次」。
 *
 * opts.priority = 当前选中的加载器名：先只查它、回来立刻重绘（用户最关心的那一条秒变确定），
 * 其余加载器在后台并行补齐，每回来一个就重绘一次。这样「… 检测中」的感知时间 = 1 个请求，
 * 而不是等最慢的那个（NeoForge 官方源被墙时以前要干等好几秒）。 */
async function refineLoaderCompat(v, rerender, opts) {
  if (!v || v.type === 'old_beta' || v.type === 'old_alpha') return; /* 远古版没必要查 */
  const priority = (opts && opts.priority && LOADER_VERSIONED[opts.priority]) ? opts.priority : null;
  const force = !(opts && opts.keepOld === true);
  if (force) loaderCompatOverride.delete(v.id);   /* 立刻失效旧结果，界面会显示「检测中」 */
  if (typeof rerender === 'function') rerender();
  const repaint = () => { if (typeof rerender === 'function') rerender(); };
  try {
    if (priority) {
      /* 第一优先：选中项单独查（并在途去重，切换来回点不会重复发请求） */
      const first = await probeOneLoader(priority, v.id, force);
      mergeLoaderResult(v.id, priority, first);
      repaint();
      /* 其余加载器后台补齐（不 await，避免拖住「选中项已经出结果」这件事） */
      const rest = Object.keys(LOADER_VERSIONED).filter(k => k !== priority);
      loaderCompatAsync(v, { kinds: rest, force, onOne: repaint }).catch(() => {});
      return;
    }
    await loaderCompatAsync(v, { force });
    repaint();
  } catch (_) {}
}
function compatOf(v) {
  const base = loaderCompat(v);
  const ov = loaderCompatOverride.get(v.id);
  return ov ? Object.assign({}, base, ov) : base;
}
/* 选中某个加载器后按需补查：结论已落地（非 pending）就什么都不做。
   在途去重（probeOneLoader）保证不会和后台那批重复发请求。 */
function maybeProbeSelected(v, _from) {
  if (!v || !modalLoader || !LOADER_VERSIONED[modalLoader]) return;
  const c = compatOf(v)[modalLoader];
  if (!c || !c.pending) return;
  const kind = modalLoader;
  probeOneLoader(kind, v.id, false).then(res => {
    mergeLoaderResult(v.id, kind, res);
    if (modalVer === v) renderModal();
  }).catch(() => {});
}
function renderModal() {
  const v = modalVer;
  const compat = compatOf(v);
  let html =
    '<h3>安装 <b>' + esc(v.id) + '</b></h3>' +
    '<div class="mmeta">' + esc(typeName(v.type)) + ' · 发布于 ' + fmtDate(v.releaseTime) + ' · 清单来源: ' + esc(S.manifestVia === 'official' ? 'Mojang 官方' : 'BMCLAPI 镜像') + '</div>' +
    (modalReinstall ? '<div class="warnbar tip">将以「覆盖安装」方式重装（可用于修复损坏的实例）；想保留原实例请在「版本名称」填一个新名字</div>' : '') +
    '<div class="field-line modal-name"><span>版本名称（留空使用默认）</span><input type="text" id="mCustomName" maxlength="60" placeholder="' + esc(v.id) + '"></div>' +
    '<div style="font-size:12.5px;color:var(--tx2);margin-bottom:10px">选择模组加载器：</div>';
  LOADERS.forEach(L => {
    const c = compat[L];
    html +=
      '<label class="loader-opt' + (L === modalLoader ? ' sel' : '') + (c.ok ? '' : ' bad') + '">' +
        '<input type="radio" name="mloader" value="' + L + '"' + (L === modalLoader ? ' checked' : '') + '>' +
        '<div class="lo-main"><b>' + L + '</b><span>' + LOADER_INFO[L] + '</span></div>' +
        '<span class="lo-stat ' + (c.ok ? 'ok' : 'bad') + '">' + (c.pending ? '… 检测中' : (c.ok ? '✓ 兼容' : (c.unknown ? '? 查询超时' : '✗ 不兼容'))) + '</span>' +
      '</label>';
  });
  html += '<div id="modalWarn"></div>';
  html += '<div class="mprog" id="mprog" style="display:none"><div class="prog"><i id="mpBar"></i></div><div class="ptext" id="mpText">准备中…</div></div>';
  html += '<div class="mfoot" id="mfoot">' +
    '<button class="btn ghost" id="mCancel">取消</button>' +
    '<button class="btn primary" id="mGo">' + GO_IDLE_HTML + '</button></div>';
  modalBox.innerHTML = html;

  modalBox.querySelectorAll('input[name=mloader]').forEach(r => {
    r.addEventListener('change', () => {
      modalLoader = r.value;
      modalBox.querySelectorAll('.loader-opt').forEach(o => o.classList.remove('sel'));
      r.closest('.loader-opt').classList.add('sel');
      updateModalWarn();
      /* 用户点了别的加载器：若它还没确定结论，立刻优先查它（回来即重绘），
         不用等后台那批排队 —— 这也是「感知变快」的关键一步。 */
      maybeProbeSelected(v, 'mloader');
    });
  });
  $('#mCancel').addEventListener('click', () => { if (installingNow) doCancelInstall(); else closeModal(); });
  $('#mGo').addEventListener('click', startInstall);
  updateModalWarn();
  if (installingNow) markInstallingFoot();   /* 下载中重绘（加载器结论回来）也要保持「转入后台 / 停止安装」 */
}
function updateModalWarn() {
  const v = modalVer;
  if (!v) return;
  const compat = compatOf(v);
  const c = compat[modalLoader];
  const w = $('#modalWarn');
  const go = $('#mGo');
  go.disabled = !c.ok;
  if (c.pending) {
    w.innerHTML = '<div class="warnbar tip">… 正在向 ' + modalLoader + ' 官方源确认 ' + esc(v.id) + ' 是否有可用构建</div>';
  } else if (!c.ok && c.unknown) {
    /* 查询超时 ≠ 不兼容：源太慢（Quilt 官方源国内 20s+）或网络抖动，别误导用户 */
    w.innerHTML = '<div class="warnbar tip">⚠ ' + modalLoader + ' 构建信息未能确认（' + esc(c.why) +
      '）—— 这不代表不兼容，可稍后重试。<button class="btn ghost sm" id="mRetryProbe" style="margin-left:8px">重新检测</button></div>';
    const rb = $('#mRetryProbe');
    if (rb) rb.addEventListener('click', () => {
      if (!modalVer) return;
      rb.disabled = true; rb.textContent = '正在重查…';
      refineLoaderCompat(modalVer, () => { if (modalVer === v) renderModal(); }, { priority: modalLoader });
    });
  } else if (!c.ok) {
    w.innerHTML = '<div class="warnbar err">✗ ' + modalLoader + ' 与 ' + esc(v.id) + ' 不兼容：' + esc(c.why) + '</div>';
  } else if (modalLoader === 'Fabric' || modalLoader === 'Quilt') {
    w.innerHTML = '<div class="warnbar tip">⚠ ' + modalLoader + ' 与 OptiFine 存在已知冲突，画质优化建议改用 Sodium / Iris 模组。</div>';
  } else if (modalLoader === 'OptiFine') {
    /* 新版 OptiFine 本质是 Forge/NeoForge 模组 —— 安装时会自动确保有前置加载器，
       然后把 OptiFine 放进该实例的 mods/（与玩家手动装法一致） */
    w.innerHTML = '<div class="warnbar tip">ℹ OptiFine 以模组形式安装：会先确保该版本装有 NeoForge 或 Forge，' +
      '再把 OptiFine 放进该实例的 mods/ 目录（与手动安装效果一致）。装好后选中该实例即可启动。</div>';
  } else {
    w.innerHTML = '';
  }
}
let installingNow = false;
/* 安装中的按钮态：主按钮变「转入后台」（点空白已拦掉，必须给用户明确出口），
   取消键变「停止安装」（红色，真能停主进程任务）。重绘弹窗时也会重新调用，保证状态不丢。 */
function markInstallingFoot() {
  const go = $('#mGo'), c = $('#mCancel');
  if (go) { go.disabled = false; go.className = 'btn ghost'; go.textContent = '转入后台'; }
  if (c) { c.disabled = false; c.className = 'btn danger'; c.textContent = '停止安装'; }
}
async function startInstall() {
  if (installingNow) { closeToBackground(); return; }   /* 下载中再点这个位置 = 转入后台 */
  installingNow = true;
  markInstallingFoot();
  $('#mprog').style.display = 'block';
  setStatus('安装中: ' + modalVer.id, true);
  try {
    const r = await window.lmc.install({ id: modalVer.id, loader: modalLoader, customName: $('#mCustomName').value.trim(), reinstall: modalReinstall });
    if (!r.started) { toast(r.reason || '任务已存在', 'warn'); installingNow = false; resetModalFoot(); }
  } catch (e) {
    toast('安装启动失败: ' + e.message, 'error');
    installingNow = false;
    resetModalFoot();
  }
}
/* 弹窗内「停止安装」：请求主进程终止该下载任务，install:done(cancelled) 回来后关弹窗 */
async function doCancelInstall() {
  if (!installingNow || !modalVer) return;
  const btn = $('#mCancel');
  if (btn) { btn.disabled = true; btn.textContent = '正在停止…'; }
  try {
    const r = await window.lmc.installCancel({ id: modalVer.id, loader: modalLoader });
    if (!r.ok) { toast(r.error || '无法停止该任务', 'warn'); installingNow = false; resetModalFoot(); }
  } catch (e) {
    toast('停止失败: ' + e.message, 'error');
    installingNow = false;
    resetModalFoot();
  }
}
function resetModalFoot() {
  const go = $('#mGo'), c = $('#mCancel');
  if (go) { go.disabled = false; go.className = 'btn primary'; go.innerHTML = GO_IDLE_HTML; }
  if (c) { c.disabled = false; c.className = 'btn ghost'; c.textContent = '取消'; }
  const p = $('#mprog'); if (p) p.style.display = 'none';
}
/* ---------------- 下载任务浮窗（PCL 式）：下载期间常驻右下角，点开可看进度/阶段/预计剩余时间 ---------------- */
const dlTask = { shown: false, exp: false, wrap: null, sum: null, bar: null, txt: null, p: 0, text: '', eta: '', speed: 0, lastP: 0, lastT: 0, done: false };
function dlTaskBuild() {
  const w = document.createElement('div');
  w.id = 'dlTaskPill';   /* 外观、进出场动画、展开过渡都在 styles.css 的 #dlTaskPill 规则里 */
  w.innerHTML =
    '<div class="dl-head">' +
    '<svg class="ic sm" style="color:#3ddc84;flex:none"><use href="#i-download"/></svg>' +
    '<b class="dl-title">下载任务</b>' +
    '<span class="dl-sum" id="dlPillSum"></span>' +
    '<span class="dl-chev" id="dlPillChev">详情 ▾</span></div>' +
    '<div class="dl-detail" id="dlPillDetail"><div>' +
    '<div class="prog" style="height:6px"><i id="dlPillBar" style="width:0%"></i></div>' +
    '<div class="dl-txt" id="dlPillTxt"></div></div></div>';
  w.addEventListener('click', () => {
    dlTask.exp = !dlTask.exp;
    w.querySelector('#dlPillChev').textContent = dlTask.exp ? '收起 ▴' : '详情 ▾';
    dlTaskRender();
  });
  document.body.appendChild(w);
  dlTask.wrap = w;
  dlTask.sum = w.querySelector('#dlPillSum');
  dlTask.bar = w.querySelector('#dlPillBar');
  dlTask.txt = w.querySelector('#dlPillTxt');
}
function dlTaskRender() {
  if (!dlTask.wrap) return;
  dlTask.wrap.classList.toggle('exp', dlTask.exp);   /* 展开/收起交给 CSS 行高过渡，不再 display 硬切 */
  dlTask.bar.style.width = dlTask.p + '%';
  dlTask.sum.textContent = dlTask.p + '%' + (dlTask.eta ? ' · ' + dlTask.eta : '');
  dlTask.txt.textContent = dlTask.text + (dlTask.eta ? ' · ' + dlTask.eta : '') + '（进度条按整体安装流程计算，各阶段快慢不同）';
}
function dlTaskShow(d) {
  const now = Date.now();
  if (dlTask.lastT && d.percent > dlTask.lastP) {
    const inst = (d.percent - dlTask.lastP) / ((now - dlTask.lastT) / 1000); /* %/秒 */
    dlTask.speed = dlTask.speed ? dlTask.speed * 0.7 + inst * 0.3 : inst;   /* 平滑速度 */
  }
  dlTask.lastP = d.percent || 0;
  dlTask.lastT = now;
  dlTask.p = d.percent || 0;
  dlTask.text = d.text || d.stage || '下载中';
  if (dlTask.speed > 0.02 && dlTask.p < 100) {
    const sec = Math.round((100 - dlTask.p) / dlTask.speed);
    dlTask.eta = sec > 90 ? '预计剩余约 ' + Math.max(1, Math.round(sec / 60)) + ' 分钟' : '预计剩余约 ' + Math.max(1, sec) + ' 秒';
  } else dlTask.eta = '';
  if (!dlTask.shown) { dlTaskBuild(); dlTask.shown = true; }
  dlTaskRender();
}
function dlTaskFinish(ok, errMsg, cancelled) {
  if (!dlTask.shown || dlTask.done) return;
  dlTask.done = true;
  dlTask.p = ok ? 100 : dlTask.p;
  dlTask.eta = '';
  dlTask.text = ok ? '✓ 下载完成' : (cancelled ? '已取消安装' : '✗ 下载失败' + (errMsg ? '：' + errMsg : ''));
  dlTask.wrap.querySelector('#dlPillSum').textContent = ok ? '100% · 完成' : '失败';
  dlTask.wrap.querySelector('#dlPillChev').textContent = '';
  dlTask.bar.style.width = dlTask.p + '%';
  dlTask.bar.style.background = ok ? '#3ddc84' : '#ff5c5c';
  dlTask.txt.textContent = dlTask.text;
  /* 结束：先淡出下滑（.out），再真正移除 —— 以前是「啪」地凭空消失 */
  setTimeout(() => { if (dlTask.wrap) dlTask.wrap.classList.add('out'); }, 3600);
  setTimeout(() => { if (dlTask.wrap) dlTask.wrap.remove(); dlTask.shown = false; dlTask.done = false; dlTask.speed = 0; dlTask.lastP = 0; dlTask.lastT = 0; }, 4000);
}

window.lmc.on('install:progress', (d) => {
  const bar = $('#mpBar'), txt = $('#mpText');
  if (bar) {
    bar.style.width = (d.percent || 0) + '%';
    txt.textContent = '[' + (d.stage || '') + '] ' + (d.text || '') + (d.percent ? ' · ' + d.percent + '%' : '');
  }
  dlTaskShow(d);
});
window.lmc.on('install:done', async (d) => {
  installingNow = false;
  dlTaskFinish(!!d.ok, d.error || '', !!d.cancelled);
  if (d.ok) {
    closeModal();
    await scanDir();
    if (d.versionId) selectVersion(d.versionId, true);
  } else if (d.cancelled) {
    closeModal(); /* 停止安装：关弹窗并刷新（半截目录会以残留徽标显示，下次安装自动归档） */
    await scanDir();
  } else {
    resetModalFoot();
  }
});

/* ---------------- 导入页 ---------------- */
$('#btnImportDir').addEventListener('click', async () => {
  const dir = await window.lmc.pickFolder();
  if (!dir) return;
  S.config = await window.lmc.saveConfig({ gameDir: dir });
  $('#setGameDir').value = dir;
  await scanDir();
  await loadManifest();
  toast('已切换游戏目录并完成扫描: ' + dir);
});

/* ---------------- 设置页 ---------------- */
$$('#page-settings input[name=src]').forEach(r => {
  r.addEventListener('change', async () => {
    if (!r.checked) return;
    S.config = await window.lmc.saveConfig({ source: r.value });
    $('#tbSource').textContent = r.value === 'official' ? '官方源' : r.value === 'custom' ? '自定义源' : 'BMCLAPI';
    updateStatusBarRight();
    toast('下载源已切换，正在刷新版本清单…');
    loadManifest();
  });
});
$('#setCustomSrc').addEventListener('change', async () => {
  const v = $('#setCustomSrc').value.trim();
  S.config = await window.lmc.saveConfig({ customSource: v, source: v ? 'custom' : 'bmclapi' });
  $('#tbSource').textContent = v ? '自定义源' : 'BMCLAPI';
  toast(v ? '已使用自定义镜像源' : '已恢复 BMCLAPI 镜像源');
  loadManifest();
});
$('#setMem').addEventListener('input', () => { $('#memVal').textContent = $('#setMem').value + ' GB'; });
$('#btnPickDir').addEventListener('click', async () => {
  const dir = await window.lmc.pickFolder();
  if (dir) $('#setGameDir').value = dir;
});
$('#btnSaveSettings').addEventListener('click', async () => {
  S.config = await window.lmc.saveConfig({
    javaPath: $('#setJavaPath').value.trim(),
    mem: parseInt($('#setMem').value, 10) || 4,
    gameDir: $('#setGameDir').value.trim(),
    username: $('#setUsername').value.trim() || 'Steve',
    dlThreads: Math.min(Math.max(parseInt($('#setDlThreads').value, 10) || 16, 1), 64)
  });
  $('#inpName').value = S.config.username;
  $('#heroName').textContent = S.config.username;
  heroHeadFor(S.config.username);
  updateStatusBarRight();
  toast('设置已保存');
  await scanDir();
});
/* 版本更新：检测 / 打开下载页 / 自动检测开关（更新源已锁定，设置页只读展示） */
$('#btnCheckUpdate').addEventListener('click', () => { UPD.autoTried = true; checkUpdateNow(false); });
$('#btnUpdOpenPage').addEventListener('click', () => {
  const u = (UPD.info && UPD.info.pageUrl) || (S.config && S.config.updateDefaultUrl) || '';
  if (!u) { toast('更新源地址缺失', 'warn'); return; }
  window.lmc.openUrl(u).catch(() => toast('无法打开下载页', 'error'));
});
/* 更新检测地址已锁定为官方下载页：输入框只读，主进程也会拒绝任何非官方地址。
   这里只做一层界面兜底 —— 万一有人用改 DOM 的方式试图写入，直接回弹官方地址。 */
function lockUpdateUrlField() {
  const el = $('#setUpdateUrl');
  if (!el) return;
  const official = () => (S.config && S.config.updateDefaultUrl) || '';
  const sync = () => { const o = official(); if (o && el.value !== o) el.value = o; };
  el.readOnly = true;
  sync();
  el.addEventListener('change', () => { sync(); if (official()) toast('更新源已锁定，不可修改', 'warn'); });
  el.addEventListener('input', sync);
}
lockUpdateUrlField();
$('#setAutoUpd').addEventListener('change', async () => {
  S.config = await window.lmc.saveConfig({ autoCheckUpdate: $('#setAutoUpd').checked });
  toast($('#setAutoUpd').checked ? '已开启启动时自动检测更新' : '已关闭启动时自动检测更新');
});
/* 更新公告：随时查看本版本改了什么 */
$('#btnUpdChangelog').addEventListener('click', () => showChangelog());
$('#btnDetectJava').addEventListener('click', detectJavaUI);
async function detectJavaUI() {
  $('#javaList').innerHTML = '<div class="empty-sm">检测中…</div>';
  const list = await window.lmc.detectJava();
  S.javaMajor = list.length ? list[0].major : null;
  updateStatusBarRight();
  const box = $('#javaList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty-sm">未检测到 Java · 请安装 Java 17+ 或手动填写路径</div>';
    return;
  }
  list.forEach(j => {
    box.appendChild(el('div', 'mini-item',
      '<div class="dot-ic"><svg class="ic sm"><use href="#i-cpu"/></svg></div>' +
      '<div class="mi-main"><b>Java ' + j.major + (j.major >= 17 ? '' : ' （低于推荐）') + '</b><span>' + esc(j.path) + '</span></div>' +
      '<button class="btn ghost mi-act">使用</button>'));
    box.lastChild.querySelector('button').addEventListener('click', () => {
      $('#setJavaPath').value = j.path;
      toast('已选择: ' + j.path);
    });
  });
}

/* 测速 */
$('#btnPing').addEventListener('click', () => pingSources(false));
$('#btnPingAuto').addEventListener('click', () => pingSources(true));
async function pingSources(autoPick) {
  const lo = $('#latOfficial'), lb = $('#latBmclapi');
  lo.textContent = '…'; lb.textContent = '…';
  lo.className = 'lat'; lb.className = 'lat';
  setStatus('正在测速…', true);
  const [ro, rb] = await Promise.all([
    window.lmc.pingSource('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'),
    window.lmc.pingSource('https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json')
  ]);
  setLat(lo, ro); setLat(lb, rb);
  setStatus('就绪');
  if (autoPick) {
    let pick = null;
    if (ro.ok && rb.ok) pick = ro.ms <= rb.ms ? 'official' : 'bmclapi';
    else if (ro.ok) pick = 'official';
    else if (rb.ok) pick = 'bmclapi';
    if (pick) {
      S.config = await window.lmc.saveConfig({ source: pick });
      $$('#page-settings input[name=src]').forEach(r => { r.checked = r.value === pick; });
      $('#tbSource').textContent = pick === 'official' ? '官方源' : 'BMCLAPI';
      updateStatusBarRight();
      toast('已自动选择最快源: ' + (pick === 'official' ? 'Mojang 官方' : 'BMCLAPI'));
      loadManifest();
    } else {
      toast('两个源均不可达，请检查网络', 'error');
    }
  }
}
function setLat(elm, r) {
  if (!r.ok) { elm.textContent = '不可达'; elm.className = 'lat fail'; return; }
  elm.textContent = r.ms + ' ms';
  elm.className = 'lat' + (r.ms > 500 ? ' slow' : '');
}

/* ---------------- MOD / 整合包下载页（Modrinth，两页共用内核） ---------------- */
const RES_PAGE_SIZE = 20;
/* 「全部」模式下自动挑一个能装 MOD 的实例：默认实例优先，其次最近启动过的带加载器实例 */
function pickModInstance() {
  const LD_OK = ['fabric', 'forge', 'quilt', 'neoforge'];
  const okList = S.installed.filter(v => v.loader && LD_OK.includes(String(v.loader).toLowerCase()));
  if (!okList.length) return '';
  const def = S.config && S.config.defaultVersion;
  if (def && okList.some(v => v.id === def)) return def;
  if (S.config && S.config.lastVersion && okList.some(v => v.id === S.config.lastVersion)) return S.config.lastVersion;
  return okList[0].id;
}
function setupResPage(cfg) {
  let query = '', timer = null, page = 1, total = 0, fallback = false;
  /* MOD 页可切换下载源：modrinth | curseforge | all（综合 = 两源合并，按下载量降序）
     默认值直接读 HTML 上带 .active 的按钮（当前是「综合」），避免两处写死互相失配 */
  let source = (function () {
    if (!cfg.sourceSel) return 'modrinth';
    const a = $(cfg.sourceSel + ' button.active');
    return (a && a.dataset.src) || 'modrinth';
  })();
  const SRC_LABEL = { modrinth: 'Modrinth', curseforge: 'CurseForge', all: '综合' };
  const srcName = () => SRC_LABEL[source] || 'Modrinth';
  /* 页面级文案里的源称呼：综合模式要说清是「两源一起查」，而不是「综合 源不可达」这种别扭说法 */
  const srcText = () => (source === 'all' ? 'Modrinth + CurseForge' : srcName());
  /* 「综合」模式下每条结果自带来源（h.src），卡片/安装/详情都按条走，不能再用页面级的 source */
  const itemSrc = (h) => ((h && h.src) ? h.src : source);
  const itemSrcLabel = (h) => SRC_LABEL[itemSrc(h)] || srcName();
  if (cfg.sourceSel) {
    $$(cfg.sourceSel + ' button').forEach(b => b.addEventListener('click', () => {
      if (source === b.dataset.src) return;
      source = b.dataset.src;
      $$(cfg.sourceSel + ' button').forEach(x => x.classList.toggle('active', x === b));
      newSearch();
    }));
  }
  const TYPE_NAME = { mod: 'MOD', modpack: '整合包', resourcepack: '资源包', datapack: '数据包' };
  const TYPE_ICON = { mod: 'i-puzzle', modpack: 'i-package', resourcepack: 'i-box', datapack: 'i-sq' };
  const typeName = TYPE_NAME[cfg.type] || cfg.type;
  const box = $(cfg.list);
  $(cfg.search).addEventListener('input', () => {
    query = $(cfg.search).value.trim();
    clearTimeout(timer);
    timer = setTimeout(newSearch, 350);
  });
  if (cfg.targetSel) $(cfg.targetSel).addEventListener('change', () => newSearch());
  function newSearch() { page = 1; fallback = false; search(); }
  function gotoPage(n) { page = n; search(fallback); }
  function targetInfo() {
    if (!cfg.targetSel) return { target: '', mc: '', ld: '', world: '', all: cfg.targetType !== 'world' };
    const v = $(cfg.targetSel).value;
    if (cfg.targetType === 'world') return { target: v, mc: '', ld: '', world: v, all: false };
    /* 「全部」= 不筛 MC 版本与加载器，全站资源都可见、可直接安装（无需先装版本） */
    if (v === '__all__') return { target: '__all__', mc: '', ld: '', world: '', all: true };
    const inst = S.installed.find(x => x.id === v);
    const LD_OK = ['fabric', 'forge', 'quilt', 'neoforge'];
    return {
      target: v,
      mc: inst ? (inst.mcVersion || inst.id) : '',
      // Vanilla 不是 Modrinth 的 MOD 分类，传上去必然 0 结果；原版实例不筛 loader，安装时再拦截
      ld: inst && LD_OK.includes(inst.loader.toLowerCase()) ? inst.loader.toLowerCase() : '',
      world: '',
      all: false
    };
  }
  async function search(forceAll) {
    box.innerHTML = '<div class="empty-sm">正在搜索 ' + esc(srcText()) + '…</div>';
    const ti = targetInfo();
    let r = await window.lmc.modrinthSearch({
      query, type: cfg.type, source,
      mcVersion: forceAll ? '' : ti.mc,
      loader: forceAll ? '' : ti.ld,
      page
    });
    let fallbackNote = '';
    // 当前版本社区暂无适配资源时，自动回退展示全站热门，安装时再严格校验
    if (r.ok && !r.hits.length && !forceAll && !fallback && (ti.mc || ti.ld)) {
      r = await window.lmc.modrinthSearch({ query, type: cfg.type, source, mcVersion: '', loader: '', page: 1 });
      fallback = true; page = 1;
      fallbackNote = esc(srcText()) + ' 暂无适配 <b>' + esc(ti.mc || '该版本') + '</b>' +
        (ti.ld ? ' (' + esc(ti.ld) + ')' : '') + ' 的' + typeName +
        '，以下为其他版本的热门内容；安装不兼容的资源时启动器会明确提示';
    }
    if (!r.ok) {
      box.innerHTML = '<div class="empty-sm">' + esc(srcText()) + ' 源不可达：' + esc(r.error) +
        (source === 'modrinth' ? '<br>（已自动尝试 api.modrinth.com 与国内镜像，请检查网络）' : '') + '</div>';
      const retry = el('button', 'btn', '重试');
      retry.style.marginTop = '10px';
      retry.addEventListener('click', () => { box.innerHTML = '<div class="empty-sm">正在搜索 ' + esc(srcText()) + '…</div>'; search(forceAll); });
      box.appendChild(retry);
      return;
    }
    total = r.total || 0;
    box.innerHTML = '';
    if (fallbackNote) box.appendChild(el('div', 'warnbar tip res-note', '⚠ ' + fallbackNote));
    if (!r.hits.length) { box.innerHTML += '<div class="empty-sm">没有匹配的资源</div>'; renderPager(); return; }
    r.hits.forEach(h => {
      /* PCL 式标题区：主标题 + 原名/版次副标题（副标题灰字小号，同行换行显示） */
      const mainTitle = esc(h.titleMain || dispTitle(h.titleZh, h.title));
      const subs = (h.titleSub || []).filter(Boolean);
      const subHtml = subs.map(s => '<span class="res-sub">' + esc(s) + '</span>').join('<span class="res-sub-sep">·</span>');
      const row = el('div', 'ver-row res-row',
        '<div class="res-ic">' + (h.icon ? '<img src="' + esc(h.icon) + '">' : '<svg class="ic"><use href="#' + (TYPE_ICON[cfg.type] || 'i-package') + '"/></svg>') + '</div>' +
        '<div class="v-name res-name">' +
          '<div class="res-title"><span class="res-title-main">' + mainTitle + '</span>' +
            (subHtml ? '<span class="res-title-subs">' + subHtml + '</span>' : '') + '</div>' +
          '<div class="res-meta"><span class="res-src" title="' + esc(itemSrcLabel(h)) + '">' + esc(itemSrcLabel(h)) + '</span>' +
            '<span class="res-dl"><svg class="ic sm"><use href="#i-download"/></svg> ' + fmtNum(h.downloads) + '</span>' +
            (h.author ? '<span class="res-author">' + esc(h.author) + '</span>' : '') + '</div>' +
          '<div class="res-desc">' + esc(h.descZh || h.desc || '') + '</div></div>' +
        '<div class="v-act"></div>');
      const act = row.querySelector('.v-act');
      const nameEl = row.querySelector('.res-name');
      nameEl.classList.add('clickable');
      nameEl.addEventListener('click', () => openResDetail(h, itemSrc(h), cfg.targetSel, typeName));
      const btnLabel = cfg.type === 'mod' ? '安装' : cfg.type === 'modpack' ? '安装整合包' : cfg.type === 'resourcepack' ? '安装资源包' : '装入选中存档';
      const btn = el('button', 'btn primary', '<svg class="ic sm"><use href="#i-download"/></svg> ' + btnLabel);
      const dbtn = el('button', 'btn ghost', '详情');
      dbtn.addEventListener('click', () => openResDetail(h, itemSrc(h), cfg.targetSel, typeName));
      btn.addEventListener('click', async () => {
        if (cfg.type === 'mod') {
          let t = $(cfg.targetSel).value;
          /* 选「全部」时没有指定实例：自动挑一个能装 MOD 的实例（优先默认实例，其次最近启动过的带加载器实例） */
          if (t === '__all__') {
            t = pickModInstance();
            if (!t) { toast('还没有带模组加载器的版本 —— 请先到「下载」页安装一个 Fabric / Forge / NeoForge 版本，或在上方「目标版本」里指定一个', 'warn'); return; }
          }
          if (!t) { toast('请先安装一个版本', 'warn'); return; }
          const ti2 = S.installed.find(v => v.id === t);
          if (ti2 && (ti2.loader === 'Vanilla' || !ti2.loader)) {
            toast('「' + t + '」是原版（无模组加载器），MOD 无法生效 —— 请先安装 Fabric / Forge 版本', 'warn');
            return;
          }
          btn.disabled = true; btn.textContent = '下载中…';
          const rr = await window.lmc.modrinthInstallMod({ projectId: h.id, versionId: t, instance: t, source: itemSrc(h) });
          btn.disabled = false; btn.innerHTML = '<svg class="ic sm"><use href="#i-download"/></svg> 安装';
          if (!rr.ok) toast('安装失败: ' + rr.error, 'error');
          else toast('已装入 ' + t + '：' + rr.file);
        } else if (cfg.type === 'modpack') {
          btn.disabled = true; btn.textContent = '下载安装中…';
          const rr = await window.lmc.modrinthInstallModpack({ projectId: h.id, name: h.title });
          dlTaskFinish(!!rr.ok, rr.error || '');
          if (!rr.ok) { toast('安装失败: ' + rr.error, 'error'); btn.disabled = false; btn.innerHTML = '<svg class="ic sm"><use href="#i-download"/></svg> 安装整合包'; return; }
          await scanDir();
          selectVersion(rr.versionId, true);
          toast('整合包就绪: ' + rr.versionId);
        } else if (cfg.type === 'resourcepack') {
          btn.disabled = true; btn.textContent = '下载中…';
          const rr = await window.lmc.modrinthInstallPack({ type: 'resourcepack', projectId: h.id });
          btn.disabled = false; btn.innerHTML = '<svg class="ic sm"><use href="#i-download"/></svg> 安装资源包';
          if (!rr.ok) toast('安装失败: ' + rr.error, 'error');
        } else { // datapack
          const w = cfg.targetSel ? $(cfg.targetSel).value : '';
          if (!w) { toast('请先选择一个存档（世界）', 'warn'); return; }
          btn.disabled = true; btn.textContent = '下载中…';
          const rr = await window.lmc.modrinthInstallPack({ type: 'datapack', projectId: h.id, world: w });
          btn.disabled = false; btn.innerHTML = '<svg class="ic sm"><use href="#i-download"/></svg> 装入选中存档';
          if (!rr.ok) toast('安装失败: ' + rr.error, 'error');
        }
      });
      act.appendChild(dbtn);
      act.appendChild(btn);
      box.appendChild(row);
    });
    renderPager();
  }
  function renderPager() {
    const pg = $(cfg.pager);
    const totalPages = Math.max(1, Math.min(Math.ceil(total / RES_PAGE_SIZE), 250));
    if (totalPages <= 1) { pg.innerHTML = total ? '<span class="pg-info">共 ' + fmtNum(total) + ' 个' + typeName + '</span>' : ''; return; }
    let html = '<button class="btn ghost"' + (page <= 1 ? ' disabled' : '') + ' id="pgPrev_' + cfg.type + '">‹ 上一页</button>';
    // 页码：首页 / 尾页 / 当前页 ±2，间隙省略
    const nums = [...new Set([1, totalPages, page - 1, page, page + 1, page - 2, page + 2])]
      .filter(n => n >= 1 && n <= totalPages).sort((a, b) => a - b);
    let last = 0;
    for (const n of nums) {
      if (n - last > 1) html += '<span class="pg-ellipsis">…</span>';
      html += '<button class="btn ghost pg-num' + (n === page ? ' pg-cur' : '') + '" data-p="' + n + '">' + n + '</button>';
      last = n;
    }
    html += '<button class="btn ghost"' + (page >= totalPages ? ' disabled' : '') + ' id="pgNext_' + cfg.type + '">下一页 ›</button>' +
      '<span class="pg-info">第 ' + page + ' / ' + totalPages + ' 页 · 共 ' + fmtNum(total) + ' 个</span>';
    pg.innerHTML = html;
    const prev = $('#pgPrev_' + cfg.type), next = $('#pgNext_' + cfg.type);
    if (prev) prev.addEventListener('click', () => gotoPage(page - 1));
    if (next) next.addEventListener('click', () => gotoPage(page + 1));
    $$(cfg.pager + ' .pg-num').forEach(b => b.addEventListener('click', () => gotoPage(+b.dataset.p)));
    pg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  return { search, refresh: newSearch, loaded: false };
}
const modPage = setupResPage({ type: 'mod', search: '#resSearch', list: '#resList', pager: '#resPager', targetSel: '#resTarget', targetType: 'version', sourceSel: '#resSource' });
const mpPage = setupResPage({ type: 'modpack', search: '#mpSearch', list: '#mpList', pager: '#mpPager' });
const rpPage = setupResPage({ type: 'resourcepack', search: '#rpSearch', list: '#rpList', pager: '#rpPager' });
const dpPage = setupResPage({ type: 'datapack', search: '#dpSearch', list: '#dpList', pager: '#dpPager', targetSel: '#dpWorld', targetType: 'world' });
/* 下载页资源类 tab → 区块/工厂实例映射 */
const DL_RES_TABS = {
  mod: { area: 'resArea', page: () => modPage },
  modpack: { area: 'mpArea', page: () => mpPage },
  resourcepack: { area: 'rpArea', page: () => rpPage },
  datapack: { area: 'dpArea', page: () => dpPage }
};
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
/* 展示标题：有中文译名且不同于原名 → 中文名（原名），否则原名 */
function dispTitle(zh, en) {
  if (zh && en && zh !== en) return zh + '（' + en + '）';
  return en || zh || '';
}

/* ---------------- 整合包导出 / 导入 ---------------- */
$('#btnExportModpack').addEventListener('click', async () => {
  const v = $('#expVersion').value;
  if (!v) { toast('请先安装一个版本', 'warn'); return; }
  const r = await window.lmc.exportModpack(v);
  if (r.canceled) return;
  if (!r.ok) { toast('导出失败: ' + r.error, 'error'); return; }
  toast('已导出（含 ' + r.mods + ' 个 MOD）');
});
$('#btnImportModpack').addEventListener('click', async () => {
  const r = await window.lmc.importModpack();
  dlTaskFinish(!!r.ok, r.error || '');
  if (r.canceled) return;
  if (!r.ok) { toast('导入失败: ' + r.error, 'error'); return; }
  await scanDir();
  selectVersion(r.versionId, true);
  if (r.warn) toast(r.warn, 'warn');
});

/* ---------------- 实例管理 ---------------- */
function renderInstances() {
  const box = $('#instList');
  if (!S.installed.length && !S.broken.length) { box.innerHTML = '<div class="empty-sm">尚未安装任何实例 —— 去「下载」页安装一个吧</div>'; return; }
  box.innerHTML = '';
  const defVer = (S.config && S.config.defaultVersion) || '';
  S.installed.forEach(v => {
    const isDefault = defVer === v.id;
    const row = el('div', 'ver-row',
      '<div class="v-name">' + esc(v.id) + (isDefault ? '<span class="badge">默认</span>' : '') + '</div>' +
      '<div class="v-type"><span class="pill release">' + esc(v.loader || 'Vanilla') + '</span></div>' +
      '<div class="v-date">' + (v.mcVersion && v.mcVersion !== v.id ? 'MC ' + esc(v.mcVersion) : '&nbsp;') + '</div>' +
      '<div class="v-act"></div>');
    const act = row.querySelector('.v-act');
    const play = el('button', 'btn primary', '<svg class="ic sm"><use href="#i-play"/></svg> 启动');
    play.addEventListener('click', () => { selectVersion(v.id, true); $('#btnLaunch').click(); });
    const rn = el('button', 'btn ghost', '重命名');
    rn.addEventListener('click', () => {
      const nameDiv = row.querySelector('.v-name');
      nameDiv.innerHTML = '<input type="text" class="rn-input" value="' + esc(v.id) + '" maxlength="64">';
      const inp = nameDiv.querySelector('input');
      inp.focus(); inp.select();
      let done = false;
      const commit = async () => {
        if (done) return; done = true;
        const nv = inp.value.trim();
        if (!nv || nv === v.id) { renderInstances(); return; }
        const r = await window.lmc.instanceRename({ from: v.id, to: nv });
        if (!r.ok) { toast('重命名失败: ' + r.error, 'error'); renderInstances(); return; }
        await scanDir(); renderInstances();
      };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') { done = true; renderInstances(); }
      });
      inp.addEventListener('blur', commit);
    });
    const del = el('button', 'btn ghost', '删除');
    del.addEventListener('click', async () => {
      if (!(await askConfirm('确定删除实例「' + v.id + '」？', { danger: true, detail: '此操作不可恢复。' }))) return;
      const r = await window.lmc.instanceDelete({ id: v.id });
      if (!r.ok) { toast('删除失败: ' + r.error, 'error'); return; }
      await scanDir(); renderInstances();
    });
    const open = el('button', 'btn ghost', '<svg class="ic sm"><use href="#i-folder"/></svg>');
    open.title = '打开实例目录';
    open.addEventListener('click', () => window.lmc.openPath((S.config.gameDir || '') + '\\versions\\' + v.id));
    act.appendChild(play); act.appendChild(rn); act.appendChild(del); act.appendChild(open);
    box.appendChild(row);
  });
  /* 残留目录（目录在但版本 JSON 缺失/损坏）：列出并允许删除，
     否则它既不会出现在版本列表里，又会永久挡住同名版本的安装 */
  S.broken.forEach(b => {
    const row = el('div', 'ver-row',
      '<div class="v-name">' + esc(b.folder) + '<span class="badge" style="background:rgba(245,158,11,.16);color:#f59e0b">残留</span></div>' +
      '<div class="v-type"><span class="pill snapshot">不完整</span></div>' +
      '<div class="v-date" title="' + esc(b.reason) + '">' + esc(b.reason) + '</div>' +
      '<div class="v-act"></div>');
    const act = row.querySelector('.v-act');
    const del = el('button', 'btn ghost', '<svg class="ic sm"><use href="#i-trash"/></svg> 删除');
    del.title = '删除这个不完整的实例目录（安装中断/其它启动器留下的残留）';
    del.addEventListener('click', async () => {
      if (!(await askConfirm('确定删除残留目录「' + b.folder + '」吗？', { danger: true, detail: '它不包含可用的版本信息（' + b.reason + '），删除后可以重新安装该版本。' }))) return;
      const r = await window.lmc.instanceDelete({ id: b.folder });
      if (!r || !r.ok) { toast('删除失败: ' + ((r && r.error) || '未知错误'), 'error'); return; }
      toast('残留目录已删除: ' + b.folder);
      await scanDir(); renderInstances();
    });
    const open = el('button', 'btn ghost', '<svg class="ic sm"><use href="#i-folder"/></svg>');
    open.title = '打开该目录';
    open.addEventListener('click', () => window.lmc.openPath(b.path));
    act.appendChild(del); act.appendChild(open);
    box.appendChild(row);
  });
}
$('#btnInstRefresh').addEventListener('click', async () => { await scanDir(); renderInstances(); toast('已刷新'); });

/* ---------------- 游戏设置 ---------------- */
$$('#gsTabs .tab').forEach(t => t.addEventListener('click', () => {
  $$('#gsTabs .tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  const g = t.dataset.gs;
  $('#gsBasic').style.display = g === 'basic' ? '' : 'none';
  $('#gsMods').style.display = g === 'mods' ? '' : 'none';
  $('#gsVer').style.display = g === 'ver' ? '' : 'none';
  paneIn(g === 'basic' ? $('#gsBasic') : g === 'mods' ? $('#gsMods') : $('#gsVer'));   /* 内容短淡入 */
  if (g === 'mods') loadMods();
  if (g === 'ver') loadVerSettings();
}));
/* ---------------- 版本管理（HMCL 式加载器更改 / 卸载 + PCL 式导出） ---------------- */
let vsInfo = null;
async function loadVerSettings() {
  const id = $('#vsInstance').value;
  const box = $('#vsInfo');
  $('#btnVsChange').disabled = $('#btnVsUninstall').disabled = $('#btnVsExport').disabled = !id;
  if (!id) { box.textContent = '没有可选实例 —— 先到「下载」页安装一个吧'; vsInfo = null; return; }
  box.textContent = '读取实例信息…';
  const r = await window.lmc.versionInfo({ id });
  if (!r.ok) { box.innerHTML = '<span style="color:var(--tx2)">读取失败: ' + esc(r.error) + '</span>'; vsInfo = null; return; }
  vsInfo = r;
  box.innerHTML =
    '加载器：<b>' + esc(r.loader) + (r.loaderVer ? ' ' + esc(r.loaderVer) : '') + '</b> · MC ' + esc(r.mcVer) +
    (r.isolated ? ' · <span class="pill release">版本隔离</span>' : '') +
    (r.hasChildren ? '<br><span style="color:#f59e0b">⚠ 被 ' + esc(r.children.join(' / ')) + ' 继承 —— 请先更改/删除子版本，再操作此实例</span>' : '');
  $('#btnVsChange').disabled = r.hasChildren;
  $('#btnVsUninstall').disabled = r.hasChildren || r.loader === 'Vanilla';
  $('#btnVsUninstall').title = r.loader === 'Vanilla' ? '已经是原版，无需卸载' : '重建为同 MC 版本的原版实例（MOD 保留但不再加载）';
}
$('#vsInstance').addEventListener('change', loadVerSettings);
$('#btnVsRefresh').addEventListener('click', async () => { await scanDir(); await loadVerSettings(); toast('已刷新'); });

function openLoaderChangeModal() {
  if (!vsInfo) return;
  const info = vsInfo;
  let sel = info.loader === 'Vanilla' ? 'Forge' : info.loader;
  const list = ['Vanilla', 'Forge', 'Fabric', 'Quilt', 'NeoForge', 'OptiFine'];
  /* 已装实例的 mcVer 是真实版本号（26.4-snapshot-2 这种）。
     先按 type:'release' 初判（只影响 ≥1.14 / ≥1.20.1 这类版本下限），
     随后联网按真实版本号确认，结论会覆盖初判。 */
  const mcEntry = (S.manifest && Array.isArray(S.manifest.versions) && S.manifest.versions.find(x => x.id === info.mcVer))
    || { id: info.mcVer, type: 'release' };
  const compat = (L) => {
    const base = loaderCompat(mcEntry);
    const ov = loaderCompatOverride.get(info.mcVer);
    const merged = ov ? Object.assign({}, base, ov) : base;
    return merged[L] || { ok: false, why: '未知加载器' };
  };
  let html =
    '<h3>更改加载器 · <b>' + esc(info.id) + '</b></h3>' +
    '<div class="mmeta">MC ' + esc(info.mcVer) + ' · 当前: ' + esc(info.loader) + (info.loaderVer ? ' ' + esc(info.loaderVer) : '') + '</div>';
  const renderOpts = () => {
    let h = '';
    list.forEach(L => {
      const c = compat(L);
      h +=
        '<label class="loader-opt' + (L === sel ? ' sel' : '') + (c.ok ? '' : ' bad') + '">' +
          '<input type="radio" name="vsloader" value="' + L + '"' + (L === sel ? ' checked' : '') + '>' +
          '<div class="lo-main"><b>' + L + '</b><span>' + LOADER_INFO[L] + '</span></div>' +
          '<span class="lo-stat ' + (c.ok ? 'ok' : 'bad') + '">' + (c.pending ? '… 检测中' : (c.ok ? '✓ 兼容' : '✗ 不兼容')) + '</span>' +
        '</label>';
    });
    return h;
  };
  html += '<div id="vsLoaderOpts">' + renderOpts() + '</div>';
  html += '<div class="field-line" id="vsBuildLine" style="display:none;margin-top:10px"><span>构建号（留空 = 最新构建）</span><input type="text" id="vsBuildInp" placeholder="如 47.2.0"></div>';
  html += '<div id="vsWarn" style="margin-top:8px"><div class="warnbar tip">⚠ 更改会重建该实例：MOD、存档、设置全部保留；安装失败自动回滚，原实例不受影响。</div></div>';
  html += '<div class="mprog" id="mprog" style="display:none"><div class="prog"><i id="mpBar"></i></div><div class="ptext" id="mpText">准备中…</div></div>';
  html += '<div class="mfoot"><button class="btn ghost" id="vsCancel">取消</button><button class="btn primary" id="vsGo"><svg class="ic sm"><use href="#i-download"/></svg> 开始更改</button></div>';
  modalBox.innerHTML = html;
  openModal(true);   /* 更改加载器弹窗：无任务跑着时点空白可关 */
  const bindRadios = () => {
    modalBox.querySelectorAll('input[name=vsloader]').forEach(r => r.addEventListener('change', () => { upd(); onPick(); }));
  };
  const upd = () => {
    const v = modalBox.querySelector('input[name=vsloader]:checked');
    if (v) sel = v.value;
    modalBox.querySelectorAll('.loader-opt').forEach(o => o.classList.remove('sel'));
    if (v) v.closest('.loader-opt').classList.add('sel');
    $('#vsBuildLine').style.display = (sel === 'Forge' || sel === 'NeoForge') ? '' : 'none';
    const c = compat(sel);
    if (c.pending) {
      $('#vsWarn').innerHTML = '<div class="warnbar tip">… 正在向 ' + sel + ' 官方源确认 ' + esc(info.mcVer) + ' 的构建</div>';
    } else {
      $('#vsWarn').innerHTML = c.ok
        ? '<div class="warnbar tip">⚠ 更改会重建该实例：MOD、存档、设置全部保留；安装失败自动回滚，原实例不受影响。</div>'
        : '<div class="warnbar err">✗ ' + sel + ' 与 ' + esc(info.mcVer) + ' 不兼容：' + esc(c.why) + '</div>';
    }
    $('#vsGo').disabled = !c.ok;
  };
  bindRadios();
  /* 切换单选时：选中的加载器若还没结论，立刻优先查（回来即重绘整组选项） */
  const onPick = () => {
    const c = compat(sel);
    if (!c || !c.pending || !LOADER_VERSIONED[sel]) return;
    const kind = sel;
    probeOneLoader(kind, info.mcVer, false).then(res => {
      mergeLoaderResult(info.mcVer, kind, res);
      const box = $('#vsLoaderOpts');
      if (!box) return;
      box.innerHTML = renderOpts();
      bindRadios();
      upd();
    }).catch(() => {});
  };
  $('#vsCancel').addEventListener('click', () => closeModal());
  /* 联网确认真实可用性后重绘选项（结论按真实 mcVer 查，不是按 type 猜）。
     优先查当前选中的加载器，其余后台补齐 —— 用户马上能看到自己目标项能否用。 */
  refineLoaderCompat(mcEntry, () => {
    const box = $('#vsLoaderOpts');
    if (!box) return;
    box.innerHTML = renderOpts();
    bindRadios();
    upd();
  }, { priority: LOADER_VERSIONED[sel] ? sel : null });
  $('#vsGo').addEventListener('click', async () => {
    $('#vsGo').disabled = true; $('#vsCancel').disabled = true;
    $('#mprog').style.display = 'block';
    $('#mpText').textContent = '正在重建实例（可能需要几分钟）…';
    const build = $('#vsBuildLine').style.display !== 'none' ? $('#vsBuildInp').value.trim() : '';
    const r = await window.lmc.loaderChange({ id: info.id, loader: sel, build });
    if (!r.ok) {
      $('#mprog').style.display = 'none';
      $('#vsGo').disabled = false; $('#vsCancel').disabled = false;
      $('#vsWarn').innerHTML = '<div class="warnbar err">✗ ' + esc(r.error) + '</div>';
      return;
    }
    closeModal();
    await scanDir();
    await loadVerSettings();
  });
  upd();
}
$('#btnVsChange').addEventListener('click', openLoaderChangeModal);
$('#btnVsUninstall').addEventListener('click', async () => {
  if (!vsInfo) return;
  if (!(await askConfirm('确定卸载实例「' + vsInfo.id + '」的 ' + vsInfo.loader + ' 加载器？', { danger: true, detail: '实例将重建为原版 MC ' + vsInfo.mcVer + '（实例名不变，MOD 文件保留但不再被加载）。此操作不可撤销。' }))) return;
  const btn = $('#btnVsUninstall');
  btn.disabled = true;
  $('#vsInfo').textContent = '正在重建原版实例…';
  const r = await window.lmc.loaderUninstall({ id: vsInfo.id });
  if (!r.ok) { toast('卸载失败: ' + r.error, 'error'); await loadVerSettings(); return; }
  await scanDir();
  await loadVerSettings();
});

/* PCL 式导出选项弹窗（勾选打包内容） */
function openExportModal(versionId) {
  if (!versionId) { toast('请先安装一个版本', 'warn'); return; }
  const items = [
    ['mods', 'MOD', 'mods 目录里的全部 jar'],
    ['config', '配置', 'config 目录（模组配置）'],
    ['resourcepacks', '资源包', 'resourcepacks 目录'],
    ['shaderpacks', '光影', 'shaderpacks 目录'],
    ['saves', '存档', 'saves 目录（体积可能很大）'],
    ['options.txt', '选项设置', 'options.txt（按键/画质/语言等）']
  ];
  let html = '<h3>导出整合包 · <b>' + esc(versionId) + '</b></h3>' +
    '<div class="mmeta">勾选要打包进 .lmcmod 的内容（模拟 PCL 导出）：对端用 XLC 导入后自动还原</div>';
  items.forEach(([k, name, desc], i) => {
    const def = k === 'saves' ? false : true;
    html +=
      '<label class="loader-opt' + (def ? ' sel' : '') + '">' +
        '<input type="checkbox" name="expinc" value="' + k + '"' + (def ? ' checked' : '') + '>' +
        '<div class="lo-main"><b>' + name + '</b><span>' + esc(desc) + '</span></div>' +
        '<span class="lo-stat ok">' + (k === 'options.txt' ? '单文件' : '目录') + '</span>' +
      '</label>';
  });
  html += '<div class="mprog" id="mprog" style="display:none"><div class="prog"><i id="mpBar"></i></div><div class="ptext" id="mpText">打包中…</div></div>';
  html += '<div class="mfoot"><button class="btn ghost" id="expCancel">取消</button><button class="btn primary" id="expGo"><svg class="ic sm"><use href="#i-upload"/></svg> 选择保存位置并导出</button></div>';
  modalBox.innerHTML = html;
  openModal(true);   /* 导出整合包弹窗 */
  modalBox.querySelectorAll('input[name=expinc]').forEach(c => {
    c.addEventListener('change', () => c.closest('.loader-opt').classList.toggle('sel', c.checked));
  });
  $('#expCancel').addEventListener('click', () => closeModal());
  $('#expGo').addEventListener('click', async () => {
    const include = [...modalBox.querySelectorAll('input[name=expinc]:checked')].map(c => c.value).filter(k => k !== 'options.txt');
    const includeOptions = modalBox.querySelector('input[name=expinc][value="options.txt"]').checked;
    if (!include.length && !includeOptions) { toast('至少勾选一项内容', 'warn'); return; }
    $('#expGo').disabled = true; $('#expCancel').disabled = true;
    $('#mprog').style.display = 'block';
    $('#mpText').textContent = '正在打包（' + (include.join(' + ') || '基础') + '）…';
    const r = await window.lmc.exportModpack(versionId, { include, includeOptions });
    if (r.canceled) { closeModal(); return; }
    if (!r.ok) {
      $('#mprog').style.display = 'none';
      $('#expGo').disabled = false; $('#expCancel').disabled = false;
      $('#mpText').textContent = '导出失败: ' + r.error;
      return;
    }
    closeModal();
    if (r.warns && r.warns.length) toast('部分文件被跳过: ' + r.warns.join('、'), 'warn');
    else toast('已导出（含 ' + r.mods + ' 个 MOD）');
  });
}
$('#btnVsExport').addEventListener('click', () => openExportModal($('#vsInstance').value));

/* ---------------- 自定义文件下载 ---------------- */
function openCustomDlModal() {
  const instOpts = S.installed.filter(v => v.loader && v.loader !== 'Vanilla')
    .map(v => '<option value="' + esc(v.id) + '">' + esc(v.id) + '</option>').join('');
  let html = '<h3><svg class="ic sm"><use href="#i-upload"/></svg> 自定义文件下载</h3>' +
    '<div class="mmeta">粘贴任意 http(s) 直链（多线程分块下载），保存到游戏目录对应位置</div>' +
    '<div class="field-line" style="margin-top:10px"><span>下载地址</span><input type="text" id="cdUrl" placeholder="https://example.com/mod-file.jar" spellcheck="false"></div>' +
    '<div class="field-line"><span>保存到</span><select id="cdTarget">' +
      '<option value="mods">MOD 目录（mods）</option>' +
      '<option value="resourcepacks">资源包目录（resourcepacks）</option>' +
      '<option value="shaderpacks">光影目录（shaderpacks）</option>' +
      '<option value="pick">自选位置（另存为）</option>' +
    '</select></div>' +
    '<div class="field-line" id="cdInstRow" style="display:none"><span>目标实例（版本隔离 mods）</span><select id="cdInst">' +
      (instOpts || '<option value="">（无带加载器的实例 → 存全局 mods）</option>') +
    '</select></div>' +
    '<div id="cdWarn"></div>' +
    '<div class="mprog" id="mprog" style="display:none"><div class="prog"><i id="mpBar"></i></div><div class="ptext" id="mpText">下载中…</div></div>' +
    '<div class="mfoot"><button class="btn ghost" id="cdCancel">取消</button><button class="btn primary" id="cdGo"><svg class="ic sm"><use href="#i-download"/></svg> 开始下载</button></div>';
  modalBox.innerHTML = html;
  openModal(true);   /* 下载 MOD 弹窗 */
  $('#cdTarget').addEventListener('change', () => {
    $('#cdInstRow').style.display = $('#cdTarget').value === 'mods' ? '' : 'none';
  });
  $('#cdCancel').addEventListener('click', () => closeModal());
  $('#cdGo').addEventListener('click', async () => {
    const url = $('#cdUrl').value.trim();
    if (!/^https?:\/\//i.test(url)) { $('#cdWarn').innerHTML = '<div class="warnbar err">✗ 请输入有效的 http(s) 下载地址</div>'; return; }
    $('#cdGo').disabled = true; $('#cdCancel').disabled = true;
    $('#mprog').style.display = 'block';
    $('#mpText').textContent = '下载中（多线程）…';
    const r = await window.lmc.customDownload({
      url,
      target: $('#cdTarget').value,
      instance: $('#cdInst') ? $('#cdInst').value : ''
    });
    if (r.canceled) { closeModal(); return; }
    if (!r.ok) {
      dlTaskFinish(false, r.error || '');
      $('#mprog').style.display = 'none';
      $('#cdGo').disabled = false; $('#cdCancel').disabled = false;
      $('#cdWarn').innerHTML = '<div class="warnbar err">✗ ' + esc(r.error) + '</div>';
      return;
    }
    dlTaskFinish(true, '');
    closeModal();
    toast('文件已下载: ' + r.path);
  });
}
$('#btnCustomDl').addEventListener('click', openCustomDlModal);

$('#gsMemAuto').addEventListener('change', () => {
  const auto = $('#gsMemAuto').checked;
  $('#gsMemManualRow').style.display = auto ? 'none' : '';
  if (auto) refreshMemHint();
});
$('#gsMem').addEventListener('input', () => { $('#gsMemVal').textContent = $('#gsMem').value + ' GB'; });
$('#btnSaveGs').addEventListener('click', async () => {
  S.config = await window.lmc.saveConfig({
    defaultVersion: $('#gsDefaultVer').value,
    memAuto: $('#gsMemAuto').checked,
    mem: parseInt($('#gsMem').value, 10) || 4,
    jvmArgs: $('#gsJvm').value.trim(),
    forceChinese: $('#gsChinese').checked
  });
  updateStatusBarRight();
  toast('游戏设置已保存');
});

/* MOD 管理（PCL 式：支持版本隔离；VersePC 式在线图标/名称 + PCL 式详情卡） */
let currentMods = [], currentModsMeta = {};
async function loadMods() {
  const box = $('#modList');
  const instance = $('#modTarget').value || '';
  box.innerHTML = '<div class="empty-sm">正在读取 MOD 目录…</div>';
  const r = await window.lmc.modsList({ instance });
  if (!r.ok) { box.innerHTML = '<div class="empty-sm">读取失败: ' + esc(r.error) + '</div>'; return; }
  const mods = r.mods;
  currentMods = mods; currentModsMeta = {};
  const sum = $('#modsSummary');
  sum.style.display = mods.length ? '' : 'none';
  sum.innerHTML = '「' + esc(instance || '全局 mods 目录') + '」共 <b>' + mods.length + '</b> 个 MOD · 启用 <b>' + mods.filter(m => !m.disabled).length + '</b> · 禁用 <b>' + mods.filter(m => m.disabled).length + '</b>（禁用只是改名 .disabled，不删文件）';
  renderModRows(instance);
  if (!mods.length) return;
  /* 异步富化：批量读 jar 元数据 + Modrinth 匹配，回来后带图标重渲染 */
  const er = await window.lmc.modsEnrich({ instance, names: mods.map(m => m.name) });
  if (er.ok && $('#modTarget').value === instance && currentMods === mods) {
    currentModsMeta = er.meta || {};
    renderModRows(instance);
  }
}
function renderModRows(instance) {
  const box = $('#modList');
  const on = currentMods.filter(m => !m.disabled).length;
  const sum = $('#modsSummary');
  sum.style.display = currentMods.length ? '' : 'none';
  if (currentMods.length) sum.innerHTML = '「' + esc(instance || '全局 mods 目录') + '」共 <b>' + currentMods.length + '</b> 个 MOD · 启用 <b>' + on + '</b> · 禁用 <b>' + (currentMods.length - on) + '</b>（禁用只是改名 .disabled，不删文件）';
  box.innerHTML = '';
  if (!currentMods.length) { box.innerHTML = '<div class="empty-sm">' + (instance ? '该实例的 mods 目录为空' : 'MOD 目录为空') + ' —— 到「下载 → MOD」安装一些吧</div>'; return; }
  currentMods.forEach(m => {
    const meta = currentModsMeta[m.name] || {};
    const title = dispTitle(meta.online && meta.online.titleZh, meta.online && meta.online.title) || (meta.local && meta.local.name) || m.name.replace(/\.jar(\.disabled)?$/i, '');
    const desc = (meta.online && meta.online.description) || (meta.local && meta.local.description) || '';
    const icon = (meta.online && meta.online.iconDataUri) || meta.localIconDataUri || '';
    const row = el('div', 'ver-row mod-row' + (m.disabled ? ' mod-off' : ''));
    row.innerHTML =
      '<div class="mod-ic-wrap">' + (icon ? '<img class="mod-ic" src="' + icon + '" alt="">' : '<div class="mod-ic ph"><svg class="ic"><use href="#i-puzzle"/></svg></div>') + '</div>' +
      '<div class="mod-main">' +
        '<div class="mod-title"><b>' + esc(title) + '</b>' + (meta.version ? '<span class="pill release">' + esc(meta.version) + '</span>' : '') + '</div>' +
        '<div class="mod-file">' + esc(m.name) + ' · ' + (m.size / 1048576).toFixed(1) + ' MB' + (meta.loaders && meta.loaders.length ? ' · ' + esc(meta.loaders.join('/')) : '') + '</div>' +
        (desc ? '<p class="mod-desc">' + esc(desc) + '</p>' : '') +
      '</div>' +
      '<div class="v-type"><span class="pill ' + (m.disabled ? 'old_beta' : 'release') + '">' + (m.disabled ? '已禁用' : '启用中') + '</span></div>' +
      '<div class="v-act"></div>';
    const act = row.querySelector('.v-act');
    const info = el('button', 'btn ghost', '详情');
    info.addEventListener('click', () => openModDetail(m, instance));
    const tg = el('button', 'btn ghost', m.disabled ? '启用' : '禁用');
    tg.addEventListener('click', async () => {
      const rr = await window.lmc.modsToggle({ name: m.name, instance });
      if (rr.ok) loadMods(); else toast('操作失败: ' + rr.error, 'error');
    });
    const del = el('button', 'btn ghost', '删除');
    del.addEventListener('click', async () => {
      if (!(await askConfirm('删除 MOD「' + m.name + '」？', { danger: true }))) return;
      const rr = await window.lmc.modsDelete({ name: m.name, instance });
      if (rr.ok) loadMods(); else toast('删除失败: ' + rr.error, 'error');
    });
    act.appendChild(info); act.appendChild(tg); act.appendChild(del);
    box.appendChild(row);
  });
}
/* PCL 式 MOD 详情卡 */
function openModDetail(m, instance) {
  const meta = currentModsMeta[m.name] || {};
  const local = meta.local || {}, online = meta.online || {};
  const title = dispTitle(online.titleZh, online.title) || local.name || m.name.replace(/\.jar(\.disabled)?$/i, '');
  const desc = online.descZh || online.description || local.description || '（没有找到该 MOD 的简介信息）';
  const icon = online.iconDataUri || '';
  const gv = meta.gameVersions || [];
  const gvText = gv.length ? (gv.length > 3 ? gv.slice(0, 3).join(', ') + ' 等 ' + gv.length + ' 个' : gv.join(', ')) : '';
  modalVer = null;
  modalBox.innerHTML =
    '<h3><svg class="ic sm"><use href="#i-puzzle"/></svg> MOD 详情</h3>' +
    '<div class="mod-detail">' +
      '<div class="md-head">' +
        (icon ? '<img class="md-icon" src="' + icon + '" alt="">' : '<div class="md-icon ph"><svg class="ic"><use href="#i-puzzle"/></svg></div>') +
        '<div class="md-title"><b>' + esc(title) + '</b>' +
          '<div class="md-pills">' +
            (meta.version ? '<span class="pill release">' + esc(meta.version) + '</span>' : '') +
            (meta.loaders && meta.loaders.length ? '<span class="pill">' + esc(meta.loaders.join(' / ')) + '</span>' : '') +
            '<span class="pill ' + (m.disabled ? 'old_beta' : 'release') + '">' + (m.disabled ? '已禁用' : '启用中') + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<p class="md-desc">' + esc(desc) + '</p>' +
      '<div class="md-meta">' +
        '<div><span>文件</span><b>' + esc(m.name) + '</b></div>' +
        '<div><span>所属实例</span><b>' + esc(instance || '全局 mods 目录') + '</b></div>' +
        '<div><span>大小</span><b>' + (meta.size != null ? (meta.size / 1048576).toFixed(2) + ' MB' : (m.size / 1048576).toFixed(2) + ' MB') + '</b></div>' +
        (local.id ? '<div><span>Mod ID</span><b>' + esc(local.id) + '</b></div>' : '') +
        (local.authors ? '<div><span>作者</span><b>' + esc(local.authors) + '</b></div>' : '') +
        (gvText ? '<div><span>支持版本</span><b>' + esc(gvText) + '</b></div>' : '') +
        (meta.sha1 ? '<div><span>SHA1</span><b class="mono">' + esc(meta.sha1.slice(0, 16)) + '…</b></div>' : '') +
      '</div>' +
      (online.title || local.description ? '' : '<div class="warnbar tip">该 MOD 未在 Modrinth 收录或离线状态，仅显示文件内置信息</div>') +
    '</div>' +
    '<div class="mfoot">' +
      '<button class="btn ghost" id="mdClose">关闭</button>' +
      (online.pageUrl ? '<button class="btn primary" id="mdOpen"><svg class="ic sm"><use href="#i-external"/></svg> 查看 Modrinth 页面</button>' : '') +
    '</div>';
  openModal(true);   /* MOD 详情弹窗 */
  $('#mdClose').addEventListener('click', closeModal);
  const ob = $('#mdOpen');
  if (ob) ob.addEventListener('click', () => window.lmc.openUrl(online.pageUrl));
}
$('#btnModsRefresh').addEventListener('click', () => loadMods());
/* 下载页 PCL 式详情：源站简介 + 截图 + 适配文件列表 + 外链（CurseForge / MC 百科 / Modrinth） */
const WIKI_SEARCH = t => 'https://zh.minecraft.wiki/w/Special:%E6%90%9C%E7%B4%A2?search=' + encodeURIComponent(t);
async function openResDetail(h, source, targetSel, typeName) {
  modalVer = null;
  modalBox.innerHTML = '<h3><svg class="ic sm"><use href="#i-puzzle"/></svg> 详情</h3><div class="empty-sm">正在加载详情…</div>';
  openModal(true);   /* 资源详情：先显示占位，详情取回后重绘 */
  /* 「全部」= 不指定实例：详情列出全部文件，安装时自动挑一个带加载器的实例 */
  const rawTid = targetSel ? $(targetSel).value : '';
  const allMode = rawTid === '__all__';
  const tid = allMode ? '' : rawTid;
  const r = await window.lmc.modrinthDetail({ source, projectId: h.id, versionId: tid });
  if (!r.ok) {
    modalBox.innerHTML = '<h3><svg class="ic sm"><use href="#i-puzzle"/></svg> 详情</h3>' +
      '<div class="empty-sm">详情加载失败：' + esc(r.error || '') + '</div>' +
      '<div class="mfoot"><button class="btn ghost" id="mdClose">关闭</button></div>';
    $('#mdClose').addEventListener('click', closeModal);
    return;
  }
  /* PCL 式详情标题：中文名作主标题，英文原名/版次作副标题 */
  const rawTitle = r.title || h.title || '';
  const zhForTitle = h.titleZh || '';
  const titleMain = zhForTitle && zhForTitle !== rawTitle ? zhForTitle.split(' (')[0] : (rawTitle || zhForTitle);
  const titleSubs = (h.titleSub && h.titleSub.length) ? h.titleSub : (zhForTitle && zhForTitle !== rawTitle ? [rawTitle] : []);
  const titleHtml = esc(titleMain) + titleSubs.filter(Boolean)
    .map(s => '<span class="md-title-sub">' + esc(s) + '</span>').join('');
  const metaBits = [fmtNum(r.downloads || h.downloads || 0) + ' 下载'];
  if (h.author) metaBits.unshift('作者 ' + h.author);
  (r.tags || []).forEach(t => metaBits.push(t));
  const links = [];
  if (r.pageUrl) links.push('<button class="btn primary" id="mdSrc"><svg class="ic sm"><use href="#i-external"/></svg> ' + (source === 'curseforge' ? 'CurseForge 页面' : 'Modrinth 页面') + '</button>');
  links.push('<button class="btn ghost" id="mdWiki"><svg class="ic sm"><use href="#i-globe"/></svg> MC 百科</button>');
  if (r.sourceUrl) links.push('<button class="btn ghost" id="mdRepo"><svg class="ic sm"><use href="#i-globe"/></svg> 源代码</button>');
  const filesHtml = (r.files && r.files.length)
    ? '<div class="md-files"><div class="md-sec">适配 ' + esc(tid || '全部版本') + ' 的文件（最新 ' + r.files.length + ' 个，点击行内按钮安装到' + (allMode ? '自动选择的实例' : '目标实例') + '）</div>' +
      r.files.map((f, i) =>
        '<div class="ver-row md-frow"><div class="v-name">' + esc(f.name) +
        '<span class="res-meta">' + fmtDate(f.date) + ' · ' + ((f.size || 0) / 1048576).toFixed(2) + ' MB' +
        (f.tags && f.tags.length ? ' · ' + esc(f.tags.join(' / ')) : '') + '</span></div>' +
        '<div class="v-act"><button class="btn ghost md-fi" data-fi="' + i + '">安装</button></div></div>').join('') + '</div>'
    : (tid ? '<div class="warnbar tip">没有查到适配该版本的文件记录</div>' : '');
  const galHtml = (r.gallery && r.gallery.length) ? '<div class="md-gallery">' + r.gallery.map(u => '<img src="' + u + '" alt="">').join('') + '</div>' : '';
  modalBox.innerHTML =
    '<h3><svg class="ic sm"><use href="#i-puzzle"/></svg> ' + esc(typeName || '资源') + '详情</h3>' +
    '<div class="mod-detail">' +
      '<div class="md-head">' +
        (r.icon ? '<img class="md-icon" src="' + r.icon + '" alt="">' : '<div class="md-icon ph"><svg class="ic"><use href="#i-puzzle"/></svg></div>') +
        '<div class="md-title"><b>' + titleHtml + '</b><div class="md-pills">' +
          metaBits.map(x => '<span class="pill">' + esc(x) + '</span>').join('') + '</div></div>' +
      '</div>' +
      '<div class="md-linkrow">' + links.join('') + '</div>' +
      galHtml +
      (r.descHtml ? '<div class="md-html">' + r.descHtml + '</div>' : '<p class="md-desc">（暂无详细介绍）</p>') +
      filesHtml +
    '</div>' +
    '<div class="mfoot"><button class="btn ghost" id="mdClose">关闭</button></div>';
  $('#mdClose').addEventListener('click', closeModal);
  const sBtn = $('#mdSrc'); if (sBtn) sBtn.addEventListener('click', () => window.lmc.openUrl(r.pageUrl));
  const wBtn = $('#mdWiki'); if (wBtn) wBtn.addEventListener('click', () => window.lmc.openUrl(WIKI_SEARCH(h.title || r.title || '')));
  const rBtn = $('#mdRepo'); if (rBtn) rBtn.addEventListener('click', () => window.lmc.openUrl(r.sourceUrl));
  /* 中文翻译二阶段：先出原文，译完无缝替换；CF 的完整描述（cfwidget）到达后再翻一次 */
  const applyTr = (html) => { const el2 = modalBox.querySelector('.md-html'); if (el2 && html) el2.innerHTML = html; };
  window.lmc.modrinthTranslate({ projectId: h.id }).then(tr => {
    if (tr && tr.ok && !tr.alreadyZh && tr.descHtml) applyTr(tr.descHtml);
  }).catch(() => {});
  if (source === 'curseforge' && r.slug) {
    window.lmc.modrinthCfDesc({ slug: r.slug }).then(async d2 => {
      if (d2 && d2.ok && d2.descHtml && d2.descHtml.length > 100) {
        applyTr(d2.descHtml);
        const tr = await window.lmc.modrinthTranslate({ projectId: h.id }).catch(() => null);
        if (tr && tr.ok && !tr.alreadyZh && tr.descHtml) applyTr(tr.descHtml);
      }
    }).catch(() => {});
  }
  modalBox.querySelectorAll('button.md-fi').forEach(b => b.addEventListener('click', async () => {
    const f = r.files[+b.dataset.fi];
    /* 「全部」模式下未指定实例 → 自动挑一个带加载器的实例 */
    let tgt = tid;
    if (!tgt) {
      if (allMode) {
        tgt = pickModInstance();
        if (!tgt) { toast('还没有带模组加载器的版本 —— 请先安装一个 Fabric / Forge / NeoForge 版本', 'warn'); return; }
      } else { toast('请先在下载页选择目标版本', 'warn'); return; }
    }
    b.disabled = true; b.textContent = '下载中…';
    const rr = await window.lmc.modrinthInstallMod({ projectId: h.id, versionId: tgt, instance: tgt, source, fileRef: f.ref });
    b.disabled = false; b.textContent = '安装';
    if (!rr.ok) toast('安装失败: ' + rr.error, 'error');
    else toast('已装入 ' + tgt + '：' + rr.file);
  }));
}
$('#modTarget').addEventListener('change', () => loadMods());
$('#btnModsOpen').addEventListener('click', () => {
  const instance = $('#modTarget').value || '';
  window.lmc.openPath(instance
    ? (S.config.gameDir || '') + '\\versions\\' + instance + '\\mods'
    : (S.config.gameDir || '') + '\\mods');
});

/* ---------------- 账户（多账户 / 自定义皮肤） ---------------- */
function syncAccountUI(activeName) {
  if (activeName) {
    $('#inpName').value = activeName;
    $('#heroName').textContent = activeName;
    $('#avatar').textContent = (activeName || 'S').charAt(0).toUpperCase();
    $('#setUsername').value = activeName;
    heroHeadFor(activeName);
  }
}
function accBtn(label, fn) {
  const b = el('button', 'btn ghost', label);
  b.addEventListener('click', fn);
  return b;
}
async function applyAccounts(r, okMsg) {
  if (r && r.ok) {
    if (okMsg) toast(okMsg);
    syncAccountUI(r.active);
    renderAccounts(r.accounts, r.active);
  } else if (r && !r.canceled) {
    toast(r.error || '操作失败', 'error');
  }
}
/* 主页头像：从当前账户的离线皮肤 PNG 裁出头部（面部 8,8 + 帽子/头发行 40,8）按像素风放大绘制
 * 皮肤可能是 64x64（含独立帽子层）或 64x32（旧版，无独立层），无皮肤时画默认头像兜底 */
/* 默认头像 = 标准 Minecraft 史蒂夫（官方皮肤配色，无自定义皮肤时使用）
 * 8x8 网格：眼睛留白一格（史蒂夫是 2px 宽的白眼 + 2px 蓝瞳） */
function drawSteveHead(ctx, u) {
  const S = {
    skin: '#b5836c',   /* 史蒂夫肤色 */
    shade: '#9c6f58',  /* 面部阴影 */
    hair: '#1f1409',   /* 深棕头发 */
    eyeW: '#ffffff',   /* 眼白 */
    iris: '#3b2c8f',   /* 蓝瞳 */
    brow: '#4b2f1c',   /* 眉 / 鼻影 */
    mouth: '#6b4535',  /* 嘴 */
    beard: '#2d1c10'   /* 下巴胡茬 */
  };
  const rect = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(u * x, u * y, u * w, u * h); };
  rect(0, 0, 8, 8, S.skin);
  /* 头发：顶部一整层 + 两侧鬓角向下 */
  rect(0, 0, 8, 2, S.hair);
  rect(0, 0, 1, 3, S.hair); rect(7, 0, 1, 3, S.hair);
  rect(0, 3, 1, 1, S.shade); rect(7, 3, 1, 1, S.shade);
  /* 眉毛 */
  rect(1, 2.6, 2, 0.5, S.brow); rect(5, 2.6, 2, 0.5, S.brow);
  /* 眼睛：眼白 + 蓝瞳（史蒂夫瞳色偏右） */
  rect(1, 3.2, 2, 1, S.eyeW); rect(5, 3.2, 2, 1, S.eyeW);
  rect(1.6, 3.2, 1.2, 1, S.iris); rect(5.6, 3.2, 1.2, 1, S.iris);
  /* 鼻影 + 嘴 + 下巴胡茬 */
  rect(3.4, 4.4, 1.2, 0.8, S.brow);
  rect(3, 5.6, 2, 0.6, S.mouth);
  rect(2.5, 6.6, 3, 0.6, S.beard);
}
function renderHeroHead(dataUrl) {
  const cv = $('#heroHead');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, u = W / 8;   /* 面部按 8x8 像素网格缩放 */
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  /* 没有自定义皮肤 → 画标准史蒂夫头像（不是抽象占位） */
  const drawDefault = () => { ctx.clearRect(0, 0, W, H); drawSteveHead(ctx, u); };
  if (!dataUrl) { drawDefault(); return; }
  const img = new Image();
  img.onload = () => {
    const legacy = img.width === 64 && img.height === 32;   /* 旧版皮肤没有独立帽子层 */
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 8, 8, 8, 8, 0, 0, W, H);             /* 面部 */
    if (!legacy) ctx.drawImage(img, 40, 8, 8, 8, 0, 0, W, H); /* 帽子/头发层（透明处自然叠加） */
  };
  img.onerror = drawDefault;
  img.src = dataUrl;
}
/* 按玩家名找账户皮肤并刷新主页头像；返回用到的皮肤 dataURL（无则 null） */
function heroHeadFor(name) {
  const list = S.accounts || [];
  const a = list.find(x => x.name === (name || ''));
  renderHeroHead(a ? a.skinUrl : null);
  const wrap = $('#heroHeadWrap');
  if (wrap) wrap.title = (a && a.skinUrl ? '当前皮肤头像：' : '默认皮肤头像（史蒂夫）：') + (name || 'Steve');
  return (a && a.skinUrl) || null;
}
/* 启动时只刷主页头像：拉一次账户列表，不动账户页、不触发「还没账户」引导提示 */
async function loadHeroHead() {
  try {
    const r = await window.lmc.accountList();
    if (r && r.ok) {
      S.accounts = r.accounts || [];
      heroHeadFor(r.active);
      const av = $('#avatar');   /* 侧栏左下角的字母头像也跟随当前账户 */
      if (av) av.textContent = ((r.active || 'S').charAt(0) || 'S').toUpperCase();
      return;
    }
  } catch (_) {}
  renderHeroHead(null);
}
/* 皮肤前视图绘制（64x64 / 64x32 均支持，含帽子层） */
function renderSkinPreview(dataUrl) {
  const cv = $('#skinPreview');
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!dataUrl) {
    /* 默认史蒂夫全身（经典 4px 手臂配色），未上传皮肤时展示标准形象 */
    const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
    const SKIN = '#b5836c', SKIN2 = '#9c6f58', HAIR = '#1f1409', EYEW = '#ffffff', IRIS = '#3b2c8f';
    const SHIRT = '#00afaf', SHIRT2 = '#00a0a0';     /* 史蒂夫青色上衣 */
    const PANTS = '#3f3fbf', PANTS2 = '#3535a8';     /* 蓝色裤子 */
    const SHOE = '#6b6b6b';
    /* 头（80x80 / 8px 网格） */
    px(40, 0, 80, 80, SKIN);
    px(40, 0, 80, 20, HAIR); px(40, 0, 10, 30, HAIR); px(110, 0, 10, 30, HAIR);
    px(50, 26, 20, 5, '#4b2f1c'); px(90, 26, 20, 5, '#4b2f1c');
    px(50, 32, 20, 10, EYEW); px(90, 32, 20, 10, EYEW);
    px(56, 32, 12, 10, IRIS); px(96, 32, 12, 10, IRIS);
    px(74, 44, 12, 8, SKIN2); px(70, 56, 20, 6, '#6b4535'); px(65, 66, 30, 6, '#2d1c10');
    /* 躯干 */
    px(40, 84, 80, 116, SHIRT); px(40, 84, 80, 10, SHIRT2);
    /* 双臂（经典 4px：前后各一） */
    px(0, 84, 40, 116, SHIRT); px(0, 190, 40, 10, SKIN); px(120, 84, 40, 116, SHIRT); px(120, 190, 40, 10, SKIN);
    /* 双腿 */
    px(40, 204, 40, 116, PANTS); px(80, 204, 40, 116, PANTS);
    px(40, 310, 40, 10, SHOE); px(80, 310, 40, 10, SHOE);
    px(40, 204, 40, 8, PANTS2); px(80, 204, 40, 8, PANTS2);
    return;
  }
  const img = new Image();
  img.onload = () => {
    const w = img.width, legacy = w === 64 && img.height === 32;
    const draw = (sx, sy, sw, sh, dx, dy, dw, dh) => ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    draw(8, 8, 8, 8, 40, 0, 80, 80);           /* 头 */
    if (!legacy) draw(40, 8, 8, 8, 40, 0, 80, 80); /* 帽子层（64x32 无独立帽子层时跳过） */
    draw(20, 20, 8, 12, 40, 80, 80, 120);      /* 身体 */
    draw(44, 20, 4, 12, 0, 80, 40, 120);       /* 右臂 */
    if (!legacy) draw(36, 52, 4, 12, 120, 80, 40, 120); /* 左臂 */
    else draw(44, 20, 4, 12, 120, 80, 40, 120);
    draw(4, 16, 4, 12, 40, 200, 40, 120);      /* 右腿 */
    if (!legacy) draw(20, 52, 4, 12, 80, 200, 40, 120); /* 左腿 */
    else draw(4, 16, 4, 12, 80, 200, 40, 120);
  };
  img.src = dataUrl;
}
function renderAccounts(accounts, active) {
  const box = $('#accList');
  const list = accounts || [];
  S.accounts = list;   /* 主页头像按名字取皮肤用（改玩家名时实时联动） */
  $('#accCurTag').textContent = list.length ? '（当前：' + active + '）' : '';
  if (!list.length) {
    box.innerHTML = '<div class="empty-sm">还没有账户。先在上方输入玩家名点「添加」，或用微软正版 / 外置登录创建；<br>创建后可以上传自定义皮肤，进游戏即生效。</div>';
    renderSkinPreview(null);
    heroHeadFor(active);
    return;
  }
  box.innerHTML = '';
  list.forEach(a => {
    const isCur = a.name === active;
    const typeTag = a.type === 'ms'
      ? '<span class="pill release">微软正版</span>'
      : a.type === 'authlib'
        ? '<span class="pill snapshot">外置 · ' + esc(String(a.serverUrl || '').replace(/^https?:\/\//, '').split('/')[0]) + '</span>'
        : '<span class="pill loader">离线</span>';
    /* 微软账户：把「有没有买」直接标在卡片上（owned / gamepass / unknown 三种） */
    const ownTag = a.type === 'ms'
      ? (a.ownership === 'owned' ? '<span class="pill release">已购买</span>'
        : a.ownership === 'gamepass' ? '<span class="pill warn">未查到购买记录</span>'
          : '<span class="pill loader">购买状态未确认</span>')
      : '';
    const row = el('div', 'ver-row mod-row');
    row.innerHTML =
      '<div class="mod-ic-wrap">' + (a.skinUrl
        ? '<img class="mod-ic" style="image-rendering:pixelated" src="' + a.skinUrl + '" alt="">'
        : '<div class="mod-ic ph"><svg class="ic"><use href="#i-user"/></svg></div>') + '</div>' +
      '<div class="mod-main">' +
        '<div class="mod-title"><b>' + esc(a.name) + '</b>' + typeTag + ownTag + (isCur ? '<span class="pill release">当前</span>' : '') +
          (a.type === 'offline' && a.skin ? '<span class="pill ' + (a.model === 'slim' ? 'snapshot' : 'release') + '">' + (a.model === 'slim' ? '苗条 (Alex)' : '经典 (Steve)') + '</span>' : '') + '</div>' +
        '<div class="mod-file">' + (a.type === 'ms'
          ? '微软正版 · ' + (a.ownership === 'owned' ? '名下已确认 Minecraft 许可'
            : a.ownership === 'gamepass' ? '靠 Game Pass 等权益可用（名下未查到购买记录）'
              : '购买状态未确认（可能是网络未通）') +
            (a.gamertag ? ' · Xbox 玩家代号 ' + esc(String(a.gamertag)) : '') + ' · 令牌自动续期'
          : a.type === 'authlib' ? '外置登录 · 皮肤/披风由认证服务器提供 · 启动时正版方式验证'
          : (a.skin ? '自定义皮肤已设置（启动游戏自动生效）' : '默认皮肤（史蒂夫）')) + '</div>' +
      '</div>' +
      '<div class="v-act"></div>';
    const act = row.querySelector('.v-act');
    if (!isCur) act.appendChild(accBtn('设为当前', async () => {
      applyAccounts(await window.lmc.accountSwitch({ name: a.name }), '已切换到 ' + a.name);
    }));
    if (a.type === 'offline') {
      act.appendChild(accBtn(a.skin ? '更换皮肤' : '上传皮肤', async () => {
        const r = await window.lmc.accountSkin({ name: a.name, model: a.model || 'classic' });
        applyAccounts(r, r && r.ok ? '皮肤已更新（启动游戏后生效）' : '');
      }));
      act.appendChild(accBtn('模型：' + (a.model === 'slim' ? '苗条' : '经典'), async () => {
        applyAccounts(await window.lmc.accountModel({ name: a.name, model: a.model === 'slim' ? 'classic' : 'slim' }), '模型已切换');
      }));
      if (a.skin) act.appendChild(accBtn('移除皮肤', async () => {
        applyAccounts(await window.lmc.accountSkinRemove({ name: a.name }), '已恢复默认皮肤');
      }));
    }
    act.appendChild(accBtn('删除', async () => {
      if (!(await askConfirm('确定删除账户「' + a.name + '」？', { danger: true, detail: a.type === 'offline' ? '其皮肤文件也会一并删除。' : '将退出该在线账户。' }))) return;
      applyAccounts(await window.lmc.accountDelete({ name: a.name }), '账户已删除');
    }));
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      renderSkinPreview(a.skinUrl);
    });
    box.appendChild(row);
  });
  const cur = list.find(x => x.name === active);
  renderSkinPreview(cur ? cur.skinUrl : null);
  heroHeadFor(active);
}
async function loadAccounts() {
  const r = await window.lmc.accountList();
  if (r.ok) {
    renderAccounts(r.accounts, r.active); syncAccountUI(r.active);
    /* 无账户引导已改为「启动时弹窗」（见 showNoAccountGuide / bootGuideChain），
       这里不再用右下角 toast —— 那种提示太不起眼，用户容易错过。
       进入本页时若无账户，上方空状态文案本身已经说明了怎么创建。 */
  }
  if (S.config && S.config.msClientId) $('#msClientId').value = S.config.msClientId;
  /* 只有「既没内置、也没自填」应用 ID 时才提示（正常情况永远不提示）—— 每次会话查一次即可 */
  if (!S.msAppInfoChecked) { S.msAppInfoChecked = true; refreshMsAppInfo(); }
}
$('#btnAccAdd').addEventListener('click', async () => {
  const name = $('#accName').value.trim();
  if (!name) { toast('请输入玩家名', 'warn'); return; }
  const r = await window.lmc.accountAdd({ name });
  if (r.ok) { $('#accName').value = ''; toast('账户已添加'); syncAccountUI(r.active); }
  else toast(r.error || '添加失败', 'error');
  renderAccounts(r.accounts, r.active);
});
$('#accName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnAccAdd').click(); });

/* ---------------- 添加账户：离线 / 微软正版 / 第三方外置 ---------------- */
$$('.acc-type').forEach(b => b.addEventListener('click', () => {
  $$('.acc-type').forEach(x => x.classList.toggle('active', x === b));
  $('#accFormOffline').style.display = b.dataset.atype === 'offline' ? '' : 'none';
  $('#accFormMs').style.display = b.dataset.atype === 'ms' ? '' : 'none';
  $('#accFormAuthlib').style.display = b.dataset.atype === 'authlib' ? '' : 'none';
}));
$('#authlibPreset').addEventListener('change', () => {
  $('#authlibCustomRow').style.display = $('#authlibPreset').value === 'custom' ? '' : 'none';
});

/* ---------------- 微软正版登录（默认：启动器内置窗口，零配置） ---------------- */
/* 登录进度：主进程按 4 步推送（打开登录页 → 账户信息 → 购买检查 → 角色档案），界面逐条打勾。
   和 PCL2 一样把过程摊开给用户看，而不是干等一个转圈。 */
const MS_STEPS = ['打开微软官方登录页', '获取 Xbox 账户信息', '检查是否已购买 Minecraft', '获取角色档案'];
function renderMsSteps(cur, note) {
  const box = $('#msSteps');
  if (!box) return;
  if (!cur) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = MS_STEPS.map((t, i) => {
    const n = i + 1;
    const state = n < cur ? 'ok' : (n === cur ? 'run' : 'idle');
    return '<div class="ms-step ' + state + '"><span class="mk">' +
      (state === 'ok' ? '✓' : (state === 'run' ? '●' : '○')) + '</span><span>' + t +
      (n === cur && note ? ' <i>' + esc(note) + '</i>' : '') + '</span></div>';
  }).join('');
}
window.lmc.on('account:ms-progress', (d) => {
  if (!d) return;
  renderMsSteps(d.step | 0, d.text);
  if (d.step > 0 && d.text) $('#msStatus').textContent = d.text;
});
/* 购买状态 → 人话 */
function msOwnershipText(ownership) {
  return ownership === 'owned' ? '已购买 Minecraft 正版'
    : ownership === 'gamepass' ? '可用（未查到购买记录，通常是 Xbox Game Pass）'
      : '可用（本次未确认到购买状态）';
}
/* 只有「自建应用」相关的备用流程才需要应用 ID；默认流程永远零配置 */
async function refreshMsAppInfo() {
  let info = null;
  try { info = await window.lmc.accountMsAppInfo(); } catch (_) {}
  S.msAppInfo = info || {};
  const box = $('#msNeedId');
  if (box) box.style.display = (!info || !info.aadReady) ? '' : 'none';
  return info;
}
let msLoginBusy = false, msBtnIdleHtml = '';
/* 默认流程：点按钮 → 在启动器自己的窗口里打开**微软官方**登录页 → 自动截获授权码 →
 * 主进程走 XBL/XSTS → **检查是否已购买** → 角色档案 → 自动添加账户。
 * 不用注册任何应用、不跳系统浏览器、不用抄代码；登录中再点一次 = 取消。 */
$('#btnMsLogin').addEventListener('click', async () => {
  const btn = $('#btnMsLogin'), st = $('#msStatus');
  if (!msBtnIdleHtml) msBtnIdleHtml = btn.innerHTML;
  if (msLoginBusy) {
    st.textContent = '正在取消…';
    await window.lmc.accountMsWebCancel().catch(() => {});
    return;
  }
  msLoginBusy = true;
  btn.textContent = '取消登录';
  renderMsSteps(1, '');
  st.textContent = '正在打开登录窗口…';
  let r;
  try { r = await window.lmc.accountMsWebLogin({}); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  msLoginBusy = false;
  btn.innerHTML = msBtnIdleHtml;
  renderMsSteps(0, '');
  if (r && r.ok) { applyAccounts(r, '已登录 ' + r.name + ' · ' + msOwnershipText(r.ownership)); return; }
  if (r && r.canceled) { st.textContent = ''; toast('已取消登录'); return; }
  /* 失败原因（例如「没有 Minecraft 正版」）留在状态行上，比一闪而过的 toast 更容易看清 */
  st.textContent = (r && r.error) || '登录失败';
  toast((r && r.error) || '登录失败', 'error');
});

/* 备用流程之一：自建 Azure 应用 + 系统浏览器回调 */
let msAadBusy = false;
$('#btnMsBrowser').addEventListener('click', async () => {
  const btn = $('#btnMsBrowser'), st = $('#msStatus');
  const cid = $('#msClientId').value.trim();
  const idle = btn.innerHTML;
  if (msAadBusy) { await window.lmc.accountMsLoginCancel().catch(() => {}); return; }
  if (!cid) {
    const d = $('#msClientId').closest('details'); if (d) d.open = true;
    toast('请先填入你自己的 Azure 应用 ID', 'warn');
    return;
  }
  msAadBusy = true;
  btn.textContent = '取消';
  let start;
  try { start = await window.lmc.accountMsLoginStart({ clientId: cid }); }
  catch (e) { start = { ok: false, error: (e && e.message) || String(e) }; }
  if (!start.ok) {
    msAadBusy = false; btn.innerHTML = idle;
    st.textContent = ''; toast(start.error || '无法开始登录', 'error');
    return;
  }
  st.textContent = '已在系统浏览器打开微软登录页，请登录并同意授权…';
  const r = await window.lmc.accountMsLoginWait({ clientId: cid });
  msAadBusy = false; btn.innerHTML = idle; st.textContent = '';
  if (r.ok) { applyAccounts(r, '已登录 ' + r.active); return; }
  toast(r.error || '登录失败', 'error');
});

/* 备用：设备码流程（浏览器打不开 / 想把代码给别人代登录时用） */
let msPolling = null;
$('#btnMsDevice').addEventListener('click', async () => {
  const btn = $('#btnMsDevice');
  btn.disabled = true;
  const r = await window.lmc.accountMsStart({ clientId: $('#msClientId').value.trim() });
  btn.disabled = false;
  if (!r.ok) {
    if (r.needId) { const d = $('#msClientId').closest('details'); if (d) d.open = true; toast('请先填入应用 ID', 'warn'); }
    else toast(r.error || '获取设备码失败', 'error');
    return;
  }
  $('#msUserCode').textContent = r.userCode;
  $('#msVerifyUrl').textContent = r.verifyUrl;
  $('#msDevStatus').textContent = '等待授权中…（代码 15 分钟内有效）';
  $('#msAuthBox').style.display = '';
  window.lmc.openUrl(r.verifyUrl);
  if (msPolling) clearInterval(msPolling);
  const interval = Math.max(3, r.interval) * 1000;
  msPolling = setInterval(async () => {
    const p = await window.lmc.accountMsPoll({ clientId: $('#msClientId').value.trim(), deviceCode: r.deviceCode });
    if (p.pending) { $('#msDevStatus').textContent = p.slow ? '微软服务繁忙，已自动放慢轮询…' : '等待授权中…'; return; }
    clearInterval(msPolling); msPolling = null;
    if (p.ok) {
      $('#msAuthBox').style.display = 'none';
      applyAccounts(p, '微软账户 ' + p.active + ' 登录成功');
    } else {
      $('#msDevStatus').textContent = '登录失败：' + (p.error || '未知错误');
      toast(p.error || '登录失败', 'error');
    }
  }, interval);
});
$('#btnMsCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#msUserCode').textContent.trim()); toast('代码已复制'); }
  catch (_) { toast('复制失败，请手动记下代码', 'warn'); }
});
$('#btnMsOpen').addEventListener('click', () => window.lmc.openUrl($('#msVerifyUrl').textContent.trim() || 'https://www.microsoft.com/link'));

/* 第三方外置登录（authlib-injector 协议） */
$('#btnAuthlibLogin').addEventListener('click', async () => {
  const btn = $('#btnAuthlibLogin');
  const server = $('#authlibPreset').value === 'custom' ? $('#authlibServer').value.trim() : $('#authlibPreset').value;
  btn.disabled = true; btn.textContent = '登录中…';
  const r = await window.lmc.accountAuthlibLogin({
    serverUrl: server,
    username: $('#authlibUser').value.trim(),
    password: $('#authlibPass').value
  });
  btn.disabled = false; btn.textContent = '登录';
  if (r.ok) {
    $('#authlibUser').value = ''; $('#authlibPass').value = '';
    applyAccounts(r, '外置账户 ' + r.active + ' 登录成功');
  } else toast(r.error || '登录失败', 'error');
});
$('#authlibPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnAuthlibLogin').click(); });

/* ---------------- 个性化 ---------------- */
const ACCENT_PRESETS = ['#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#ef4444', '#06b6d4', '#64748b'];
const BG_PRESETS = ['#0b0d11', '#ffffff', '#101820', '#0e1226', '#160f1c', '#171208', '#0a1210'];
let personalBgData = '';  // 自定义背景图的 dataURL（启动时从主进程读一次）

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function shade(hex, f) { const c = hexToRgb(hex).map(v => f >= 0 ? Math.round(v + (255 - v) * f) : Math.round(v * (1 + f))); return '#' + c.map(v => v.toString(16).padStart(2, '0')).join(''); }
function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'; }
function isLightColor(hex) { const [r, g, b] = hexToRgb(hex); return (0.299 * r + 0.587 * g + 0.114 * b) > 160; }

/* 应用个性化外观：主题色 / 背景色 / 背景图（实时生效，不落盘） */
function applyPersonalize() {
  const cfg = S.config, root = document.documentElement, body = document.body;
  /* 浅色底（白底等）时 accent 高亮文字/图标要加深而不是提亮，否则白底上看不清 */
  const lightBg = !!(cfg.bgColor && /^#[0-9a-fA-F]{6}$/.test(cfg.bgColor) && isLightColor(cfg.bgColor));
  if (cfg.accentColor && /^#[0-9a-fA-F]{6}$/.test(cfg.accentColor)) {
    const a = cfg.accentColor;
    root.style.setProperty('--acc', a);
    root.style.setProperty('--acc2', lightBg ? shade(a, -0.18) : shade(a, 0.28));
    root.style.setProperty('--acc-dark', shade(a, -0.28));
    root.style.setProperty('--grad', lightBg
      ? 'linear-gradient(135deg,' + shade(a, 0.05) + ',' + shade(a, -0.32) + ')'
      : 'linear-gradient(135deg,' + shade(a, 0.28) + ',' + shade(a, -0.28) + ')');
    root.style.setProperty('--acc-soft1', rgba(a, 0.18));
    root.style.setProperty('--acc-soft2', rgba(shade(a, -0.35), 0.12));
    root.style.setProperty('--acc-border', rgba(a, 0.25));
  } else if (lightBg) {
    /* 默认主题色 + 浅色底：清除 inline，让 CSS 的 light-bg 加深版生效 */
    ['--acc', '--acc2', '--acc-dark', '--grad', '--acc-soft1', '--acc-soft2', '--acc-border'].forEach(v => root.style.removeProperty(v));
  } else {
    ['--acc', '--acc2', '--acc-dark', '--grad', '--acc-soft1', '--acc-soft2', '--acc-border'].forEach(v => root.style.removeProperty(v));
  }
  if (cfg.bgColor && /^#[0-9a-fA-F]{6}$/.test(cfg.bgColor)) {
    root.style.setProperty('--bg0', cfg.bgColor);
    root.style.setProperty('--bg1', shade(cfg.bgColor, 0.14));
    /* 浅色背景 → 自动切浅色文字/卡片，避免白底白字 */
    document.body.classList.toggle('light-bg', isLightColor(cfg.bgColor));
  } else {
    root.style.removeProperty('--bg0');
    root.style.removeProperty('--bg1');
    document.body.classList.remove('light-bg');
  }
  body.classList.remove('has-bg');
  body.style.backgroundImage = '';
  if (cfg.bgMode === 'panorama') {
    body.classList.add('has-bg');
    body.style.backgroundImage = 'url(../assets/panorama.png)';
  } else if (cfg.bgMode === 'image' && personalBgData) {
    body.classList.add('has-bg');
    body.style.backgroundImage = 'url(' + personalBgData + ')';
  }
  /* 同步个性化页控件状态 */
  $$('#page-personal input[name=bgMode]').forEach(r => { r.checked = r.value === (cfg.bgMode || 'default'); });
  $('#pAccent').value = cfg.accentColor || '#10b981';
  $('#pBgColor').value = cfg.bgColor || '#0b0d11';
  $$('#accentSwatches .swatch').forEach(s => s.classList.toggle('on', s.dataset.c === (cfg.accentColor || '')));
  $$('#bgSwatches .swatch').forEach(s => s.classList.toggle('on', s.dataset.c === (cfg.bgColor || '')));
  if (cfg.bgImage) $('#bgImgHint').textContent = '当前：' + cfg.bgImage + '（重新选择可更换）';
}

function setupPersonalize() {
  const swatches = (box, list) => {
    box.innerHTML = list.map(c => '<button class="swatch" data-c="' + c + '" style="background:' + c + '" title="' + c + '"></button>').join('') +
      '<button class="swatch" data-c="" style="background:conic-gradient(#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f87171)" title="自定义颜色…（点击打开取色器）"></button>';
  };
  swatches($('#accentSwatches'), ACCENT_PRESETS);
  swatches($('#bgSwatches'), BG_PRESETS);

  /* 预设色块：点击即预览；彩色渐变块 = 打开系统取色器 */
  $('#accentSwatches').addEventListener('click', e => {
    const b = e.target.closest('.swatch'); if (!b) return;
    if (b.dataset.c === '') { $('#pAccent').click(); return; }
    S.config.accentColor = b.dataset.c;
    applyPersonalize();
  });
  $('#bgSwatches').addEventListener('click', e => {
    const b = e.target.closest('.swatch'); if (!b) return;
    if (b.dataset.c === '') { $('#pBgColor').click(); return; }
    S.config.bgColor = b.dataset.c;
    applyPersonalize();
  });
  /* 取色器：实时预览 */
  $('#pAccent').addEventListener('input', () => { S.config.accentColor = $('#pAccent').value; applyPersonalize(); });
  $('#pBgColor').addEventListener('input', () => { S.config.bgColor = $('#pBgColor').value; applyPersonalize(); });
  $('#btnAccentReset').addEventListener('click', () => { S.config.accentColor = ''; applyPersonalize(); });
  $('#btnBgReset').addEventListener('click', () => { S.config.bgColor = ''; applyPersonalize(); });

  /* 背景模式：切换即预览（MC 全景 = 用户主动选择即视为同意启用） */
  $$('#page-personal input[name=bgMode]').forEach(r => r.addEventListener('change', () => {
    S.config.bgMode = r.value;
    applyPersonalize();
  }));
  /* 选自定义图片：主进程复制进数据目录并落盘 */
  $('#btnPickBg').addEventListener('click', async () => {
    const r = await window.lmc.pickBg();
    if (!r || r.canceled) return;
    if (!r.ok) { toast(r.error || '选择失败'); return; }
    S.config.bgImage = r.file;
    S.config.bgMode = 'image';
    const bg = await window.lmc.getBg();
    personalBgData = bg && bg.ok ? bg.dataUrl : '';
    applyPersonalize();
    toast('背景图已选择，点「保存个性化设置」生效持久化');
  });

  $('#btnSavePersonal').addEventListener('click', async () => {
    S.config = await window.lmc.saveConfig({
      bgMode: S.config.bgMode || 'default',
      bgColor: S.config.bgColor || '',
      accentColor: S.config.accentColor || '',
      bgImage: S.config.bgImage || ''
    });
    applyPersonalize();
    toast('个性化设置已保存');
  });
}

/* ---------------- 联机（陶瓦 Terracotta）---------------- */
const MP = { polling: null, lastState: '', lastIndex: -1 };
function mpRoomCodeValid(c) {
  const m = String(c).toUpperCase().replace(/\s/g, '').match(/U\/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  return m ? m[0] : null;
}
function mpSetStatus(line, hint) {
  $('#mpStatusCard').style.display = '';
  $('#mpStatusLine').textContent = line;
  $('#mpHint').textContent = hint || '';
}
async function mpEnsureRunning() {
  const st = await window.lmc.mpStatus();
  if (!st.ok) throw new Error(st.error || '状态获取失败');
  if (!st.installed) throw new Error('请先下载联机组件');
  if (!st.running) {
    const r = await window.lmc.mpStart();
    if (!r.ok) throw new Error(r.error);
  }
  return true;
}
function mpRenderState(s) {
  if (s.state === MP.lastState && s.index === MP.lastIndex) return;
  MP.lastState = s.state; MP.lastIndex = s.index;
  $('#mpBtnLeave').style.display = s.state === 'waiting' ? 'none' : '';
  $('#mpCodeRow').style.display = 'none';
  $('#mpUrlRow').style.display = 'none';
  switch (s.state) {
    case 'waiting':
      mpSetStatus('待机中', '创建房间，或输入房间码加入朋友的房间。');
      break;
    case 'host-scanning':
      mpSetStatus('正在扫描你的局域网世界…', '启动游戏进入单人世界 → 按 Esc → 点「对局域网开放」，陶瓦检测到后会自动接管。');
      break;
    case 'host-starting':
      mpSetStatus('房间建立中…', '正在与联机网络建立连接，请稍候。');
      $('#mpCodeBig').textContent = s.room; $('#mpCodeRow').style.display = '';
      break;
    case 'host-ok':
      mpSetStatus('房间已就绪 ✓', '把房间码发给朋友即可。你继续在游戏里玩，朋友加入后会直接出现在你的世界中。');
      $('#mpCodeBig').textContent = s.room; $('#mpCodeRow').style.display = '';
      break;
    case 'guest-connecting':
      mpSetStatus('正在加入房间 …', '与房主建立 P2P 连接中，若网络受限可能需要较长时间。');
      break;
    case 'guest-starting': {
      const d = { EASIEST: '极佳', SIMPLE: '良好', MEDIUM: '一般', TOUGH: '较差', UNKNOWN: '检测中' }[s.difficulty] || s.difficulty;
      mpSetStatus('连接建立中…', 'P2P 网络质量：' + d + '。正在准备联机隧道。');
      break;
    }
    case 'guest-ok':
      mpSetStatus('已加入房间 ✓', '打开游戏 → 多人游戏，服务器列表会出现「陶瓦联机大厅」，双击进入；也可在「直接连接」里输入下方地址。');
      $('#mpUrlBig').textContent = s.url; $('#mpUrlRow').style.display = '';
      break;
    case 'exception':
      mpSetStatus('联机出现异常（错误码 ' + s.type + '）', '点「中断联机」后重试；若反复失败，可能是双方网络均无法 P2P 打洞。');
      break;
  }
}
async function mpPoll() {
  try {
    const r = await window.lmc.mpState();
    if (r.ok) mpRenderState(r.state);
  } catch (_) {}
}
function mpStartPolling() {
  if (MP.polling) return;
  MP.polling = setInterval(mpPoll, 1000);
  mpPoll();
}
function mpStopPolling() {
  if (MP.polling) { clearInterval(MP.polling); MP.polling = null; }
  MP.lastState = ''; MP.lastIndex = -1;
}
async function mpOnEnter() {
  const st = await window.lmc.mpStatus().catch(() => null);
  if (!st || !st.ok || !st.installed) {
    $('#mpSetup').style.display = ''; $('#mpMain').style.display = 'none';
    return;
  }
  $('#mpSetup').style.display = 'none'; $('#mpMain').style.display = '';
  try { await mpEnsureRunning(); } catch (e) { mpSetStatus('联机服务未运行', e.message); }
  mpStartPolling();
}
$('#mpBtnDownload').addEventListener('click', async () => {
  const btn = $('#mpBtnDownload'); const info = $('#mpDlInfo');
  btn.disabled = true; info.style.display = ''; info.textContent = '正在获取下载地址…';
  const off = window.lmc.on('mp:progress', p => {
    info.textContent = p.stage === 'extract' ? '下载完成，解压安装中…' : '下载中 ' + p.percent + '%';
  });
  const r = await window.lmc.mpDownload();
  btn.disabled = false;
  if (r.ok) {
    info.textContent = r.already ? '已安装最新版本' : '安装完成';
    toast(r.already ? '联机组件已是最新（v' + r.version + '），无需重复下载' : '联机组件安装完成: v' + r.version);
    mpOnEnter();
  }
  else { info.textContent = '下载失败: ' + r.error; toast('下载失败: ' + r.error, 'error'); }
});
$('#mpBtnHost').addEventListener('click', async () => {
  try {
    await mpEnsureRunning();
    const r = await window.lmc.mpAct({ action: 'scanning', player: $('#inpName').value.trim() || S.config.username || 'Steve' });
    if (!r.ok) throw new Error('创建房间失败 (HTTP ' + r.status + ')');
    mpStartPolling(); mpPoll();
  } catch (e) { toast(e.message, 'error'); }
});
$('#mpBtnJoin').addEventListener('click', async () => {
  const code = mpRoomCodeValid($('#mpInputCode').value);
  if (!code) { toast('房间码格式不对，应为 U/XXXX-XXXX-XXXX-XXXX', 'error'); return; }
  try {
    await mpEnsureRunning();
    const r = await window.lmc.mpAct({ action: 'guesting', room: code, player: $('#inpName').value.trim() || S.config.username || 'Steve' });
    if (!r.ok) throw new Error('加入失败 (HTTP ' + r.status + ')，请检查房间码是否正确');
    mpStartPolling(); mpPoll();
  } catch (e) { toast(e.message, 'error'); }
});
$('#mpBtnLeave').addEventListener('click', async () => {
  await window.lmc.mpAct({ action: 'ide' }).catch(() => {});
  mpPoll();
});
$('#mpBtnCopy').addEventListener('click', () => { navigator.clipboard.writeText($('#mpCodeBig').textContent); toast('房间码已复制'); });
$('#mpBtnCopyUrl').addEventListener('click', () => { navigator.clipboard.writeText($('#mpUrlBig').textContent); toast('地址已复制'); });

/* ---------------- 好友页（专属好友码 + 在线状态） ---------------- */
let frTimer = null;
function frFmtSeen(ms) {
  if (!ms) return '从未上线';
  const d = Date.now() - ms;
  if (d < 120000) return '刚刚在线';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前在线';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前在线';
  return '超过 1 天未上线';
}
async function loadFriends() {
  const r = await window.lmc.friendsGet();
  if (!r || !r.ok) { $('#frMyCode').textContent = '—'; return; }
  $('#frMyCode').textContent = r.code;
  const pr = await window.lmc.friendsPresence().catch(() => null);
  const pres = pr && pr.ok ? pr : { connected: false, status: {} };
  $('#frPresenceHint').textContent = pres.connected
    ? '● 在线状态实时检测中（心跳每 30 秒刷新 · 断网或退出启动器即显示离线）'
    : '● 正在连接在线状态服务…（连接不上时好友显示为离线）';
  const box = $('#frList');
  box.innerHTML = '';
  if (!r.friends.length) {
    box.innerHTML = '<div class="empty-sm">还没有好友，把上方的好友码发给朋友吧</div>';
    return;
  }
  r.friends.forEach(f => {
    const st = pres.status[f.code] || {};
    const online = !!st.online;
    const dotCol = online ? '#34d399' : '#8a929c';
    const stTxt = online ? '在线' : esc(frFmtSeen(st.lastSeen || 0));
    box.appendChild(el('div', 'mini-item',
      '<div class="dot-ic"><svg class="ic sm"><use href="#i-user"/></svg></div>' +
      '<div class="mi-main"><b>' + esc(f.name) + '</b>' +
      '<span style="display:inline-flex;align-items:center;gap:6px">' +
      '<span title="' + (online ? '在线' : '离线') + '" style="width:8px;height:8px;border-radius:50%;display:inline-block;background:' + dotCol + ';box-shadow:0 0 6px ' + dotCol + '"></span>' +
      '<span style="color:' + (online ? '#34d399' : '') + ';font-weight:' + (online ? '700' : '400') + '">' + stTxt + '</span>' +
      '<span style="color:var(--mut,#8a929c)">· 好友码: ' + esc(f.code) + '</span></span></div>' +
      '<div class="mi-act" style="display:flex;gap:8px">' +
      (online ? '<button class="btn primary fr-invite"><svg class="ic sm"><use href="#i-user-check"/></svg> 邀请联机</button>' : '') +
      '<button class="btn ghost fr-play"><svg class="ic sm"><use href="#i-play"/></svg> 联机</button>' +
      '<button class="btn ghost fr-del"><svg class="ic sm"><use href="#i-trash"/></svg> 删除</button></div>'));
    const pending = S.frPending && S.frPending.get(f.code);
    if (pending && pending.btn) { /* 恢复"等待回应"状态（页面刷新后） */
      const ib = box.lastChild.querySelector('.fr-invite');
      if (ib) { ib.disabled = true; ib.textContent = '等待回应…'; pending.btn = ib; }
    }
    const invBtn = box.lastChild.querySelector('.fr-invite');
    if (invBtn) invBtn.addEventListener('click', () => frInvite(f, invBtn));
    box.lastChild.querySelector('.fr-play').addEventListener('click', () => frQuickPlay(f));
    box.lastChild.querySelector('.fr-del').addEventListener('click', async () => {
      if (!(await askConfirm('删除好友「' + f.name + '」？', { danger: true }))) return;
      await window.lmc.friendsRemove({ code: f.code });
      toast('已删除好友: ' + f.name);
      loadFriends();
    });
  });
}
function frStartPolling() { if (!frTimer) frTimer = setInterval(loadFriends, 15000); }
function frStopPolling() { if (frTimer) { clearInterval(frTimer); frTimer = null; } }

/* ---------------- 好友联机（MQTT 信令：邀请 / 同意 / 拒绝 / 房间码） ---------------- */
S.frPending = new Map(); /* 我发出的邀请: code -> {inviteId, btn, timer} */
S.frInvites = [];        /* 收到的邀请队列（弹窗一次只显示一个） */
function frMyName() { return ($('#inpName').value.trim()) || (S.config && S.config.username) || 'Steve'; }

async function frInvite(f, btn) {
  const inviteId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const r = await window.lmc.friendsSignalSend({ to: f.code, payload: { type: 'invite', inviteId } });
  if (!r || !r.ok) { toast('邀请发送失败: ' + ((r && r.error) || '未知错误'), 'error'); return; }
  toast('已向 ' + f.name + ' 发送联机邀请，等待回应…');
  btn.disabled = true; btn.textContent = '等待回应…';
  const timer = setTimeout(() => {
    const p = S.frPending.get(f.code);
    if (p && p.inviteId === inviteId) {
      if (p.btn && p.btn.isConnected) { p.btn.disabled = false; p.btn.innerHTML = '<svg class="ic sm"><use href="#i-user-check"/></svg> 邀请联机'; }
      S.frPending.delete(f.code);
      toast(f.name + ' 没有回应，邀请已超时', 'warn');
    }
  }, 60000);
  S.frPending.set(f.code, { inviteId, btn, timer });
}

/* 好友列表「联机」按钮：先查在线状态，再检测局域网世界，检测成功直接开联机 */
async function frQuickPlay(f) {
  /* 1. 实时在线检查 */
  const pres = await window.lmc.friendsPresence().catch(() => null);
  const st = pres && pres.ok && pres.status ? pres.status[f.code] : null;
  if (!st || !st.online) { toast((f.name || '好友') + ' 不在线，无法进行联机', 'warn'); return; }
  /* 2. 检测局域网世界（创建扫描会话并等待房间码 = 检测成功） */
  toast('正在检测局域网世界…');
  gotoPage('mp');
  mpSetStatus('正在检测局域网世界…', '检测成功后将自动与 ' + (f.name || '好友') + ' 开始联机。请确保游戏已进入世界并对局域网开放。');
  try {
    await mpEnsureRunning();
    const r = await window.lmc.mpAct({ action: 'scanning', player: frMyName() });
    if (!r.ok) throw new Error('检测失败 (HTTP ' + r.status + ')');
    mpStartPolling();
    /* 最多检测 1 分钟：超时自动退出扫描并提示 */
    const deadline = Date.now() + 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 1500));
      const s = await window.lmc.mpState().catch(() => null);
      if (s && s.ok && s.state && s.state.room) {
        /* 检测成功：把房间码发给好友，直接开始联机 */
        await window.lmc.friendsSignalSend({ to: f.code, payload: { type: 'room', room: s.state.room } });
        mpSetStatus('检测成功，已开始与 ' + (f.name || '好友') + ' 联机 ✓', '请在游戏里进入世界 → Esc → 「对局域网开放」，对方加入后即可一起玩。');
        toast('检测成功，' + (f.name || '好友') + ' 正在加入你的联机房间');
        return;
      }
    }
    mpStopPolling();
    await window.lmc.mpStop().catch(() => {});
    mpSetStatus('未检测到局域网世界，已自动退出扫描', '超过 1 分钟没有检测到可联机的世界。请先进游戏世界 → Esc → 「对局域网开放」，再回到好友页点「联机」。');
    toast('超过 1 分钟未检测到局域网世界，已自动退出扫描', 'warn');
  } catch (e) {
    mpSetStatus('好友联机失败', e.message);
    toast('联机失败: ' + e.message, 'error');
  }
}

function showInviteDialog(inv) {
  /* 同一时间只弹一个，其余排队 */
  if (document.getElementById('frInviteMask')) { S.frInvites.push(inv); return; }
  const mask = document.createElement('div');
  mask.id = 'frInviteMask';
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;animation:fadeIn .18s ease';
  mask.innerHTML = '<div style="background:#161b23;border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:30px 36px;max-width:430px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.5);animation:pop .22s cubic-bezier(.2,.9,.3,1.2)">' +
    '<h3 style="margin:0 0 8px;font-size:19px">🎮 ' + esc(inv.name || '好友') + ' 邀请你一起玩 MC</h3>' +
    '<p style="margin:0 0 20px;color:#8a929c;font-size:13px">接受后将自动加入对方的联机房间</p>' +
    '<div style="display:flex;gap:12px;justify-content:center">' +
    '<button class="btn primary" id="frInvAccept" style="min-width:110px">同意</button>' +
    '<button class="btn ghost" id="frInvReject" style="min-width:110px">拒绝</button></div></div>';
  document.body.appendChild(mask);
  mask.querySelector('#frInvAccept').addEventListener('click', async () => {
    mask.remove();
    await window.lmc.friendsSignalSend({ to: inv.from, payload: { type: 'accept', inviteId: inv.inviteId } });
    gotoPage('mp');
    mpSetStatus('正在加入 ' + (inv.name || '好友') + ' 的联机房间…', '等待对方创建房间，通常几秒内完成。');
    nextInviteDialog();
  });
  mask.querySelector('#frInvReject').addEventListener('click', async () => {
    mask.remove();
    await window.lmc.friendsSignalSend({ to: inv.from, payload: { type: 'reject', inviteId: inv.inviteId } });
    toast('已拒绝 ' + (inv.name || '好友') + ' 的邀请');
    nextInviteDialog();
  });
}
function nextInviteDialog() { if (S.frInvites.length) showInviteDialog(S.frInvites.shift()); }

function frResetPendingBtn(code) {
  const p = S.frPending.get(code);
  if (p) {
    clearTimeout(p.timer);
    if (p.btn && p.btn.isConnected) { p.btn.disabled = false; p.btn.innerHTML = '<svg class="ic sm"><use href="#i-user-check"/></svg> 邀请联机'; }
    S.frPending.delete(code);
  }
}

/* 发起方：对方同意后自动建房，把房间码发给对方 */
async function frHostForFriend(s) {
  try {
    gotoPage('mp');
    mpSetStatus('正在为 ' + (s.name || '好友') + ' 创建联机房间…', '创建后房间码会自动发送给对方。');
    await mpEnsureRunning();
    const r = await window.lmc.mpAct({ action: 'scanning', player: frMyName() });
    if (!r.ok) throw new Error('创建房间失败 (HTTP ' + r.status + ')');
    mpStartPolling();
    for (let i = 0; i < 40; i++) {
      await new Promise(res => setTimeout(res, 1500));
      const st = await window.lmc.mpState().catch(() => null);
      if (st && st.ok && st.state && st.state.room) {
        await window.lmc.friendsSignalSend({ to: s.from, payload: { type: 'room', room: st.state.room } });
        mpSetStatus('房间已创建 ✓', '房间码已自动发送给 ' + (s.name || '好友') + '。请在游戏里进入世界 → Esc → 「对局域网开放」，对方加入后即可一起玩。');
        toast('房间码已发送给 ' + (s.name || '好友'));
        return;
      }
    }
    throw new Error('等待房间码超时');
  } catch (e) {
    mpSetStatus('好友联机创建失败', e.message);
    toast('创建房间失败: ' + e.message, 'error');
  }
}

/* 受邀方：收到房间码后自动加入 */
async function frJoinRoom(s) {
  try {
    gotoPage('mp');
    mpSetStatus('正在加入 ' + (s.name || '好友') + ' 的联机房间…', '房间码: ' + (s.room || ''));
    await mpEnsureRunning();
    const r = await window.lmc.mpAct({ action: 'guesting', room: s.room, player: frMyName() });
    if (!r.ok) throw new Error('加入失败 (HTTP ' + r.status + ')');
    mpStartPolling(); mpPoll();
    toast('已加入 ' + (s.name || '好友') + ' 的房间，进游戏多人模式即可看到');
  } catch (e) {
    mpSetStatus('加入好友房间失败', e.message);
    toast('加入房间失败: ' + e.message, 'error');
  }
}

async function frHandleSignal(s) {
  switch (s.type) {
    case 'invite': showInviteDialog(s); break;
    case 'accept':
      frResetPendingBtn(s.from);
      toast((s.name || '好友') + ' 接受了你的联机邀请！');
      await frHostForFriend(s);
      break;
    case 'reject':
      frResetPendingBtn(s.from);
      toast('对方拒绝了你的邀请', 'warn');
      break;
    case 'room': await frJoinRoom(s); break;
  }
}

function frSignalStart() {
  if (frSignalTimer) return;
  frSignalTimer = setInterval(async () => {
    try {
      const r = await window.lmc.friendsSignalPoll();
      if (r && r.ok && r.signals.length) for (const s of r.signals) frHandleSignal(s);
    } catch (_) {}
  }, 2500);
}
let frSignalTimer = null;
$('#frBtnCopy').addEventListener('click', () => {
  navigator.clipboard.writeText($('#frMyCode').textContent);
  toast('好友码已复制，快发给朋友吧');
});
$('#frInputCode').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('#frBtnAdd').click(); });
$('#frBtnAdd').addEventListener('click', async () => {
  const btn = $('#frBtnAdd');
  btn.disabled = true;
  const r = await window.lmc.friendsAdd({ code: $('#frInputCode').value });
  btn.disabled = false;
  if (!r || !r.ok) { toast((r && r.error) || '添加失败', 'error'); return; }
  $('#frInputCode').value = '';
  toast('已添加好友');
  loadFriends();
});

/* ---------------- 下载 Java（设置页） ---------------- */
$('#btnDlJava').addEventListener('click', async () => {
  const btn = $('#btnDlJava');
  const major = parseInt($('#javaDlVer').value, 10);
  btn.disabled = true; btn.textContent = '下载中…';
  setStatus('下载 Java ' + major + '…', true);
  const r = await window.lmc.javaDownload(major);
  btn.disabled = false; btn.innerHTML = '<svg class="ic sm"><use href="#i-download"/></svg> 下载安装';
  if (!r || !r.ok) { toast('Java ' + major + ' 安装失败: ' + ((r && r.error) || '未知错误'), 'error'); return; }
  detectJavaUI();
});

/* ---------------- 诊断页 ---------------- */
S.lastDiag = null;
function renderDiagResult(dg) {
  const box = $('#diagGameOut');
  if (!dg.found) { box.innerHTML = '<div class="empty-sm">' + esc(dg.note || '最近没有新的崩溃报告。') + '</div>'; return; }
  const pills = [
    dg.reportFresh ? '<span class="pill release">有崩溃报告</span>' : '',
    dg.logFresh ? '<span class="pill old_beta">有游戏日志</span>' : ''
  ].filter(Boolean).join(' ');
  let html = '<div class="diag-verdict">' + pills +
    (dg.rules.length
      ? ' <b>识别出 ' + dg.rules.length + ' 个可能原因：</b>'
      : ' <b>内置规则未识别出确定原因</b>（可用下方 AI 深度分析）') + '</div>';
  dg.rules.forEach((r, i) => {
    html += '<div class="diag-rule"><div class="diag-rule-t">' + (i + 1) + '. ' + esc(r.title) + '</div>' +
      '<div class="diag-rule-b"><b>原因：</b>' + esc(r.why) + '</div>' +
      '<div class="diag-rule-b"><b>建议：</b>' + esc(r.fix) + '</div>' +
      '<div class="diag-rule-m">匹配到: ' + esc(r.match) + '</div></div>';
  });
  if (dg.javaNeed) html += '<div class="warnbar tip">需要 Java ' + dg.javaNeed + '+ —— 设置里检测/自动安装即可。</div>';
  if (dg.modsInvolved.length) html += '<div class="diag-rule-b"><b>涉及的 MOD：</b>' + dg.modsInvolved.map(esc).join('、') + '</div>';
  html += '<div class="diag-src">';
  if (dg.reportPath) html += '<div>崩溃报告: <code>' + esc(dg.reportPath) + '</code></div>';
  if (dg.logPath) html += '<div>游戏日志: <code>' + esc(dg.logPath) + '</code></div>';
  html += '</div>';
  box.innerHTML = html;
}
async function runGameDiag() {
  const box = $('#diagGameOut');
  box.innerHTML = '<div class="empty-sm">正在分析崩溃报告…</div>';
  const instance = $('#diagInstance').value || '';
  const r = await window.lmc.diagGame({ instance });
  if (!r.ok) { box.innerHTML = '<div class="empty-sm">诊断失败: ' + esc(r.error) + '</div>'; return; }
  S.lastDiag = r.diag;
  renderDiagResult(r.diag);
}
async function refreshDiagLauncher() {
  const box = $('#diagLaunchList');
  const r = await window.lmc.diagLauncher();
  if (!r.ok) { box.innerHTML = '<div class="empty-sm">读取失败: ' + esc(r.error) + '</div>'; return; }
  if (!r.crashes.length) { box.innerHTML = '<div class="empty-sm">暂无启动器崩溃记录 —— 一切正常。</div>'; return; }
  box.innerHTML = r.crashes.map(c =>
    '<div class="diag-launch"><div><b>' + esc(new Date(c.time).toLocaleString()) + '</b> <code>' + esc(c.head) + '</code></div>' +
    '<button class="btn ghost diag-open-file" data-f="' + esc(c.path) + '">查看</button></div>').join('');
  box.querySelectorAll('.diag-open-file').forEach(b => b.addEventListener('click', () => window.lmc.openPath(b.dataset.f)));
}
$('#btnDiagGame').addEventListener('click', runGameDiag);
$('#btnDiagOpenDir').addEventListener('click', async () => {
  const r = await window.lmc.diagLauncher();
  if (r.ok && r.diagDir) window.lmc.openPath(r.diagDir);
});
$('#btnAiSave').addEventListener('click', async () => {
  await window.lmc.saveConfig({ aiApi: { base: $('#aiBase').value.trim(), key: $('#aiKey').value.trim(), model: $('#aiModel').value.trim() || 'gpt-4o-mini' } });
  toast('AI 设置已保存');
});
$('#btnDiagAi').addEventListener('click', async () => {
  if (!S.lastDiag || !S.lastDiag.found) { toast('请先运行一次游戏崩溃诊断', 'warn'); return; }
  const out = $('#diagAiOut');
  out.innerHTML = '<div class="empty-sm">AI 分析中（最长 60 秒）…</div>';
  const r = await window.lmc.diagAi({ excerpt: S.lastDiag.excerpt, rules: S.lastDiag.rules });
  out.innerHTML = r.ok
    ? '<div class="diag-ai">' + esc(r.text).replace(/\n/g, '<br>') + '</div>'
    : '<div class="warnbar tip">' + esc(r.error) + '</div>';
});

/* ================================================================
 * 插件（内置插件：种子地图 / 一键开服）
 * ================================================================ */
const PLUGIN_DEFS = [
  {
    id: 'seedmap', name: '种子地图', ver: '1.0.0', tag: '工具', ic: '#i-map', color: '#10b981',
    desc: '输入任意种子，直接在启动器内查看该世界的生物群系、村庄、要塞与结构分布；支持从已有存档一键读取种子。'
  },
  {
    id: 'server', name: '一键开服', ver: '1.0.0', tag: '联机', ic: '#i-server', color: '#f59e0b',
    desc: '选择 Paper / Purpur / 原版 / Fabric 与游戏版本，自动下载服务端、生成 eula 与 server.properties，一键启动并实时查看日志。'
  }
];
const PLG = { on: {}, pane: '' };
function coreName(id) {
  return ({ paper: 'Paper', purpur: 'Purpur', vanilla: '原版', fabric: 'Fabric' })[id] || id;
}
async function renderPlugins(force) {
  const wrap = $('#pluginsList');
  if (!wrap) return;
  if (!force && wrap.dataset.done) return;
  try {
    const r = await window.lmc.pluginList();
    if (r && r.ok) PLG.on = r.plugins || {};
  } catch (_) {}
  wrap.className = 'plg-grid';
  wrap.innerHTML = PLUGIN_DEFS.map(p => {
    const on = PLG.on[p.id] !== false;
    return '<div class="plg-card' + (on ? '' : ' off') + '">' +
      '<span class="plg-ic" style="background:' + p.color + '1f;color:' + p.color + '"><svg class="ic"><use href="' + p.ic + '"/></svg></span>' +
      '<div class="plg-main"><b>' + esc(p.name) +
        '<span class="plg-tag">' + esc(p.tag) + '</span><span class="plg-tag">v' + esc(p.ver) + '</span></b>' +
        '<span>' + esc(p.desc) + '</span></div>' +
      '<div class="plg-acts">' +
        '<span class="plg-sw' + (on ? ' on' : '') + '" data-sw="' + p.id + '" title="' + (on ? '点击停用' : '点击启用') + '"></span>' +
        '<button class="btn ' + (on ? 'primary' : 'ghost') + '" data-open="' + p.id + '"' + (on ? '' : ' disabled') + '>打开</button>' +
      '</div></div>';
  }).join('');
  wrap.dataset.done = '1';
  $$('#pluginsList [data-sw]').forEach(sw => sw.addEventListener('click', async () => {
    const id = sw.dataset.sw;
    const now = !(PLG.on[id] !== false);
    try {
      const r = await window.lmc.pluginToggle({ id, enabled: now });
      if (r && r.plugins) PLG.on = r.plugins;
    } catch (e) { toast('操作失败：' + e.message, 'error'); return; }
    const def = PLUGIN_DEFS.find(x => x.id === id);
    toast('插件「' + (def ? def.name : id) + '」已' + (now ? '启用' : '停用'), now ? 'ok' : 'warn');
    /* 停用的插件若正被打开 → 自动退回列表 */
    if (!now && PLG.pane === id) closePlugin();
    renderPlugins(true);
  }));
  $$('#pluginsList [data-open]').forEach(b => b.addEventListener('click', () => openPlugin(b.dataset.open)));
}
function openPlugin(id) {
  if (PLG.on[id] === false) { toast('插件已停用，请先在列表里启用', 'warn'); return; }
  PLG.pane = id;
  $('#plgHome').style.display = 'none';
  $('#plgSeedmap').style.display = id === 'seedmap' ? '' : 'none';
  $('#plgServer').style.display = id === 'server' ? '' : 'none';
  if (id === 'seedmap') initSeedmap();
  else if (id === 'server') initServerPane();
}
function closePlugin() {
  PLG.pane = '';
  $('#plgHome').style.display = '';
  $('#plgSeedmap').style.display = 'none';
  $('#plgServer').style.display = 'none';
}
$('#btnPlgRefresh').addEventListener('click', () => { renderPlugins(true); toast('插件列表已刷新'); });
$('#btnSeedBack').addEventListener('click', closePlugin);
$('#btnSrvBack').addEventListener('click', closePlugin);

/* ---------------- 插件：种子地图 ---------------- */
const SM = { init: false, saves: [] };
async function initSeedmap() {
  if (!SM.init) {
    SM.init = true;
    try {
      const r = await window.lmc.seedmapPlatforms();
      $('#smPlatform').innerHTML = ((r && r.platforms) || []).map(p =>
        '<option value="' + esc(p.code) + '">' + esc(p.label) + '</option>').join('');
      $('#smPlatform').value = 'java_1_21';
    } catch (_) {}
    loadSmSaves();
  }
  if (!$('#smSeed').value) $('#smSeed').value = String(Math.floor(Math.random() * 9e8) + 1e8);
}
async function loadSmSaves() {
  const sel = $('#smSave');
  try {
    const r = await window.lmc.savesList();
    SM.saves = (r && r.saves) || [];
    sel.innerHTML = '<option value="">选择存档自动填入种子…</option>' + SM.saves.map((s, i) =>
      '<option value="' + i + '">' + esc(s.levelName || s.name) +
      '（' + (s.instance ? esc(s.instance) + ' · 隔离' : '全局') + '）</option>').join('');
  } catch (_) { sel.innerHTML = '<option value="">读取存档失败</option>'; }
}
$('#btnSmRand').addEventListener('click', () => {
  /* 随机种子：一半正数一半负数，负数更接近游戏内「随机种子」的手感 */
  const n = Math.floor(Math.random() * 9e8) + 1;
  $('#smSeed').value = String(Math.random() < 0.5 ? -n : n);
  toast('已生成随机种子');
});
$('#btnSmSaveSeed').addEventListener('click', () => {
  const i = parseInt($('#smSave').value, 10);
  const s = SM.saves[i];
  if (!s) { toast('请先选择一个存档', 'warn'); return; }
  if (s.seed == null || s.seed === '') { toast('该存档没有记录种子（旧版本或 level.dat 缺失）', 'warn'); return; }
  $('#smSeed').value = String(s.seed);
  toast('已填入「' + (s.levelName || s.name) + '」的种子：' + s.seed);
});
$('#btnSmOpen').addEventListener('click', async () => {
  const seed = $('#smSeed').value.trim();
  if (!seed) { toast('请先输入种子', 'warn'); return; }
  const btn = $('#btnSmOpen');
  btn.disabled = true;
  try {
    const r = await window.lmc.seedmapOpen({ seed, platform: $('#smPlatform').value, dimension: $('#smDim').value });
    toast(r && r.external ? '已在系统浏览器打开种子地图' : '种子地图已在新窗口打开');
  } catch (e) { toast('打开失败：' + e.message, 'error'); }
  finally { setTimeout(() => { btn.disabled = false; }, 800); }
});

/* ---------------- 插件：一键开服 ---------------- */
const SRV = { init: false, cores: [], core: 'paper', list: [], sel: '', logs: {}, creating: false, bound: false, lan: [], ready: {} };
async function initServerPane() {
  if (!SRV.init) {
    SRV.init = true;
    try {
      const r = await window.lmc.serverCores();
      SRV.cores = (r && r.cores) || [];
    } catch (_) {}
    if (!SRV.cores.length) {
      SRV.cores = [
        { id: 'paper', name: 'Paper', desc: '高性能服务端，支持 Bukkit/Spigot 插件（推荐）' },
        { id: 'purpur', name: 'Purpur', desc: 'Paper 分支，可玩性设置更多' },
        { id: 'vanilla', name: '原版', desc: 'Mojang 官方服务端，纯净无插件' },
        { id: 'fabric', name: 'Fabric', desc: '轻量模组服务端，支持 Fabric 模组' }
      ];
    }
    renderCoreCards();
    bindServerEvents();
  }
  loadServerVersions(SRV.core);
  loadServerList();
}
function renderCoreCards() {
  const box = $('#srvCores');
  box.innerHTML = SRV.cores.map(c =>
    '<div class="core-card' + (c.id === SRV.core ? ' on' : '') + '" data-core="' + esc(c.id) + '">' +
    '<b>' + esc(c.name) + '</b><span>' + esc(c.desc) + '</span></div>').join('');
  $$('#srvCores .core-card').forEach(c => c.addEventListener('click', () => {
    SRV.core = c.dataset.core;
    renderCoreCards();
    loadServerVersions(SRV.core);
  }));
}
async function loadServerVersions(core) {
  const sel = $('#srvVersion');
  sel.innerHTML = '<option value="">正在获取版本…</option>';
  try {
    const r = await window.lmc.serverVersions({ core });
    if (!r || !r.ok) throw new Error((r && r.error) || '获取版本失败');
    const vs = r.versions || [];
    if (!vs.length) throw new Error('没有获取到可用版本');
    sel.innerHTML = vs.map(v => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
  } catch (e) {
    sel.innerHTML = '<option value="">获取失败：' + esc(e.message) + '</option>';
  }
}
async function loadServerList() {
  try {
    const r = await window.lmc.serverList();
    SRV.list = (r && r.servers) || [];
    SRV.lan = (r && r.lan) || [];
  } catch (_) { SRV.list = []; }
  renderServerList();
  /* 之前选中的服务器仍在 → 同步刷新控制台（回页/刷新时保持上下文） */
  if (SRV.sel && SRV.list.some(x => x.name === SRV.sel)) showServerConsole(SRV.sel);
}
/* 某服务器的连接地址：优先用主进程算好的，缺失时用端口 + 缓存的局域网 IP 兜底 */
function srvAddrInfo(s) {
  const port = (s && parseInt(s.port, 10)) || 25565;
  const a = (s && s.addr) || {};
  const local = a.local || ('127.0.0.1:' + port);
  let lan = [], ifaces = [];
  if (a.lan && a.lan.length) {
    lan = a.lan;
    ifaces = a.lanIfaces || [];
  } else {
    const cached = SRV.lan || [];
    lan = cached.map(x => ((typeof x === 'string' ? x : x.ip) + ':' + port));
    ifaces = cached.map(x => (typeof x === 'string' ? '' : (x.iface || '')));
  }
  return { port, local, lan, ifaces };
}
async function copySrvAddr(text) {
  if (!text) return;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {}
  if (!ok) { try { ok = !!(await window.lmc.copyText(text)); } catch (_) {} }
  toast(ok ? '已复制：' + text : '复制失败，请手动选中地址', ok ? 'ok' : 'warn');
}
/* 「怎么让玩家进来」地址面板：本机 / 局域网两种地址 + 一键复制 */
function renderServerAddr(s) {
  const box = $('#srvAddrBox');
  if (!box) return;
  if (!s) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const { local, lan, ifaces } = srvAddrInfo(s);
  const offline = s.onlineMode === false;
  const running = !!s.running;
  const ready = !!(s.name && SRV.ready[s.name]);
  /* 状态标签跟着进程走：未启动 → 启动中（等到 Done 才真正开始监听端口）→ 已就绪 */
  const badge = !running ? '<span class="srv-addr-idle">启动后才可连入</span>'
    : ready ? '<span class="srv-addr-live">已就绪</span>'
    : '<span class="srv-addr-idle">启动中…（等到日志出现 Done）</span>';
  box.style.display = '';
  box.innerHTML =
    '<div class="srv-addr-head">' +
      '<svg class="ic sm"><use href="#i-globe"/></svg>' +
      '<b>连接地址</b>' +
      '<span class="t-dim">游戏里：多人游戏 → 添加服务器 → 服务器地址粘贴下面这串 → 完成</span>' +
      badge +
    '</div>' +
    '<div class="srv-addr-grid">' +
      '<div class="srv-addr-row"><span class="srv-addr-role">本机（自己进服）</span>' +
        '<code class="srv-addr-val">' + esc(local) + '</code>' +
        '<button class="btn ghost sm" data-addr="' + esc(local) + '">复制</button></div>' +
      (lan.length
        ? '<div class="srv-addr-row"><span class="srv-addr-role">好友（' + esc(ifaces[0] || '同一 WiFi / 局域网') + '）</span>' +
            '<code class="srv-addr-val">' + esc(lan[0]) + '</code>' +
            '<button class="btn ghost sm" data-addr="' + esc(lan[0]) + '">复制</button></div>'
        : '<div class="srv-addr-row"><span class="srv-addr-role">好友（同一 WiFi / 局域网）</span>' +
            '<span class="srv-addr-none">未检测到局域网地址：请先连上路由器 / 热点（或该网卡被禁用）</span></div>') +
    '</div>' +
    '<div class="srv-addr-tips">' +
      (lan.length > 1
        ? '其他网卡地址：' + lan.slice(1).map((ad, i) =>
            ((ifaces[i + 1] ? esc(ifaces[i + 1]) + ' ' : '') + esc(ad))).join('、') + '<br>'
        : '') +
      '发给好友时用「局域网」地址；同一台电脑自己玩用「本机」地址即可。<br>' +
      '首次开服若 Windows 防火墙弹窗，请勾选「专用网络」并点「允许访问」，否则好友连不上。<br>' +
      '不在同一网络（外网联机）需要内网穿透或公网 IP 端口映射，本机地址对外不可用。' +
      (offline ? '<br><span class="srv-addr-warn">该服务器是离线模式（未开启正版验证）：好友需在启动器里关闭正版验证才能进服。</span>' : '') +
    '</div>';
  $$('#srvAddrBox [data-addr]').forEach(b =>
    b.addEventListener('click', () => copySrvAddr(b.dataset.addr)));
}
/* 「刚进服就被断开」识别：Fabric 服务端没装客户端 mod 时，玩家侧看到的是「网络协议错误」，
   服务端日志只有一句 lost connection: Disconnected —— 光看日志完全不知道为什么。
   这里把「进服后 30 秒内掉线」+「服务端 mods 为空」两步对上，直接把该怎么做说出来。 */
const SRV_JOIN_AT = {};
function srvWatchModKick(d) {
  const line = String(d.line || '');
  if (d.self) return;
  let m = /]:\s+([A-Za-z0-9_\-.]+) joined the game/.exec(line);
  if (m) { SRV_JOIN_AT[d.name + '|' + m[1]] = Date.now(); return; }
  m = /]:\s+([A-Za-z0-9_\-.]+) lost connection: Disconnected/.exec(line);
  if (!m) return;
  const key = d.name + '|' + m[1];
  const at = SRV_JOIN_AT[key];
  delete SRV_JOIN_AT[key];
  if (!at || Date.now() - at > 30000) return;   /* 玩了一会儿才退出属正常，不打扰 */
  const s = SRV.list.find(x => x.name === d.name);
  if (!s || String(s.core) !== 'fabric' || s.modsCount) return;
  toast('玩家「' + m[1] + '」刚进服就被断开：这台服务端还没装 mod。点卡片上的「同步 mod」再重启服务端即可（客户端那边会提示「网络协议错误」）', 'warn');
  loadServerList();
}
function renderServerList() {
  const box = $('#srvList');
  if (!SRV.list.length) {
    box.innerHTML = '<div class="empty-sm">还没有服务器<br><span style="font-size:11px">在上面选择核心与版本，点「下载并创建服务器」</span></div>';
    return;
  }
  box.innerHTML = SRV.list.map(s => {
    const { local, lan } = srvAddrInfo(s);
    const isFab = String(s.core) === 'fabric';
    const modTag = isFab
      ? (s.modsCount ? ' <span class="plg-tag" style="color:#22c55e">mod ' + s.modsCount + '</span>'
                     : ' <span class="plg-tag srv-modwarn">未装 mod</span>')
      : '';
    return '<div class="srv-card' + (s.name === SRV.sel ? ' sel' : '') + '" data-srv="' + esc(s.name) + '">' +
    '<span class="srv-state' + (s.running ? ' on' : '') + '"></span>' +
    '<div class="srv-info"><b>' + esc(s.name) + (s.running ? ' <span class="plg-tag" style="color:#22c55e">运行中</span>' : '') + modTag + '</b>' +
    '<span>' + esc(coreName(s.core)) + ' ' + esc(s.ver) + ' · 端口 ' + (s.port || 25565) + ' · 内存 ' +
    ((s.memMB || 2048) / 1024).toFixed(1) + 'G · ' + (s.onlineMode ? '正版验证' : '离线模式') + '</span>' +
    '<span class="srv-addr-line" data-addr="' + esc(local) + '" title="点击复制本机地址">进服地址 ' + esc(local) +
    (lan.length ? ' · 局域网 ' + esc(lan[0]) : '') + '</span>' +
    (isFab && !s.modsCount
      ? '<span class="srv-addr-warn">客户端装了 mod 的话，不点「同步 mod」直接进服会提示「网络协议错误」并被踢出。</span>'
      : '') +
    '<span class="t-dim">' + esc(s.dir) + '</span></div>' +
    '<div class="srv-acts">' +
    '<button class="btn ghost" data-a="start" title="启动服务器"><svg class="ic sm"><use href="#i-play"/></svg></button>' +
    '<button class="btn ghost" data-a="stop" title="停止服务器"><svg class="ic sm"><use href="#i-x"/></svg></button>' +
    (isFab ? '<button class="btn ghost" data-a="sync" title="把客户端实例里「服务端也要装」的 mod 同步到这台服务器"><svg class="ic sm"><use href="#i-sync"/></svg></button>' : '') +
    '<button class="btn ghost" data-a="dir" title="打开目录"><svg class="ic sm"><use href="#i-folder"/></svg></button>' +
    '<button class="btn ghost" data-a="del" title="删除（移入回收站）"><svg class="ic sm"><use href="#i-trash"/></svg></button>' +
    '</div></div>';
  }).join('');
}
/* 同步客户端 mod → 服务端（Fabric 服必做，否则客户端进服会被注册表校验踢掉） */
async function syncServerMods(name) {
  const s = SRV.list.find(x => x.name === name);
  if (s && s.running) {
    toast('服务器正在运行，同步后需要重启才生效', 'warn');
  }
  let r = null;
  try { r = await window.lmc.serverSyncMods({ name }); }
  catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { toast('同步失败：' + ((r && r.error) || '未知错误'), 'error'); return; }
  const add = (r.added || []).length, upd = (r.updated || []).length, sk = (r.clientOnly || []).length;
  if (!add && !upd) {
    toast('服务端 mod 已是最新（已装 ' + (s ? s.modsCount : 0) + ' 个，跳过纯客户端 ' + sk + ' 个）');
    return;
  }
  await loadServerList();
  renderServerList();
  showServerConsole(name);
  toast('已同步 mod：新增 ' + add + '、更新 ' + upd + '，跳过纯客户端 ' + sk +
    '。' + (s && s.running ? '请点「停止」再「启动」让 mod 生效。' : '可以启动服务器了。'), 'ok');
}
/* ---------------- 外网联机：把「陶瓦联机」接进服务器面板 ----------------
 * 独立服务器不像单机世界能「对局域网开放」，所以用法是：
 *   房主创建房间（陶瓦把双方组进同一个 EasyTier 虚拟局域网）→ 朋友凭房间码加入 →
 *   朋友用「房主虚拟网卡 IP:服务器端口」直连。房间建立后虚拟网卡地址会自动出现在
 *   上方「连接地址」面板里（lanIPv4 特意保留了 EasyTier / ZeroTier / Radmin 这类网卡）。*/
const SRVWAN = { open: false, room: '', state: '', code: '', timer: null, busy: false };
const WAN_VIRTUAL_RE = /EasyTier|ZeroTier|Radmin|Tailscale|Hamachi|OpenVPN|WireGuard/i;

function srvWanHide() {
  SRVWAN.open = false; SRVWAN.room = ''; SRVWAN.state = ''; SRVWAN.code = '';
  if (SRVWAN.timer) { clearInterval(SRVWAN.timer); SRVWAN.timer = null; }
  const box = $('#srvWanBox');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
}
function srvWanHead(right) {
  return '<div class="srv-wan-head"><svg class="ic sm"><use href="#i-globe"/></svg><b>外网联机</b>' +
    '<span class="t-dim">陶瓦联机 · 点对点直连，不用公网 IP</span>' + (right || '') + '</div>';
}
function srvWanAddrRows(s) {
  const { lan, ifaces } = srvAddrInfo(s || {});
  if (!lan.length) {
    return '<div class="srv-wan-tips">暂时没检测到可用的局域网地址 —— 房间建立后虚拟网卡地址会出现在这里，稍等几秒会自动刷新。</div>';
  }
  return '<div class="srv-wan-grid">' + lan.map((a, i) => {
    const v = WAN_VIRTUAL_RE.test(ifaces[i] || '');
    return '<div class="srv-wan-row"><span class="srv-addr-role">' +
      esc(v ? '虚拟局域网（外网联机用）' : (ifaces[i] || '局域网')) + '</span>' +
      '<code class="srv-addr-val">' + esc(a) + '</code>' +
      '<button class="btn ghost sm" data-addr="' + esc(a) + '">复制</button></div>';
  }).join('') + '</div>';
}
function srvWanRender(st) {
  const box = $('#srvWanBox');
  if (!box) return;
  if (st) {
    SRVWAN.state = st.state || SRVWAN.state;
    if (st.type !== undefined && st.type !== null) SRVWAN.code = String(st.type);
    if (st.room) SRVWAN.room = st.room;
  }
  const s = SRV.list.find(x => x.name === SRV.sel) || {};
  const bad = /exception/.test(SRVWAN.state);
  const ok = SRVWAN.state === 'host-ok';
  const badge = ok ? '<span class="srv-wan-badge ok">房间已就绪</span>'
    : bad ? '<span class="srv-wan-badge" style="color:#f87171;background:rgba(248,113,113,.14);border-color:rgba(248,113,113,.4)">联机异常</span>'
    : '<span class="srv-wan-badge">建立中…</span>';
  let html = srvWanHead(badge);
  if (ok) {
    html += '<div class="srv-wan-code"><span class="srv-wan-big" id="srvWanCode" title="点击复制">' + esc(SRVWAN.room || '—') + '</span>' +
      '<button class="btn ghost sm" id="btnSrvWanCopyCode">复制房间码</button>' +
      '<button class="btn ghost sm" id="btnSrvWanStop">中断联机</button></div>' +
      '<div class="srv-wan-tips">把<b>房间码</b>发给朋友 → 他在「联机」页加入房间 → 再用下面的地址直连你的服务器：</div>' +
      srvWanAddrRows(s) +
      '<div class="srv-wan-tips">朋友那边看到「已加入房间 ✓」后，游戏里走<b>多人游戏 → 直接连接</b>粘贴上面的地址即可。' +
      (s && s.running ? '' : '<span class="srv-wan-warn">注意：服务器还没启动，请先点上方的「启动」，否则连进来是空的。</span>') +
      (s && s.onlineMode === false ? '<span class="srv-wan-warn">当前是离线模式，公开房间码等于公开入口，建议先执行 whitelist on 开白名单。</span>' : '') +
      '</div>';
  } else if (bad) {
    html += '<div class="srv-wan-tips">联机出现异常（错误码 ' + esc(SRVWAN.code || '未知') + '）。可能是网络无法点对点打洞，或联机组件未登录。' +
      '<span class="srv-wan-warn">可到「联机」页确认组件状态后重试。</span></div>' +
      '<div class="srv-wan-code"><button class="btn ghost sm" id="btnSrvWanRetry">重新创建房间</button>' +
      '<button class="btn ghost sm" id="btnSrvWanStop">关闭</button></div>';
  } else {
    html += '<div class="srv-wan-tips">正在与联机网络建立房间通道…（首次使用会先下载约 8 MB 的联机组件，可能要几十秒）' +
      (s && s.running ? '' : '<span class="srv-wan-warn">服务器尚未启动：朋友加入房间前请先点「启动」。</span>') + '</div>';
  }
  box.style.display = '';
  box.innerHTML = html;
  box.querySelectorAll('[data-addr]').forEach(b => b.addEventListener('click', () => copySrvAddr(b.dataset.addr)));
  const code = $('#srvWanCode');
  if (code) code.addEventListener('click', () => copySrvAddr(SRVWAN.room));
  const cc = $('#btnSrvWanCopyCode');
  if (cc) cc.addEventListener('click', () => copySrvAddr(SRVWAN.room));
  const cs = $('#btnSrvWanStop');
  if (cs) cs.addEventListener('click', srvWanStop);
  const rt = $('#btnSrvWanRetry');
  if (rt) rt.addEventListener('click', srvWanStart);
}
async function srvWanPoll() {
  try {
    const r = await window.lmc.mpState();
    if (!r || !r.ok) return;
    const prev = SRVWAN.state;
    srvWanRender(r.state);
    /* 房间刚就绪：刷新服务器列表，把新出现的虚拟网卡地址（EasyTier）带进地址面板 */
    if (SRVWAN.state === 'host-ok' && prev !== 'host-ok') {
      await loadServerList();
      renderServerList();
      const s = SRV.list.find(x => x.name === SRV.sel);
      if (s) renderServerAddr(s);
      srvWanRender(r.state);
    }
  } catch (_) {}
}
async function srvWanStart() {
  if (SRVWAN.busy) return;
  if (!SRV.sel) { toast('请先选择一个服务器', 'warn'); return; }
  const s0 = SRV.list.find(x => x.name === SRV.sel);
  if (s0 && !s0.running) toast('提示：服务器还没启动，朋友连进来之前记得先点「启动」', 'warn');
  SRVWAN.busy = true;
  const box = $('#srvWanBox');
  if (box) { box.style.display = ''; box.innerHTML = srvWanHead('<span class="srv-wan-badge">准备中…</span>'); }
  try {
    const st = await window.lmc.mpStatus();
    if (!st || !st.ok) throw new Error((st && st.error) || '联机服务状态获取失败');
    if (!st.installed) {
      if (box) box.innerHTML = srvWanHead('<span class="srv-wan-badge">下载组件…</span>') +
        '<div class="srv-wan-tips">首次使用需要下载联机组件（约 8 MB，走国内镜像加速）…</div>';
      const off = window.lmc.on('mp:progress', p => {
        const t = box && box.querySelector('.srv-wan-tips');
        if (t) t.textContent = p.stage === 'extract' ? '下载完成，解压安装中…' : '下载联机组件 ' + p.percent + '%';
      });
      const d = await window.lmc.mpDownload();
      try { if (typeof off === 'function') off(); } catch (_) {}
      if (!d || !d.ok) throw new Error('联机组件下载失败：' + ((d && d.error) || '未知错误'));
    }
    if (!st.running) {
      const r = await window.lmc.mpStart();
      if (!r || !r.ok) throw new Error((r && r.error) || '联机服务启动失败');
    }
    const act = await window.lmc.mpAct({
      action: 'scanning',
      player: (S.config && S.config.username) || 'Steve'
    });
    if (!act || !act.ok) throw new Error('创建房间失败（HTTP ' + ((act && act.status) || '?') + '）');
    SRVWAN.open = true;
    SRVWAN.state = ''; SRVWAN.room = ''; SRVWAN.code = '';
    srvWanPoll();
    if (!SRVWAN.timer) SRVWAN.timer = setInterval(srvWanPoll, 1500);
    toast('外网联机房间创建中 —— 就绪后会显示房间码');
  } catch (e) {
    SRVWAN.open = false;
    if (box) {
      box.innerHTML = srvWanHead('<span class="srv-wan-badge" style="color:#f87171;background:rgba(248,113,113,.14);border-color:rgba(248,113,113,.4)">未启动</span>') +
        '<div class="srv-wan-tips">' + esc(e.message) +
        '<span class="srv-wan-warn">也可以手动走另一条路：装 ZeroTier / Radmin VPN，和朋友加入同一网络后，用上面的「连接地址」面板里的地址直连。</span></div>' +
        '<div class="srv-wan-code"><button class="btn ghost sm" id="btnSrvWanRetry">重试</button>' +
        '<button class="btn ghost sm" id="btnSrvWanStop">关闭</button></div>';
      const rt = box.querySelector('#btnSrvWanRetry');
      if (rt) rt.addEventListener('click', srvWanStart);
      const cs = box.querySelector('#btnSrvWanStop');
      if (cs) cs.addEventListener('click', srvWanHide);
    }
    toast('外网联机未启动：' + e.message, 'error');
  } finally { SRVWAN.busy = false; }
}
async function srvWanStop() {
  if (SRVWAN.timer) { clearInterval(SRVWAN.timer); SRVWAN.timer = null; }
  try { await window.lmc.mpAct({ action: 'ide' }); } catch (_) {}
  srvWanHide();
  toast('已中断外网联机');
}
function showServerConsole(name) {
  const s = SRV.list.find(x => x.name === name);
  $('#srvConsole').style.display = '';
  $('#srvConName').textContent = name;
  $('#srvConMeta').textContent = s
    ? coreName(s.core) + ' ' + s.ver + ' · localhost:' + (s.port || 25565) + ' · ' + (s.onlineMode ? '正版验证' : '离线模式')
    : '';
  $('#srvDot').classList.toggle('on', !!(s && s.running));
  renderServerAddr(s);
  /* 切换服务器时同步刷新外网联机面板（房间是机器级的，地址列表跟着当前服务器） */
  if (SRVWAN.open) srvWanRender();
  const box = $('#srvLog');
  box.innerHTML = '';
  const logs = SRV.logs[name] || [];
  if (!logs.length) {
    box.innerHTML = '<div class="t-dim">' + (s && s.running ? '等待服务器输出…' : '服务器未运行，点击上方「启动」开始') + '</div>';
  } else logs.forEach(srvLogLine);
}
function srvLogLine(entry) {
  const box = $('#srvLog');
  if (!box) return;
  if (box.children.length === 1 && box.firstChild.classList.contains('t-dim')) box.innerHTML = '';
  let cls = '';
  if (/ERROR|Exception|错误|失败|Caused by|FAILED/i.test(entry.line)) cls = 't-err';
  else if (/WARN|警告|WARNING/i.test(entry.line)) cls = 't-warn';
  if (entry.self) cls = (cls + ' t-dim').trim();
  box.appendChild(el('div', cls, esc(entry.line)));
  while (box.children.length > 600) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
function setSrvProgress(pct, text) {
  const bar = $('#srvProgBar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
  const tx = $('#srvProgTx');
  if (tx) tx.textContent = text || '';
}
async function startServer(name) {
  const s = SRV.list.find(x => x.name === name);
  if (s && s.running) { toast('服务器已在运行中', 'warn'); return; }
  SRV.sel = name;
  renderServerList();
  showServerConsole(name);
  toast('正在启动服务器「' + name + '」…');
  try {
    const r = await window.lmc.serverStart({ name });
    if (s) { s.running = true; if (r && r.addr) s.addr = r.addr; }
    renderServerList();
    showServerConsole(name);
    const { local, lan } = srvAddrInfo(s);
    toast('服务器已启动 · 进服地址 ' + local + (lan.length ? '（好友 ' + lan[0] + '）' : '') +
      '，看到日志出现 Done 即可连入');
  } catch (e) {
    toast('启动失败：' + e.message, 'error');
  }
}
async function stopServer(name) {
  try {
    const r = await window.lmc.serverStop({ name });
    if (r && !r.ok) toast(r.error, 'warn');
    else toast('已发送停止指令，服务器保存世界后退出', 'ok');
  } catch (e) { toast('停止失败：' + e.message, 'error'); }
}
async function deleteServer(name) {
  if (!(await askConfirm('确定删除服务器「' + name + '」？', { danger: true, detail: '整个服务器目录（含世界存档、插件）会被移入回收站，可从回收站还原。' }))) return;
  try {
    await window.lmc.serverDelete({ name });
    toast('服务器「' + name + '」已移入回收站');
    if (SRV.sel === name) { SRV.sel = ''; $('#srvConsole').style.display = 'none'; }
    await loadServerList();
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}
function bindServerEvents() {
  if (SRV.bound) return;
  SRV.bound = true;
  $('#srvList').addEventListener('click', async (e) => {
    const card = e.target.closest('.srv-card');
    if (!card) return;
    const name = card.dataset.srv;
    /* 点地址行 = 复制地址（不进「选中服务器」逻辑） */
    const addrEl = e.target.closest('[data-addr]');
    if (addrEl) { e.stopPropagation(); copySrvAddr(addrEl.dataset.addr); return; }
    const actEl = e.target.closest('[data-a]');
    if (!actEl) { SRV.sel = name; renderServerList(); showServerConsole(name); return; }
    e.stopPropagation();
    const act = actEl.dataset.a;
    if (act === 'start') startServer(name);
    else if (act === 'stop') stopServer(name);
    else if (act === 'sync') syncServerMods(name);
    else if (act === 'dir') { try { await window.lmc.serverOpenDir({ name }); } catch (err) { toast(err.message, 'error'); } }
    else if (act === 'del') deleteServer(name);
  });
  $('#btnSrvCreate').addEventListener('click', async () => {
    if (SRV.creating) return;
    const name = $('#srvName').value.trim();
    const ver = $('#srvVersion').value;
    if (!name) { toast('请填写服务器名称', 'warn'); $('#srvName').focus(); return; }
    if (!ver) { toast('请选择游戏版本（若列表为空请稍候或切换核心）', 'warn'); return; }
    if (SRV.list.some(x => x.name === name)) { toast('已存在同名服务器，请换个名称', 'warn'); return; }
    SRV.creating = true;
    const btn = $('#btnSrvCreate');
    btn.disabled = true;
    $('#srvProgWrap').style.display = '';
    setSrvProgress(0, '准备中…');
    try {
      const r = await window.lmc.serverCreate({
        name, ver, core: SRV.core,
        memMB: parseInt($('#srvMem').value, 10) || 2048,
        port: parseInt($('#srvPort').value, 10) || 25565,
        maxPlayers: parseInt($('#srvMax').value, 10) || 20,
        motd: $('#srvMotd').value.trim(),
        difficulty: $('#srvDiff').value,
        gamemode: $('#srvMode').value,
        seed: $('#srvSeed').value.trim(),
        onlineMode: $('#srvOnline').checked
      });
      if (!r || !r.ok) throw new Error((r && r.error) || '创建失败');
      setSrvProgress(100, '创建完成');
      $('#srvName').value = '';
      $('#srvMotd').value = '';
      await loadServerList();
      SRV.sel = name;
      const ns = SRV.list.find(x => x.name === name);
      if (ns && r.addr) ns.addr = r.addr;
      renderServerList();
      showServerConsole(name);
      /* 创建完成后的第一件事：把「玩家怎么进来」的地址直接摆出来（不用再去翻配置） */
      const ai = srvAddrInfo(ns || { port: (r.meta && r.meta.port) || 25565 });
      toast('「' + name + '」创建完成 · 进服地址 ' + ai.local +
        (ai.lan.length ? '，好友用 ' + ai.lan[0] : ''), 'ok');
      const ab = $('#srvAddrBox');
      if (ab && ab.scrollIntoView) { try { ab.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {} }
    } catch (e) {
      setSrvProgress(0, '失败：' + e.message);
      toast('创建失败：' + e.message, 'error');
    } finally {
      SRV.creating = false;
      btn.disabled = false;
      setTimeout(() => { $('#srvProgWrap').style.display = 'none'; }, 3500);
    }
  });
  $('#btnSrvStart').addEventListener('click', () => SRV.sel && startServer(SRV.sel));
  $('#btnSrvStop').addEventListener('click', () => SRV.sel && stopServer(SRV.sel));
  $('#btnSrvWan').addEventListener('click', () => {
    if (SRVWAN.open) { srvWanRender(); $('#srvWanBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
    srvWanStart();
  });
  $('#btnSrvDir').addEventListener('click', async () => {
    if (!SRV.sel) return;
    try { await window.lmc.serverOpenDir({ name: SRV.sel }); } catch (e) { toast(e.message, 'error'); }
  });
  const sendCmd = async () => {
    const v = $('#srvCmd').value.trim();
    if (!v) return;
    if (!SRV.sel) { toast('请先选择一个服务器', 'warn'); return; }
    $('#srvCmd').value = '';
    try {
      const r = await window.lmc.serverCmd({ name: SRV.sel, cmd: v });
      if (r && !r.ok) toast(r.error, 'warn');
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#btnSrvCmd').addEventListener('click', sendCmd);
  $('#srvCmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCmd(); });
}
$('#btnSrvJavas').addEventListener('click', async () => {
  try {
    const r = await window.lmc.serverJavas();
    if (!r || !r.ok) { toast('检测失败：' + ((r && r.error) || '未知错误'), 'error'); return; }
    if (!r.javas.length) { toast('本机未检测到 Java，请到「设置 → Java 下载」安装后重试', 'warn'); return; }
    toast('已检测到 ' + r.javas.length + ' 个 Java：' + r.javas.map(j => 'Java ' + j.major).join(' / '));
  } catch (e) { toast('检测失败：' + e.message, 'error'); }
});
/* 主进程推送：服务器日志 / 状态 / 创建进度 */
window.lmc.on('server:log', (d) => {
  if (!d || !d.name) return;
  const arr = SRV.logs[d.name] = SRV.logs[d.name] || [];
  arr.push({ line: d.line, self: d.self });
  while (arr.length > 800) arr.shift();
  if (PLG.pane === 'server' && SRV.sel === d.name) srvLogLine({ line: d.line, self: d.self });
  srvWatchModKick(d);
  /* 服务端加载完成（日志出现 "Done (x.xxxs)!"）→ 这时端口才真正在监听，提示「可以进服了」并亮一次地址 */
  if (!d.self && /Done \([\d.]+s\)!/.test(d.line) && !SRV.ready[d.name]) {
    SRV.ready[d.name] = true;
    const s = SRV.list.find(x => x.name === d.name);
    if (s) s.running = true;
    const ai = srvAddrInfo(s || {});
    toast('「' + d.name + '」已就绪，可以进服了 · 地址 ' + ai.local +
      (ai.lan.length ? '（好友 ' + ai.lan[0] + '）' : ''), 'ok');
    if (PLG.pane === 'server' && SRV.sel === d.name) { renderServerList(); renderServerAddr(s); }
  }
});
window.lmc.on('server:state', (d) => {
  if (!d || !d.name) return;
  const s = SRV.list.find(x => x.name === d.name);
  if (s) s.running = !!d.running;
  if (!d.running) delete SRV.ready[d.name];
  if (PLG.pane === 'server') {
    renderServerList();
    if (SRV.sel === d.name) {
      $('#srvDot').classList.toggle('on', !!d.running);
      renderServerAddr(s);
    }
  }
  if (d.error) toast('服务器「' + d.name + '」启动失败：' + d.error, 'error');
});
window.lmc.on('server:progress', (d) => {
  if (!d || PLG.pane !== 'server') return;
  setSrvProgress(d.pct, d.text);
});

/* ---------------- 版本更新（设置页） ----------------
 * 检测开发者发布的下载页 → 对比本机版本 → 发现新版可直接在启动器内下载、
 * 运行安装包，或（便携版）一键覆盖重启，全程不需要开发者模式。 */
const UPD = { info: null, dl: null, busy: false, autoTried: false };

function fmtSize(n) {
  const b = Number(n) || 0;
  if (!b) return '';
  const mb = b / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}
function fmtTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); } catch (_) { return '—'; }
}
function setUpdState(kind, text) {
  const st = $('#updState');
  if (st) st.className = 'upd-state' + (kind ? ' ' + kind : '');
  if (text && $('#updStateTx')) $('#updStateTx').textContent = text;
}
function updKindOf(name) {
  return /portable/i.test(name) ? '便携版' : /setup|install/i.test(name) ? '安装版' : '更新包';
}
/* 渲染检测结果（info=null 表示清空） */
function renderUpdateResult(info) {
  const box = $('#updResult');
  if (!box) return;
  if (!info) { box.innerHTML = ''; setUpdState('', '尚未检测'); return; }
  if (info.ok === false) {
    setUpdState('err', '检测失败');
    box.innerHTML = '<div class="upd-box"><b>检测更新失败</b><p>' + esc(info.error || '未知错误') +
      '</p><p>可以点「打开下载页」手动查看最新版本。更新源已锁定为官方下载页（不可修改），' +
      (info.locked
        ? '本次请求用的是非官方地址，已被启动器拒绝。'
        : '若长期检测失败，可能是网络不通或官方页面暂时不可用，稍后再试。') +
      '</p></div>';
    return;
  }
  if (!info.hasUpdate) {
    setUpdState('ok', '已是最新版本');
    box.innerHTML = '<div class="upd-box"><b>已是最新版本 · ' + esc(info.current) + '</b><p>' +
      (info.newerThanRemote
        ? '当前版本比更新源上的版本还要新（本地开发版？）。'
        : '更新源上的最新版本是 ' + esc(info.latest) + '，与当前版本一致。') +
      '</p><p>检测时间：' + fmtTime(info.checkedAt) + '</p></div>';
    return;
  }
  setUpdState('new', '发现新版本 ' + info.latest);
  const dls = Array.isArray(info.downloads) ? info.downloads : [];
  let html = '<div class="upd-box new"><b>发现新版本 ' + esc(info.latest) + '（当前 ' + esc(info.current) + '）</b>' +
    '<p>可以直接在启动器内下载新版本，也可以让浏览器下载；装好后启动器就是新版了。</p>';
  if (info.notes) html += '<div class="upd-notes">' + esc(info.notes) + '</div>';
  if (dls.length) {
    html += dls.map((d, i) => {
      const ic = /portable/i.test(d.name) ? '🚀' : /setup|install/i.test(d.name) ? '⚙️' : '📦';
      const sub = [updKindOf(d.name), d.size].filter(Boolean).join(' · ');
      return '<div class="upd-dl">' +
        '<span class="upd-dl-ic">' + ic + '</span>' +
        '<span class="upd-dl-meta"><b>' + esc(d.name) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</span>' +
        '<span class="upd-dl-acts">' +
        '<button class="btn ghost" data-upd-browser="' + i + '"><svg class="ic sm"><use href="#i-external"/></svg> 浏览器下载</button>' +
        '<button class="btn primary" data-upd-dl="' + i + '"><svg class="ic sm"><use href="#i-download"/></svg> 启动器内下载</button>' +
        '</span></div>';
    }).join('');
  } else {
    html += '<p>更新源没有给出可识别的下载直链，请点「打开下载页」手动下载。</p>';
  }
  html += '<div class="btn-row" style="margin-top:12px"><button class="btn ghost" id="btnUpdIgnore">' +
    '<svg class="ic sm"><use href="#i-x"/></svg> 跳过此版本</button></div><div id="updDlBox"></div></div>';
  box.innerHTML = html;
  $$('#updResult [data-upd-browser]').forEach(b => b.addEventListener('click', () => {
    const d = dls[parseInt(b.dataset.updBrowser, 10)];
    if (d) window.lmc.openUrl(d.url).catch(() => toast('无法打开链接', 'error'));
  }));
  $$('#updResult [data-upd-dl]').forEach(b => b.addEventListener('click', () => {
    const d = dls[parseInt(b.dataset.updDl, 10)];
    if (d) startUpdateDownload(d);
  }));
  const ig = $('#btnUpdIgnore');
  if (ig) ig.addEventListener('click', async () => {
    const r = await window.lmc.updateIgnore({ version: info.latest });
    if (r && r.config) S.config = r.config;
    UPD.info = null;
    setUpdState('', '已跳过 ' + info.latest);
    $('#updDlBox').innerHTML = '';
    toast('已跳过版本 ' + info.latest + '，之后不再提示');
  });
}
/* 已下载完成：展示路径与后续操作（运行安装包 / 打开文件夹 / 便携版一键更新） */
function renderUpdateDownloaded(r) {
  const box = $('#updDlBox');
  if (!box) return;
  const portable = !!(S.config && S.config.portableMode);
  box.innerHTML = '<div class="upd-bar"><i style="width:100%"></i></div>' +
    '<span class="upd-bar-tx">已下载：' + esc(r.path) + (r.size ? '（' + fmtSize(r.size) + '）' : '') + '</span>' +
    '<div class="btn-row" style="margin-top:10px">' +
    '<button class="btn primary" id="btnUpdRun"><svg class="ic sm"><use href="#i-play"/></svg> 运行安装包</button>' +
    '<button class="btn ghost" id="btnUpdReveal"><svg class="ic sm"><use href="#i-folder"/></svg> 打开所在文件夹</button>' +
    (portable ? '<button class="btn ghost" id="btnUpdSelf"><svg class="ic sm"><use href="#i-refresh"/></svg> 一键更新并重启</button>' : '') +
    '</div><p class="upd-bar-tx">' + (portable
      ? '「一键更新并重启」会关闭启动器、用新版本覆盖当前的便携版文件，然后自动重新打开。'
      : '运行安装包即可更新到新版本（安装向导会保留你的游戏目录与设置）。') + '</p>';
  $('#btnUpdRun').addEventListener('click', async () => {
    const rr = await window.lmc.updateRun({ path: r.path });
    if (!rr.ok) toast('无法运行安装包：' + rr.error, 'error');
    else toast('已启动安装程序，按提示完成更新即可');
  });
  $('#btnUpdReveal').addEventListener('click', () => window.lmc.updateReveal({ path: r.path }));
  const sb = $('#btnUpdSelf');
  if (sb) sb.addEventListener('click', async () => {
    const rr = await window.lmc.updateSelfReplace({ path: r.path });
    if (!rr.ok) { toast('自动更新失败：' + rr.error, 'error'); return; }
    setUpdState('busy', '正在重启并更新…');
    toast('即将关闭启动器替换为新版本，请稍候…');
    setTimeout(() => window.lmc.updateQuit(), 1500);
  });
}
/* 启动器内下载更新包（复用主进程多线程下载 + 进度推送） */
async function startUpdateDownload(d) {
  if (UPD.busy) { toast('已有一个更新下载任务在进行中', 'warn'); return; }
  if (!d || !d.url) { toast('下载地址缺失', 'error'); return; }
  UPD.busy = true;
  const box = $('#updDlBox');
  if (box) {
    box.innerHTML = '<div class="upd-bar"><i id="updBarI"></i></div>' +
      '<span class="upd-bar-tx" id="updBarTx">准备下载 ' + esc(d.name) + '…</span>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn ghost" id="btnUpdDlCancel">' +
      '<svg class="ic sm"><use href="#i-x"/></svg> 取消下载</button></div>';
    const cb = $('#btnUpdDlCancel');
    if (cb) cb.addEventListener('click', async () => {
      const r = await window.lmc.updateCancel();
      if (!r.ok) toast(r.error || '无法取消', 'warn');
    });
  }
  let r;
  try { r = await window.lmc.updateDownload({ url: d.url, name: d.name }); }
  catch (e) { r = { ok: false, error: e.message || String(e) }; }
  UPD.busy = false;
  if (!r.ok) {
    if (box) box.innerHTML = '<span class="upd-bar-tx">下载未完成：' + esc(r.error || '未知错误') + '</span>';
    toast('更新包下载失败：' + (r.error || '未知错误'), 'error');
    return;
  }
  UPD.dl = r;
  renderUpdateDownloaded(r);
  toast('更新包已下载完成');
}
async function checkUpdateNow(silent) {
  if (UPD.busy) { toast('下载进行中，请稍后再检测', 'warn'); return null; }
  setUpdState('busy', '正在检测…');
  const box = $('#updResult');
  if (box && !silent) box.innerHTML = '<div class="empty-sm">正在检测更新…</div>';
  let info;
  try { info = await window.lmc.updateCheck({}); }
  catch (e) { info = { ok: false, error: e.message || String(e) }; }
  UPD.info = info;
  renderUpdateResult(info);
  return info;
}
/* 进入设置页时展示更新状态：有缓存直接用；没有则静默检测一次（每次启动仅一次） */
async function refreshUpdatePane() {
  if (UPD.info) { renderUpdateResult(UPD.info); return; }
  const cached = await window.lmc.updateCached();
  if (cached) { UPD.info = cached; renderUpdateResult(cached); return; }
  if (UPD.autoTried || (S.config && S.config.autoCheckUpdate === false)) { setUpdState('', '尚未检测'); return; }
  UPD.autoTried = true;
  await checkUpdateNow(true);
}
/* 更新源推送：启动时自动检测到新版本 */
window.lmc.on('update:available', (info) => {
  if (!info || !info.hasUpdate) return;
  UPD.info = info;
  renderUpdateResult(info);
  toast('发现新版本 ' + info.latest + '，可在「设置 → 版本更新」里更新', 'warn');
});
/* 下载进度推送 */
window.lmc.on('update:progress', (d) => {
  if (!d) return;
  const bar = $('#updBarI'), tx = $('#updBarTx');
  if (d.phase === 'start') {
    if (tx) tx.textContent = '开始下载 ' + d.name + '…';
  } else if (d.phase === 'downloading') {
    const pct = d.pct >= 0 ? d.pct : 0;
    if (bar) bar.style.width = pct + '%';
    if (tx) {
      tx.textContent = '正在下载 ' + d.name + ' · ' + (d.pct >= 0 ? d.pct + '%' : '连接中') +
        (d.total ? '（' + fmtSize(d.got) + ' / ' + fmtSize(d.total) + '）' : '');
    }
  } else if (d.phase === 'cancelled' && tx) {
    tx.textContent = '已取消下载';
  }
});

/* ---------------- 更新公告（随版本内置） ----------------
 * 公告内容写在主进程的 CHANGELOG 里；这里只负责渲染。
 * 自动弹窗策略：这个版本第一次运行时（config.seenVersion ≠ 当前版本）弹一次。 */
function renderChangelog(data, onOk) {
  const box = $('#modalBox');
  if (!box || !data || !data.ok) return false;
  box.classList.add('cl-wide'); /* 条目较长，公告单独加宽 */
  const entry = data.entry || (data.list && data.list[0]) || null;
  let html = '<div class="cl-head">' +
    '<div class="cl-badge"><svg class="ic"><use href="#i-list"/></svg></div>' +
    '<div class="cl-head-tx"><h3>更新公告</h3><p><span class="cl-ver">' + esc(data.current) + '</span>' +
    (entry && entry.tag ? '<span class="cl-tag">' + esc(entry.tag) + '</span>' : '') +
    (entry && entry.date ? '<span>' + esc(entry.date) + '</span>' : '') +
    '</p></div></div>';
  if (!entry) {
    html += '<p class="hint">这个版本没有内置公告内容。</p>';
  } else {
    if (entry.notice) {
      html += '<div class="cl-notice"><svg class="ic"><use href="#i-warn"/></svg><span>' +
        esc(entry.notice) + '</span></div>';
    }
    const groups = entry.groups || [];
    if (groups.length) {
      html += '<div class="cl-body">' + groups.map(g =>
        '<div class="cl-group">' +
          '<div class="cl-group-head">' +
            (g.icon ? '<span class="cl-gic"><svg class="ic"><use href="#' + esc(g.icon) + '"/></svg></span>' : '') +
            '<b>' + esc(g.title) + '</b>' +
            (g.tag ? '<span class="cl-gtag">' + esc(g.tag) + '</span>' : '') +
          '</div>' +
          '<ul class="cl-list">' + (g.items || []).map(t => '<li>' + esc(t) + '</li>').join('') + '</ul>' +
        '</div>').join('') + '</div>';
    } else {
      html += '<div class="cl-body"><ul class="cl-list">' +
        (entry.items || []).map(t => '<li>' + esc(t) + '</li>').join('') + '</ul></div>';
    }
    const older = (data.list || []).filter(x => x.version !== entry.version);
    if (older.length) {
      html += '<div class="cl-hist"><b>历史版本</b>' + older.map(x =>
        '<div class="cl-row"><b>' + esc(x.version) + '</b><span>' + esc(x.date || '') + '</span></div>'
      ).join('') + '</div>';
    }
  }
  html += '<div class="cl-foot"><button class="btn primary" id="btnClOk">知道了</button></div>';
  box.innerHTML = html;
  openModal(false);   /* 更新公告：点空白不关闭 —— 要真看完点「知道了」（误点空白不该跳过公告） */
  const ok = $('#btnClOk');
  if (ok) ok.addEventListener('click', () => { closeModal(); if (typeof onOk === 'function') onOk(); });
  return true;
}
async function showChangelog() {
  let d;
  try { d = await window.lmc.updateChangelog(); }
  catch (e) { toast('无法读取更新公告：' + (e.message || e), 'error'); return; }
  if (!renderChangelog(d)) toast('更新公告读取失败', 'error');
}
/* ---------------- 首次使用引导链（启动时） ----------------
 * 顺序：① 这个版本第一次运行 → 先弹「更新公告」；
 *       ② 点「知道了」后，如果还没有任何账户 → 再弹「还没有账户」引导窗；
 *       ③ 点「知道了」→ 关窗并跳到「账户」页的创建界面，光标落在名字输入框。
 * 已有账户则完全不打扰（②直接跳过）。本次启动只引导一次。 */
let accGuideShown = false;
async function hasAnyAccount() {
  try { const r = await window.lmc.accountList(); return !!(r && r.ok && (r.accounts || []).length); }
  catch (_) { return true; }   /* 读不到就当有账户处理，宁可少打扰 */
}
/* 「还没有账户」引导窗（替代原来右下角不起眼的 toast） */
function showNoAccountGuide() {
  const box = $('#modalBox');
  if (!box) return false;
  box.classList.remove('cl-wide');
  box.innerHTML =
    '<div class="cl-head">' +
      '<div class="cl-badge"><svg class="ic"><use href="#i-user-plus"/></svg></div>' +
      '<div class="cl-head-tx"><h3>还没有玩家账户</h3>' +
      '<p><span>首次使用需要先创建一个账户</span></p></div>' +
    '</div>' +
    '<div class="cl-notice"><svg class="ic"><use href="#i-warn"/></svg><span>' +
      '创建账户后才能保存你的玩家名与自定义皮肤，进游戏也会用这个名字。' +
      '支持离线账户（随便起个名字即可）、微软正版登录、第三方外置登录三种方式。' +
    '</span></div>' +
    '<div class="cl-foot"><button class="btn primary" id="btnAccGuideOk">知道了</button></div>';
  openModal(false);   /* 无账户引导：点空白不关闭（必须点「知道了」才会跳到创建账户） */
  const ok = $('#btnAccGuideOk');
  if (ok) ok.addEventListener('click', () => {
    closeModal();
    gotoPage('account');                       /* 跳到创建账户界面 */
    const n = $('#accName');                   /* 光标落在名字输入框，可直接开始创建 */
    if (n) { try { n.focus(); } catch (_) {} }
  });
  return true;
}
/* 启动引导：公告（若有）→ 账户引导（若无账户） */
async function bootGuideChain() {
  const nextStep = async () => {
    if (accGuideShown) return;
    if (await hasAnyAccount()) return;         /* 已有账户 → 不提示 */
    accGuideShown = true;
    showNoAccountGuide();
  };
  let d = null;
  try { d = await window.lmc.updateChangelog(); } catch (_) { d = null; }
  if (d && d.ok && d.unseen && renderChangelog(d, nextStep)) {
    try { await window.lmc.updateSeen(); } catch (_) {}
    return;                                    /* 「知道了」→ nextStep */
  }
  await nextStep();
}

/* ---------------- 初始化 ---------------- */
/* 启动遮罩：主窗口已显示但数据还在拉，用进度条 + 文案告诉用户「正在启动」，拉完淡出 */
function bootStep(pct, tip) {
  const bar = document.getElementById('bootBarFill');
  const t = document.getElementById('bootTip');
  if (bar) bar.style.width = Math.max(8, Math.min(100, pct)) + '%';
  if (t && tip) t.textContent = tip;
}
function bootDone() {
  const m = document.getElementById('bootMask');
  if (!m) return;
  bootStep(100, '已就绪');
  setTimeout(() => {
    m.classList.add('hide');
    setTimeout(() => { try { m.remove(); } catch (_) {} }, 400);
  }, 160);
}
(async function init() {
  bootStep(12, '正在读取背景…');
  const bg = await window.lmc.getBg();
  personalBgData = bg && bg.ok ? bg.dataUrl : '';
  setupPersonalize();
  bootStep(28, '正在载入设置…');
  await loadConfigUI();
  loadHeroHead();   /* 主页头像：当前账户的离线皮肤（不阻塞启动） */
  appendLog('Xero Lite Craft Launcher ' + (S.config.appVersion || '') + ' 已就绪', 't-dim');
  bootStep(50, '正在扫描游戏目录…');
  await scanDir();
  bootStep(74, '正在检测 Java 环境…');
  detectJavaUI();
  loadManifest();
  frSignalStart(); // 好友联机信令轮询：随时接收邀请/同意/拒绝/房间码（不局限于好友页）
  // MOD / 整合包区在下载页 tab 内懒加载：首次切换到对应 tab 自动拉热门（PCL 式进页有内容）
  moveRailInd(); // 初始定位侧边栏滑动指示条（主页默认 active）
  moveTabInd($('#dlTabs')); // 初始定位下载页分类指示条（正式版默认 active）
  updateDlHead(dlCat);      // 标题与默认分类（正式版）保持一致
  bootStep(100, '已就绪');
  /* 界面可交互后再撤遮罩：等两帧让首屏绘制完成，避免露出半成品画面 */
  requestAnimationFrame(() => requestAnimationFrame(() => bootDone()));
  /* 启动引导链：先弹更新公告（本版本首次），「知道了」后无账户再弹账户引导 → 跳创建界面 */
  setTimeout(() => { bootGuideChain(); }, 700);
})();
