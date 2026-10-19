# Executes only a local NSIS fixture: no actual installer, registry or user links.
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$cacheRoot = if ($env:ELECTRON_BUILDER_CACHE) { $env:ELECTRON_BUILDER_CACHE } else { Join-Path $projectRoot '.build-cache/builder' }
$compiler = Get-ChildItem -LiteralPath $cacheRoot -Filter makensis.exe -Recurse | Where-Object FullName -NotMatch '\\Bin\\' | Select-Object -First 1
$plugin = Get-ChildItem -LiteralPath $cacheRoot -Filter WinShell.dll -Recurse | Where-Object FullName -Match 'x86-unicode' | Select-Object -First 1
if (-not $compiler -or -not $plugin) { throw 'Missing cached NSIS compiler or WinShell plugin' }
$fixture = Join-Path $projectRoot ('.desktop-test/安装启动 ' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
$source = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
!addplugindir /x86-unicode "@PLUGIN@"
!define APP_DESCRIPTION "Installer path fixture"
!define APP_ID "com.xuexitong.assistant.fixture"
!include "@INCLUDE@"
OutFile "@EXE@"
Var appExe
Var launchLink
Var newStartMenuLink
Var newDesktopLink
Section
  ReadEnvStr $R0 XXT_INSTALLER_FIXTURE_DIR
  ReadEnvStr $R1 XXT_INSTALLER_FIXTURE_LINKS
  SetOutPath "$R0"
  StrCpy $appExe "$R0\程序 文件\学习通助手.exe"
  StrCpy $newStartMenuLink "$R0\开始菜单.lnk"
  StrCpy $newDesktopLink "$R0\桌面.lnk"
  StrCpy $launchLink "$newStartMenuLink"
  ${if} $R1 == "yes"
    CreateShortCut "$newStartMenuLink" "$R0\旧位置\missing.exe"
    CreateShortCut "$newDesktopLink" "$R0\旧位置\missing.exe"
  ${endif}
  !insertmacro customInstall
  FileOpen $R2 "$R0\launch.txt" w
  FileWriteUTF16LE $R2 "$launchLink"
  FileClose $R2
SectionEnd
'@
$fixtureExe = Join-Path $fixture 'fixture.exe'
$source = $source.Replace('@PLUGIN@',$plugin.DirectoryName).Replace('@INCLUDE@',(Join-Path $projectRoot 'desktop/installer.nsh')).Replace('@EXE@',$fixtureExe)
$script = Join-Path $fixture 'fixture.nsi'
[IO.File]::WriteAllText($script,$source,[Text.UTF8Encoding]::new($true))
& $compiler.FullName /V2 $script
if ($LASTEXITCODE -ne 0) { throw 'NSIS fixture compilation failed' }
$oldDir=$env:XXT_INSTALLER_FIXTURE_DIR
$oldLinks=$env:XXT_INSTALLER_FIXTURE_LINKS
try {
  $shell=New-Object -ComObject WScript.Shell
  foreach($mode in @('yes','no')) {
    $run=Join-Path $fixture $mode
    New-Item -ItemType Directory -Path $run | Out-Null
    $env:XXT_INSTALLER_FIXTURE_DIR=$run
    $env:XXT_INSTALLER_FIXTURE_LINKS=$mode
    $process=Start-Process -FilePath $fixtureExe -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if($process.ExitCode -ne 0) { throw 'NSIS fixture execution failed' }
    $expected=Join-Path $run '程序 文件/学习通助手.exe'
    $actual=[IO.File]::ReadAllText((Join-Path $run 'launch.txt'),[Text.Encoding]::Unicode)
    if($actual -ne $expected) { throw 'Post-install launch must use the installed executable directly' }
    foreach($name in @('开始菜单.lnk','桌面.lnk')) {
      $link=Join-Path $run $name
      if($mode -eq 'yes') {
        if($shell.CreateShortcut($link).TargetPath -ne $expected) { throw 'Existing shortcut target was not repaired' }
      } elseif(Test-Path -LiteralPath $link) { throw 'Deleted shortcut must not be recreated' }
    }
  }
  Write-Output '通过：真实 NSIS 宏直接启动安装后的 EXE、修复旧快捷方式目标、保留已删除快捷方式、支持中文与空格路径；未执行真实安装。'
} finally {
  $env:XXT_INSTALLER_FIXTURE_DIR=$oldDir
  $env:XXT_INSTALLER_FIXTURE_LINKS=$oldLinks
}
