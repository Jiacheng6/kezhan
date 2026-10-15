/**
 * 一键跑「不需要浏览器」的全部自检。
 *
 * 用途：改完代码先跑这个 —— 半分钟内知道有没有把基础逻辑改坏，
 * 不必启动 Edge、不必连学习通。
 *
 * 包含：
 *   1) check-modules.mjs        模块完整性：逐模块 import + 关键内容指纹（42 项）
 *   2) test-parse.mjs           答案解析与安全阀（34 项）
 *   3) test-stop-semantics.mjs  「用户中止 ≠ 失败」记账分类（15 项）
 *   4) test-selection.mjs       课程树选择算术（28 项）
 *   5) test-pages.mjs           页面台账 / 清场 / 白名单（29 项）
 *   6) test-settings.mjs        设置校验 / 单位换算 / 越界夹紧（36 项）
 *   7) check-ui-ids.mjs         界面 id / data-action / data-tree 接线（79 项）
 *
 * 实现说明：
 *   · 路径按**脚本自身位置**解析，任何工作目录下都能跑；
 *   · 子进程用 stdio:'inherit' 而不是管道 —— 受限环境里 node 的管道会 EPERM。
 *
 * 用法: node tools/test/test-offline.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 自检不读写用户实际的课程、登录信息与进度。
if (!process.env.XXT_DATA_DIR) {
  const testRoot = path.join(ROOT, '.desktop-test');
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.XXT_DATA_DIR = fs.mkdtempSync(path.join(testRoot, 'offline-'));
}

const suite = [
  ['课程完成分组 / 旧清单只读恢复', 'tools/test/test-course-groups.mjs'],
  ['课程树分任务完成状态 / 保留选择', 'tools/test/test-tree-progress.mjs'],
  ['更新状态 / 保存退出 / 数据备份', 'tools/test/test-updates.mjs'],
  ['运行中止 / 心跳进程判断', 'tools/test/test-runtime-fixes.mjs'],
  ['桌面数据目录 / 保存失败 / 默认设置', 'tools/test/test-desktop-state.mjs'],
  ['本地服务边界 / 异常请求 / 释放监听', 'tools/test/test-server.mjs'],
  ['模块完整性 / 内容指纹', 'tools/test/check-modules.mjs'],
  ['侦察报告路径', 'tools/test/check-report-path.mjs'],
  ['账号 ID 自动识别', 'tools/test/test-identity.mjs'],
  ['任务点完成判定（小节不绿≠没完成）', 'tools/test/test-completion.mjs'],
  ['小节多卡片探测（别漏读任务点）', 'tools/test/test-card-probe.mjs'],
  ['答案解析 / 安全阀', 'tools/test/test-parse.mjs'],
  ['简答草稿 / 设置 / 提交策略', 'tools/test/test-essay.mjs'],
  ['千问没回答则重问', 'tools/test/test-ai-reask.mjs'],
  ['中止语义 / 记账分类', 'tools/test/test-stop-semantics.mjs'],
  ['课程选择算术', 'tools/test/test-selection.mjs'],
  ['页面台账 / 清场', 'tools/test/test-pages.mjs'],
  ['设置校验 / 单位换算', 'tools/test/test-settings.mjs'],
  ['界面接线自检', 'tools/test/check-ui-ids.mjs'],
  ['隐私自检（上传前必跑）', 'tools/test/check-privacy.mjs'],
  ['学习信息隐私拦截', 'tools/test/test-privacy-learning.mjs'],
  ['公共资源数字误报 / 篡改保护', 'tools/test/test-privacy-public-assets.mjs'],
];

const results = [];

for (const [name, rel] of suite) {
  console.log(`\n${'='.repeat(60)}\n▶ ${name}  (${rel})\n${'='.repeat(60)}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], { cwd: ROOT, stdio: 'inherit' });
  results.push({ name, rel, code: r.status ?? 1 });
}

const failed = results.filter((r) => r.code !== 0);

console.log(`\n${'='.repeat(60)}`);
console.log('离线自检汇总');
console.log('='.repeat(60));
for (const r of results) {
  console.log(`  ${r.code === 0 ? '✓' : '✗'} ${r.name.padEnd(24)} ${r.rel}${r.code ? `（退出码 ${r.code}）` : ''}`);
}
console.log(failed.length ? `\n${failed.length} 个套件失败` : '\n全部通过 ✓');
process.exit(failed.length ? 1 : 0);
