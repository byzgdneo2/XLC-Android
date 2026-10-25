'use strict';
/* ============================================================
 * 安卓端桥接的 JS 复刻版 —— 仅用于离线验证
 *
 * 本机没有安卓模拟器/真机，无法直接跑 APK。这个模块按
 * LmcBridge.kt 的 dispatch 逻辑逐条复刻返回值，配合 Electron
 * （与 Android WebView 同为 Chromium 内核）验证：
 *   1. mobile-bridge.js 的 Promise/回调机制是否正确
 *   2. renderer.js 的 init() 链能否在这些返回值下走完
 *   3. 界面在手机比例下的实际观感
 *
 * 注意：这里改了什么，LmcBridge.kt 也要同步改，两边必须保持一致。
 * ============================================================ */
const os = require('os');

const TODO_MSG = '移动端尚未接入此功能';
const APP_VERSION = '0.1.0-spike1';

const DEFAULT_CONFIG = {
  source: 'bmclapi',
  customSource: '',
  javaPath: '',
  mem: 4,
  memAuto: true,
  jvmArgs: '',
  forceChinese: true,
  defaultVersion: '',
  lastVersion: '',
  username: 'Steve',
  accounts: [],
  msClientId: '',
  activeAccount: '',
  bgMode: 'default',
  bgColor: '',
  accentColor: '',
  bgImage: '',
  recent: [],
  friendCode: '',
  friends: [],
  aiApi: { base: '', key: '', model: 'gpt-4o-mini' },
  plugins: {},
  updateUrl: '',
  autoCheckUpdate: true,
  ignoredVersion: '',
  lastUpdateCheck: 0,
  seenVersion: ''
};

const saved = {};          // 模拟 SharedPreferences
let friendCode = null;

function stub() { return { ok: false, error: TODO_MSG, mobileStub: true }; }

function gameDir() { return 'D:/XLC-Android/.spike-sandbox/minecraft'; }

function makeFriendCode() {
  if (friendCode) return friendCode;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  friendCode = s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
  return friendCode;
}

/* 真实扫描沙箱目录：让「已安装实例」这块能显示真实内容 */
function dirScan() {
  const fs = require('fs');
  const path = require('path');
  const gd = gameDir();
  const out = { gameDir: gd, exists: fs.existsSync(gd), versions: [], saves: [], broken: [] };
  if (!out.exists) return out;
  const vDir = path.join(gd, 'versions');
  if (fs.existsSync(vDir)) {
    for (const sub of fs.readdirSync(vDir)) {
      const subDir = path.join(vDir, sub);
      try { if (!fs.statSync(subDir).isDirectory()) continue; } catch (_) { continue; }
      const jsonFile = path.join(subDir, sub + '.json');
      if (!fs.existsSync(jsonFile)) {
        out.broken.push({ folder: sub, path: subDir, reason: '缺少 ' + sub + '.json' });
        continue;
      }
      let loader = 'Vanilla', inherits = false;
      try {
        const j = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
        const probe = JSON.stringify(j.libraries || []) + (j.mainClass || '');
        if (/fabricmc/.test(probe)) loader = 'Fabric';
        else if (/quiltmc/.test(probe)) loader = 'Quilt';
        else if (/neoforged/.test(probe)) loader = 'NeoForge';
        else if (/minecraftforge/.test(probe)) loader = 'Forge';
        else if (/optifine/i.test(probe)) loader = 'OptiFine';
        inherits = !!j.inheritsFrom;
      } catch (_) { /* 解析失败按原版处理 */ }
      out.versions.push({
        id: sub, folder: sub, loader: loader, inherits: inherits,
        hasJar: fs.existsSync(path.join(subDir, sub + '.jar')),
        mcVersion: null
      });
    }
  }
  const sDir = path.join(gd, 'saves');
  if (fs.existsSync(sDir)) {
    for (const s of fs.readdirSync(sDir)) {
      const full = path.join(sDir, s);
      try { if (fs.statSync(full).isDirectory()) out.saves.push({ name: s, path: full }); } catch (_) { }
    }
  }
  return out;
}

