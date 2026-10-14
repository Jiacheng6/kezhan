@echo off
chcp 65001 >nul
cd /d "%~dp0"
call npm run build
if errorlevel 1 (
  echo 构建失败，请查看上面的错误。
  pause
  exit /b 1
)
node tools\build\verify-release.mjs
if errorlevel 1 (
  echo 发布检查失败。
  pause
  exit /b 1
)
echo 安装包和免安装 ZIP 已生成到 dist 文件夹。
pause
