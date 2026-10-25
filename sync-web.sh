#!/usr/bin/env bash
# ============================================================
# 把桌面端（D:\LMC启动器）的 Web UI 同步进安卓工程
#
# 安卓端复用桌面端的界面层，但打包需要真实文件在 assets 下，
# 所以这里做**单向同步**：桌面端是唯一真相源，assets/web 只是产物。
# 每次改完桌面 UI，跑一次本脚本即可，不要反向修改安卓侧的副本。
#
# 用法:  bash sync-web.sh
# ============================================================
set -euo pipefail

SRC="${SRC:-/d/LMC启动器/src}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="$ROOT/app/src/main/assets/web"
PY="${PYTHON:-python}"

[ -d "$SRC" ] || { echo "源目录不存在: $SRC"; exit 1; }
mkdir -p "$DST"

echo "[1/4] 复制界面文件"
for f in index.html styles.css boot.css renderer.js; do
  if [ ! -f "$SRC/$f" ]; then echo "  缺少 $SRC/$f"; exit 1; fi
  cp -f "$SRC/$f" "$DST/$f"
  printf '  %-14s %s 字节\n' "$f" "$(stat -c%s "$DST/$f")"
done

echo "[2/4] 同步中文名数据库（离线中文搜索 / MOD 中文名）"
ZH_SRC="${ZH_DB:-/d/LMC启动器/data/mod-zh-db.json}"
ZH_DST="$ROOT/app/src/main/assets/data/mod-zh-db.json"
mkdir -p "$(dirname "$ZH_DST")"
if [ -f "$ZH_SRC" ]; then
  cp -f "$ZH_SRC" "$ZH_DST"
  printf '  %-14s %s 字节\n' "mod-zh-db.json" "$(stat -c%s "$ZH_DST")"
else
  echo "  未找到 $ZH_SRC（中文名将退化为英文原名，不影响下载）"
fi

echo "[3/4] 注入移动端桥接脚本"
"$PY" - "$DST/index.html" <<'PY'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
changed = []

# ① mobile-bridge.js 必须排在 renderer.js 之前：
#    init() 一执行就会调用 window.lmc，桥接晚一步建立整个启动链会直接抛错。
bridge = '<script src="mobile-bridge.js"></script>\n'
if 'mobile-bridge.js' in s:
    print('  mobile-bridge.js 已注入过，跳过')
else:
    key = '<script src="renderer.js"></script>'
    if key in s:
        s = s.replace(key, bridge + key, 1)
        changed.append('mobile-bridge.js')
    else:
        s = s.replace('</body>', bridge + '</body>', 1)
        changed.append('mobile-bridge.js(兜底)')

# ② android-extra.js 排在 renderer.js 之后：它是安卓专属的界面增强
#    （存储权限卡片 / Java 运行时面板），只动 DOM，不碰桌面端源码。
extra = '<script src="android-extra.js"></script>\n'
if 'android-extra.js' in s:
    print('  android-extra.js 已注入过，跳过')
else:
    key = '<script src="renderer.js"></script>'
    if key in s:
        s = s.replace(key, key + '\n' + extra, 1)
        changed.append('android-extra.js')
    else:
        s = s.replace('</body>', extra + '</body>', 1)
        changed.append('android-extra.js(兜底)')

if changed:
    io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
    print('  已注入: ' + ', '.join(changed))
PY

echo "[4/4] 校验注入结果"
grep -n 'mobile-bridge.js\|android-extra.js\|renderer.js"' "$DST/index.html" | sed 's/^/  /'

echo "同步完成 → $DST"
