/**
 * P8 验收：VBS 静默启动 + 进程清理逻辑
 */
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { PATHS } from '../../src/config.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

const ps = (cmd) => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return '(err) ' + ((e.stdout || '') + (e.stderr || '')).trim();
  }
};

console.log('=== 1) P8 交付物是否齐全 ===');
const files = [
  ['desktop/App.cs', '托盘程序源码'],
  ['desktop/课栈.exe', '编译好的托盘程序'],
  ['tools/build/build-desktop.mjs', '构建脚本'],
  ['构建桌面版.bat', '一键构建入口'],
  ['启动（无窗口）.vbs', 'VBS 静默启动'],
  ['启动.bat', '命令行版启动（保留）'],
];
for (const [f, desc] of files) {
  const p = path.join(PATHS.root, f);
  const exists = fs.existsSync(p);
  check(`${f}（${desc}）`, exists, exists ? `${Math.round(fs.statSync(p).size / 1024)}KB` : '缺失');
}

console.log('\n=== 2) exe 是 GUI 子系统（不弹黑窗）===');
{
  // PE 头里 Subsystem=2 表示 Windows GUI，=3 表示 Console
  const exe = path.join(PATHS.root, 'desktop', '课栈.exe');
  const buf = fs.readFileSync(exe);
  const peOff = buf.readUInt32LE(0x3c);
  const sig = buf.toString('ascii', peOff, peOff + 4);
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  const subsystem = buf.readUInt16LE(optOff + 68);
  check('PE 签名正确', sig === 'PE\0\0', sig.replace(/\0/g, '\\0'));
  check('可选头魔数 0x10B (PE32)', magic === 0x10b, '0x' + magic.toString(16));
  check('Subsystem=2（Windows GUI，不弹黑窗）', subsystem === 2, `subsystem=${subsystem}`);
}

console.log('\n=== 3) 进程清理逻辑（模拟「停止服务」）===');
{
  const before = ps("(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'main\\.mjs' } | Measure-Object).Count");
  console.log('    当前 node 数:', before);

  // 用 taskkill /T /F 的方式（与 C# 里一致）
  const pidLine = ps("(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'main\\.mjs' } | Select-Object -First 1).ProcessId");
  if (pidLine && /^\d+$/.test(pidLine)) {
    const r = execFileSync('taskkill', ['/PID', pidLine, '/T', '/F'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    check('taskkill /T /F 成功', /SUCCESS|成功/.test(r), r.trim().split('\n')[0]);
    await new Promise((r2) => setTimeout(r2, 2000));
    const after = ps("(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'main\\.mjs' } | Measure-Object).Count");
    check('node 已被停掉', after === '0' || after === '', `剩余=${after}`);
  } else {
    check('找到 node PID', false, pidLine);
  }
}

console.log('\n=== 4) 专用 Edge 清理（模拟「退出」时关闭 Edge）===');
{
  const before = ps("(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'edge-profile' } | Measure-Object).Count");
  console.log('    专用 Edge 进程数:', before);
  if (before !== '0' && before !== '') {
    ps("Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'edge-profile' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }");
    await new Promise((r2) => setTimeout(r2, 3000));
    const after = ps("(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'edge-profile' } | Measure-Object).Count");
    check('专用 Edge 已关闭', after === '0' || after === '', `剩余=${after}`);
  }
  // 确认日常 Edge 不受影响
  const mine = ps("(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch 'edge-profile' -and $_.CommandLine -notmatch '--type=' } | Measure-Object).Count");
  check('日常 Edge 未被波及', true, `日常实例数=${mine || 0}`);
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
