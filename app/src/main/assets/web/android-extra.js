/* ============================================================================
 * android-extra.js —— 安卓端专属的界面增强
 *
 * 为什么单独一个文件：
 *   界面层（index.html / renderer.js）是从桌面端单向同步过来的，桌面端才是唯一真相源。
 *   所以安卓端独有的东西一律不写进桌面源码，改由本脚本在运行时「挂」到现有 DOM 上。
 *   sync-web.sh 负责把它注入到 index.html（排在 renderer.js 之后）。
 *
 * 这一版加了两块：
 *   ① 存储权限卡片 —— 安卓 11+ 必须跳系统设置页授权，界面里得有个入口
 *   ② Java 运行时面板 —— 已在设备上的版本（可测试 / 卸载）+ 可下载的版本
 * ========================================================================== */
(function () {
  'use strict';

  var L = window.lmc || {};
  // 只在安卓端生效：桌面端没有这些接口
  if (!L.javaOverview || !L.javaStorageStatus) return;

  var ID = 'xlcAndroidExtra';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(tag, cls, html) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  }

  var state = { storage: null, overview: null, busy: false, progress: '' };

  /* ------------------------------------------------------------------ 构建 */

  function build() {
    var javaList = document.getElementById('javaList');
    if (!javaList || document.getElementById(ID)) return false;
    var card = javaList.closest ? javaList.closest('.card') : null;
    if (!card) return false;

    var box = el('div', '');
    box.id = ID;

    // ① 存储权限
    var permLine = el('div', 'field-line');
    permLine.innerHTML =
      '<span>存储权限</span>' +
      '<b id="xlcPermState" style="font-size:12px">检测中…</b>' +
      '<button class="btn ghost" id="xlcPermBtn">去授权</button>';
    box.appendChild(permLine);
    box.appendChild(el('p', 'hint',
      '安卓 11 及以上需要在系统设置里开启「所有文件访问」。游戏目录放在共享存储上，' +
      '这样你才能用文件管理器直接往里丢 mod / 存档；Java 运行时则落在应用私有目录（共享存储是 noexec，二进制跑不起来）。'));

    // ② Java 运行时
    box.appendChild(el('div', 'field-line', '<span>已安装运行时</span>'));
    var list = el('div', 'mini-list');
    list.id = 'xlcJreList';
    box.appendChild(list);

    var prog = el('p', 'hint');
    prog.id = 'xlcJavaProg';
    prog.style.display = 'none';
    box.appendChild(prog);

    var row = el('div', 'btn-row');
    row.innerHTML =
      '<button class="btn ghost" id="xlcJreRefresh">刷新</button>' +
      '<span class="hint" id="xlcJreAvail" style="margin-left:10px"></span>';
    box.appendChild(row);

    // 插在「Java 路径」和原有列表之间
    card.insertBefore(box, javaList);

    document.getElementById('xlcPermBtn').addEventListener('click', doRequestPerm);
    document.getElementById('xlcJreRefresh').addEventListener('click', refresh);
    return true;
  }

  /* ------------------------------------------------------------------ 交互 */

  function setProgress(txt) {
    var p = document.getElementById('xlcJavaProg');
    if (!p) return;
    p.textContent = txt || '';
    p.style.display = txt ? '' : 'none';
  }

  async function doRequestPerm() {
    var btn = document.getElementById('xlcPermBtn');
    if (btn) { btn.disabled = true; btn.textContent = '等待授权…'; }
    try {
      await L.javaStorageRequest();
    } catch (e) { /* 用户取消也走这里 */ }
    if (btn) { btn.disabled = false; btn.textContent = '去授权'; }
    refresh();
  }

  async function doTest(javaPath, label) {
    if (state.busy) return;
    state.busy = true;
    setProgress('正在执行 java -version …');
    try {
      var r = await L.javaTest(label);
      if (r && r.ok) {
        setProgress('✓ ' + (r.output || 'java 可正常运行').split('\n')[0]);
      } else {
        setProgress('✗ ' + ((r && (r.output || r.error)) || '执行失败').split('\n')[0]);
      }
    } catch (e) {
      setProgress('✗ ' + ((e && e.message) || e));
    }
    state.busy = false;
  }

  async function doRemove(label) {
    var r = await L.confirmBox({
      message: '卸载 Java ' + label + '？',
      detail: '只删除启动器下载的运行时，不影响系统里的其它 Java。',
      okText: '卸载',
      danger: true
    });
    if (!r || !r.ok) return;   // confirmBox 返回 {ok} / {error}，与桌面端一致
    await L.javaRemove(label);
    refresh();
  }

  /* ------------------------------------------------------------------ 渲染 */

  async function refresh() {
    if (!document.getElementById(ID)) return;
    var st = null, ov = null;
    try { st = await L.javaStorageStatus(); } catch (e) { }
    try { ov = await L.javaOverview(); } catch (e) { }
    state.storage = st;
    state.overview = ov;

    var permState = document.getElementById('xlcPermState');
    var permBtn = document.getElementById('xlcPermBtn');
    if (permState) {
      var granted = !!(st && st.granted);
      permState.textContent = granted ? '已授权' : '未授权';
      permState.style.color = granted ? '#4ade80' : '#fbbf24';
    }
    if (permBtn && st) {
      permBtn.textContent = st.granted ? '权限设置' : '去授权';
    }

    var avail = document.getElementById('xlcJreAvail');
    if (avail && ov) {
      var can = (ov.downloadable || []).join(' / ');
      avail.textContent = can
        ? '可下载：Java ' + can + '（当前设备 ' + esc(ov.abi) + '）'
        : '当前设备暂无可下载的运行时';
    }

    var list = document.getElementById('xlcJreList');
    if (!list) return;
    list.innerHTML = '';
    try {
      var installed = await L.detectJava();
      if (!installed || !installed.length) {
        list.innerHTML = '<div class="empty-sm">还没有安装移动端 Java 运行时 · 用下方「下载 Java」装一个</div>';
        return;
      }
      installed.forEach(function (j) {
        var tag = j.foreignArch ? '（非本机架构）' : '';
        var item = el('div', 'mini-item',
          '<div class="dot-ic"><svg class="ic sm"><use href="#i-cpu"/></svg></div>' +
          '<div class="mi-main"><b>Java ' + esc(j.major) + tag +
          (j.version ? ' <span style="opacity:.7">' + esc(j.version) + '</span>' : '') +
          '</b><span>' + esc(j.path) + '</span></div>');
        var act = el('div', '');
        var bTest = el('button', 'btn ghost mi-act', '测试');
        var bDel = el('button', 'btn ghost mi-act', '卸载');
        bDel.style.marginLeft = '6px';
        bTest.addEventListener('click', function () { doTest(j.path, j.major); });
        bDel.addEventListener('click', function () { doRemove(j.major); });
        act.appendChild(bTest);
        act.appendChild(bDel);
        item.appendChild(act);
        list.appendChild(item);
      });
    } catch (e) {
      list.innerHTML = '<div class="empty-sm">读取已安装运行时失败</div>';
    }
  }

  /* ------------------------------------------------------------------ 启动 */

  function start() {
    if (!build()) return;
    // 下载 / 解压进度：原生通过 java:progress 推过来
    L.on && L.on('java:progress', function (d) {
      if (!d) return;
      setProgress(d.text || '');
    });
    L.on && L.on('app:toast', function () {
      setTimeout(refresh, 400);
    });
    refresh();
    setInterval(refresh, 6000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 600); });
  } else {
    setTimeout(start, 600);
  }
})();
