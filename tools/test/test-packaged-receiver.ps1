# 从当前版本的 ZIP 验证接收方启动；仅写项目隔离目录，不连接账号。
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$archive = Join-Path $projectRoot "dist/XuexitongAssistant-$version-win-x64.zip"
$receiverDir = Join-Path $projectRoot ('.desktop-test/接收方 ' + $version + ' ' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $receiverDir | Out-Null
$zipTool = Join-Path $projectRoot '.build-cache/builder/7zip@1.0.0/7zip-win-x64-a34pt/bin/7za.exe'
& $zipTool x $archive "-o$receiverDir" -y > (Join-Path $receiverDir 'extract.log')
if ($LASTEXITCODE -ne 0) { throw '压缩包解压失败' }
$packaged = Get-Content -LiteralPath (Join-Path $receiverDir 'resources/app/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($packaged.version -ne $version) { throw '解压后的版本不一致' }
$testData = Join-Path $receiverDir '测试数据'
$previousPath = $env:PATH
$previousTestData = $env:XXT_TEST_DATA_DIR
try {
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
  if (Get-Command node -ErrorAction SilentlyContinue) { throw '测试 PATH 中不应存在 Node.js' }
  $env:XXT_TEST_DATA_DIR = $testData
  $application = Start-Process -FilePath (Join-Path $receiverDir '学习通助手.exe') -ArgumentList '--smoke-test' -WindowStyle Hidden -Wait -PassThru
  if ($application.ExitCode -ne 0) { throw "桌面进程退出码 $($application.ExitCode)" }
  $report = Get-Content -LiteralPath (Join-Path $testData 'smoke-result.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $report.packaged -or -not $report.status.ready -or -not $report.status.settings.essayAutoFill) { throw '打包程序未就绪或缺少简答设置' }
  if ((Get-Content -LiteralPath (Join-Path $testData 'logs/desktop.log') -Raw -Encoding UTF8) -notmatch '后台退出 0') { throw '后台未正常退出' }
  Write-Output "通过：$version 中文与空格路径解压启动、无系统 Node.js、简答设置、后台正常退出"
  Write-Output "接收方目录：$receiverDir"
} finally {
  $env:PATH = $previousPath
  $env:XXT_TEST_DATA_DIR = $previousTestData
}
