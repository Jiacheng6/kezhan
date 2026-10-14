@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "dist\win-unpacked\学习通助手.exe" (
  start "" "dist\win-unpacked\学习通助手.exe"
  exit /b 0
)
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" "%~dp0."
  exit /b 0
)
echo 尚未构建桌面版。请使用 dist 中的安装包或免安装压缩包。
echo 开发者可先运行 npm ci 和 npm run build。
pause
exit /b 1
