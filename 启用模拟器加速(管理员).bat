@echo off
chcp 65001 >nul
title 启用 Android 模拟器加速（WHPX）

:: 自动请求管理员权限
>nul 2>&1 net session
if %errorlevel% neq 0 (
  echo 正在请求管理员权限...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo ============================================
echo  启用 Windows Hypervisor Platform (WHPX)
echo  Android 官方模拟器的硬件加速依赖它
echo ============================================
echo.

echo 当前状态:
dism /online /get-featureinfo /featurename:HypervisorPlatform 2>nul | findstr /i "State"
echo.

echo 正在启用（不会破坏系统，只是开启一个 Windows 官方组件）...
dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart

echo.
echo ============================================
echo  完成！【需要重启电脑才能生效】
echo  重启后回到 WorkBuddy 说一声"模拟器"即可，
echo  我会接着创建虚拟设备并安装 XLC 的 APK。
echo ============================================
echo.
echo 如果上面显示"操作成功完成"，直接重启即可。
echo 如果报错，请把窗口内容截图发给我。
pause
