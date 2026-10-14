/**
 * 编译桌面托盘启动器（P8）。
 *
 * 用 Windows 自带的 .NET Framework csc.exe 直接编译出 exe —— 不需要装任何东西。
 * 产物：desktop\学习通助手.exe
 *
 * 用法: node tools/build/build-desktop.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PATHS } from '../../src/config.mjs';

const SRC = path.join(PATHS.root, 'desktop', 'App.cs');
const OUT_DIR = path.join(PATHS.root, 'desktop');
const OUT_EXE = path.join(OUT_DIR, '学习通助手.exe');

/** 找 csc.exe：优先 .NET Framework 自带（无需安装） */
function findCsc() {
  const roots = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework'),
  ];
  const found = [];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const v of fs.readdirSync(r)) {
      const p = path.join(r, v, 'csc.exe');
      if (fs.existsSync(p)) found.push(p);
    }
  }
  // 取版本号最大的（v4.0.30319 通常是最新的 4.x）
  found.sort().reverse();
  return found[0] || null;
}

if (!fs.existsSync(SRC)) {
  console.error('找不到源文件:', SRC);
  process.exit(1);
}

const csc = findCsc();
if (!csc) {
  console.error('找不到 csc.exe（.NET Framework 编译器）。');
  console.error('请安装 .NET Framework 4.x，或改用「启动.bat」运行。');
  process.exit(1);
}

console.log('编译器:', csc);
console.log('源文件:', SRC);
console.log('输出  :', OUT_EXE);

const args = [
  '/nologo',
  '/target:winexe', // 关键：GUI 程序，不弹控制台
  '/platform:anycpu',
  '/optimize+',
  '/r:System.dll',
  '/r:System.Drawing.dll',
  '/r:System.Windows.Forms.dll',
  `/out:${OUT_EXE}`,
  SRC,
];

try {
  const out = execFileSync(csc, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (out && out.trim()) console.log(out.trim());
} catch (err) {
  console.error('编译失败：');
  console.error((err.stdout || '') + (err.stderr || '') || err.message);
  process.exit(1);
}

if (!fs.existsSync(OUT_EXE)) {
  console.error('编译结束但没找到产物');
  process.exit(1);
}

const size = fs.statSync(OUT_EXE).size;
console.log(`\n✓ 编译成功：${OUT_EXE}`);
console.log(`  体积: ${(size / 1024).toFixed(1)} KB`);
console.log('\n用法：双击这个 exe → 托盘出现「学」图标，服务静默运行，不再有黑窗口。');
console.log('  左键双击托盘图标 = 打开控制台');
console.log('  右键 = 打开控制台 / 显示日志 / 重启 / 停止 / 退出（并关专用 Edge）');