function dispatch(method, args) {
  const a = Array.isArray(args) ? args : (args == null ? [] : [args]);
  switch (method) {
    /* ---------- 配置 ---------- */
    case 'config:get': {
      const c = Object.assign({}, DEFAULT_CONFIG, saved);
      c.accounts = [];
      c.gameDir = gameDir();
      c.appVersion = APP_VERSION;
      c.updateDefaultUrl = '';
      c.updateLocked = true;
      c.portableMode = false;
      return c;
    }
    case 'config:save': {
      Object.assign(saved, a[0] || {});
      return { ok: true };
    }

    /* ---------- 系统 ---------- */
    case 'sys:meminfo': {
      const total = Math.round(os.totalmem() / 1073741824 * 10) / 10;
      const avail = Math.round(os.freemem() / 1073741824 * 10) / 10;
      let rec = total <= 4 ? 2 : total <= 6 ? 3 : total <= 8 ? 4 : total <= 16 ? 6 : 8;
      rec = Math.max(1, Math.min(rec, Math.max(1, Math.floor(avail * 0.6))));
      return { ok: true, totalGB: total, availGB: avail, recommendGB: rec };
    }
    case 'clipboard:write':
    case 'shell:open-external':
    case 'app:renderer-error':
    case 'win:close':
    case 'win:minimize':
    case 'win:maximize-toggle':
      return { ok: true };
    case 'shell:open':
      return { ok: false, error: '移动端暂不支持打开本地目录' };

    /* ---------- 个性化 ---------- */
    case 'personalize:get-bg': return { ok: false };
    case 'personalize:pick-bg': return { ok: false, canceled: true };

    /* ---------- 目录 / Java / 清单 ---------- */
    case 'dir:scan': return dirScan();
    case 'dir:pick': return { ok: false, canceled: true };
    case 'java:detect': return [];
    case 'manifest:get': return stub();
    case 'java:download': return stub();
    case 'net:ping': return stub();

    /* ---------- 账户 ---------- */
    case 'account:list': return { ok: true, accounts: [], active: '' };

    /* ---------- 加载器（mock 不联网：探针一律「无构建」不可点，列表返回空） ---------- */
    case 'loader:probe': return { ok: false, why: '预览器不提供加载器检测（联机请用安卓端）' };
    case 'loader:builds': return { ok: false, why: '预览器不提供加载器版本列表（联机请用安卓端）' };
    case 'optifine:asMod': return { ok: false, error: '预览器不支持安装 OptiFine（联机请用安卓端）' };
    case 'version:loader-change': return { ok: false, error: '预览器不支持更改加载器（联机请用安卓端）' };
    case 'version:loader-uninstall': return { ok: false, error: '预览器不支持卸载加载器（联机请用安卓端）' };

    /* ---------- 好友 ---------- */
    case 'friends:get': return { ok: true, code: makeFriendCode(), friends: [] };
    case 'friends:presence': return { ok: true, list: [] };
    case 'friends:signal-poll': return { ok: true, myCode: makeFriendCode(), signals: [] };
    case 'friends:signal-send': return { ok: true };

    /* ---------- 插件 ---------- */
    case 'plugin:list': return { ok: true, plugins: [] };
    case 'plugin:seedmap-platforms': return [];
    case 'plugin:toggle': return { ok: true, plugins: [] };

    /* ---------- 更新 ---------- */
    case 'update:changelog':
      return { ok: true, current: APP_VERSION, entry: null, list: [], unseen: false };
    case 'update:seen': return { ok: true, version: APP_VERSION };
    case 'update:cached': return null;
    case 'update:check': return { ok: true, hasUpdate: false };
    case 'update:ignore': return { ok: true, config: dispatch('config:get', []) };

    /* ---------- 确认框：离线验证下一律自动确认 ---------- */
    case 'ui:confirm': return { ok: true };

    default: return stub();
  }
}

module.exports = { dispatch, TODO_MSG, APP_VERSION };
