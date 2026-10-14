import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../../src/config.mjs';
const base = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64');
const csc = fs.readdirSync(base).sort().reverse().map((version) => path.join(base, version, 'csc.exe')).find(fs.existsSync);
if (!csc) throw new Error('构建机缺少 .NET Framework 编译器');
const native = path.join(ROOT, 'desktop', 'native');
fs.mkdirSync(native, { recursive: true });
execFileSync(csc, ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+',
  `/out:${path.join(native, 'BrowserWindowControl.exe')}`, path.join(native, 'BrowserWindowControl.cs')], { stdio: 'inherit' });
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'build', 'make-icon.ps1')], { stdio: 'inherit' });
console.log('窗口管理组件和图标构建完成');
