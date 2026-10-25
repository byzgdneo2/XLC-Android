#!/usr/bin/env bash
# ============================================================
# XLC 安卓端 · 模拟器一键运行
#
#   安装 APK → 启动 → 截图 → 崩溃检查
#
# 用法：
#   bash qa/emu-run.sh                        # 用默认 debug APK
#   bash qa/emu-run.sh path/to/other.apk      # 指定 APK
# ============================================================
ADB="D:/android-sdk/platform-tools/adb.exe"
APK="${1:-D:/XLC-Android/app/build/outputs/apk/debug/app-debug.apk}"
OUT="D:/XLC-Android/qa/out"
PKG="com.xlc.launcher"
ACTIVITY="$PKG/.MainActivity"

mkdir -p "$OUT"
# 说明：远端路径一律用 //sdcard/... —— Git Bash 会把 //x 归一成 /x 且不做
# Windows 路径转换；本地路径用 D:/... 形式。切勿设 MSYS_NO_PATHCONV，
# 那会让 adb 收到无法解析的 /d/... 路径。

if [ ! -f "$APK" ]; then echo "[错误] APK 不存在: $APK"; exit 1; fi

echo "===== [1/4] 检查模拟器 ====="
"$ADB" wait-for-device || { echo "[错误] 没有设备"; exit 1; }
BOOT=$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n ')
echo "boot_completed=$BOOT"
if [ "$BOOT" != "1" ]; then echo "[警告] 模拟器可能还在启动中，继续尝试..."; fi

echo "===== [2/4] 安装 APK ====="
echo "APK: $APK"
"$ADB" install -r "$APK" 2>&1 | tail -3

echo "===== [3/4] 启动应用 ====="
"$ADB" logcat -c 2>/dev/null
"$ADB" shell am start -n "$ACTIVITY" 2>&1 | tail -3
sleep 10

FRONT=$("$ADB" shell dumpsys activity activities 2>/dev/null | grep -m1 -iE "topResumedActivity" | tr -d '\r')
echo "前台: $FRONT"

echo "===== [4/4] 截图 ====="
TS=$(date +%H%M%S)
"$ADB" shell screencap -p "//sdcard/xlc-$TS.png" 2>&1
"$ADB" pull "//sdcard/xlc-$TS.png" "$OUT/emulator-$TS.png" 2>&1 | tail -1
echo "截图: $OUT/emulator-$TS.png"

echo "===== 崩溃检查 ====="
CRASH=$("$ADB" logcat -d 2>/dev/null | grep -E "FATAL EXCEPTION|AndroidRuntime.*com.xlc" | tail -8)
if [ -n "$CRASH" ]; then
  echo "[发现崩溃]"
  echo "$CRASH"
else
  echo "无崩溃记录"
fi

echo "===== Web 层日志（末 15 条）====="
"$ADB" logcat -d -s XLC-Web 2>/dev/null | tail -15
