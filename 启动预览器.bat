@echo off
chcp 65001 >nul
title XLC 安卓版 · 桌面预览器
cd /d "%~dp0"

set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

set "ELECTRON=D:\LMC启动器\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo [错误] 找不到 Electron: %ELECTRON%
  echo 请确认 D:\LMC启动器\node_modules 存在。
  pause
  exit /b 1
)

echo 正在启动 XLC 安卓版桌面预览器...
echo   界面来源: app\src\main\assets\web
echo   提示: 窗口菜单「设备尺寸」可切换手机横屏/竖屏
echo.
"%ELECTRON%" --no-sandbox --disable-gpu "%~dp0qa\desktop-preview.js"

if errorlevel 1 (
  echo.
  echo [预览器已退出] 退出码 %errorlevel%
  pause
)
