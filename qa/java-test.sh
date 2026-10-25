#!/usr/bin/env bash
# ============================================================
# 在模拟器上验证 Java 运行时安装链路
#
# 用法:  bash qa/java-test.sh            （走 App 内的桥接，端到端）
#        bash qa/java-test.sh probe      （只查权限/概览，不下 25MB 包）
#
# 依赖: 模拟器在线 + XLC 已安装启动（qa/emu-run.sh 跑过）
# ============================================================
set -uo pipefail
ADB="D:/android-sdk/platform-tools/adb.exe"
NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="com.xlc.launcher"
MODE="${1:-full}"

export NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules"

cdp() { CDP_EXPR="$1" "$NODE" "$ROOT/qa/cdp.js" 2>&1 | tail -40; }

echo "=== 建立 CDP 转发 ==="
PID=$("$ADB" shell pidof "$PKG" 2>/dev/null | tr -d '\r')
if [ -z "$PID" ]; then echo "应用没在跑，先执行: bash qa/emu-run.sh"; exit 1; fi
"$ADB" forward tcp:9222 "localabstract:webview_devtools_remote_$PID" >/dev/null 2>&1
echo "  pid=$PID"

echo
echo "=== ① 存储权限状态 ==="
cdp "window.lmc.javaStorageStatus()"

echo
echo "=== ② 运行时概览（可下载 / 已安装）==="
cdp "window.lmc.javaOverview()"

echo
echo "=== ③ 已安装列表 ==="
cdp "window.lmc.detectJava()"

if [ "$MODE" = "probe" ]; then echo; echo "(probe 模式结束)"; exit 0; fi

echo
echo "=== ④ 下载并安装 Java 17（约 22MB，含解压，请耐心）==="
cdp "window.lmc.javaDownload(17)"

echo
echo "=== ⑤ 安装后列表 ==="
cdp "window.lmc.detectJava()"

echo
echo "=== ⑥ 运行验证 java -version ==="
cdp "window.lmc.javaTest(17)"

echo
echo "=== ⑦ 落盘情况 ==="
export MSYS_NO_PATHCONV=1
"$ADB" shell "ls -la \$(run-as $PKG sh -c 'echo \$PWD' 2>/dev/null)/files/java 2>/dev/null" 2>/dev/null
"$ADB" shell "run-as $PKG ls -la files/java 2>&1" | tr -d '\r'
