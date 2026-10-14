/**
 * 日志 + 事件总线。
 * 控制台通过 WebSocket 订阅 'log' / 'state' / 'status' 事件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PATHS, DEBUG_PORT } from './config.mjs';
import { listReviewItems } from './state.mjs';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
let logStream = null;

function stream() {
  if (logStream) return logStream;
  fs.mkdirSync(PATHS.logs, { recursive: true });
  logStream = fs.createWriteStream(path.join(PATHS.logs, `run-${RUN_ID}.jsonl`), { flags: 'a' });
  return logStream;
}

const LEVEL_ORDER = { debug: 10, info: 20, ok: 25, warn: 30, error: 40 };

/** 最近 N 条，供新开的控制台页面回放 */
const recent = [];
const RECENT_MAX = 500;

const LEVEL_TAG = { debug: '·', info: 'i', ok: '✓', warn: '!', error: '×' };

export function log(message, level = 'info', extra = {}) {
  const entry = { t: Date.now(), level, message: String(message), ...extra };

  if (LEVEL_ORDER[level] === undefined) entry.level = 'info';

  recent.push(entry);
  if (recent.length > RECENT_MAX) recent.shift();

  try {
    stream().write(`${JSON.stringify(entry)}\n`);
  } catch {
    /* 日志写失败不能影响主流程 */
  }

  // 终端回显
  const stamp = new Date(entry.t).toLocaleTimeString('zh-CN', { hour12: false });
  const tag = LEVEL_TAG[entry.level] || 'i';
  // eslint-disable-next-line no-console
  console.log(`[${stamp}] ${tag} ${entry.message}`);

  bus.emit('log', entry);
  return entry;
}

export function getRecentLogs() {
  return recent.slice();
}

/* ---------------- 运行状态（推给 UI 的单一真相源） ---------------- */

const status = {
  // 当前交付阶段（随开发推进更新；控制台顶栏显示）
  phase: 'P4',
  ready: false,
  edge: { connected: false, launched: false, version: null },
  login: { loggedIn: false, reason: '尚未探测', url: '', title: '' },
  running: false,
  progress: { done: 0, total: 0, current: null },
  runStats: null,
  reconRunning: false,
  reconProgress: null,
  reviewCount: 0,
  settings: null,
  bootError: null,
  startedAt: Date.now(),
  // 环境信息（控制台展示用）
  root: PATHS.root,
  edgeProfile: PATHS.edgeProfile,
  debugPort: DEBUG_PORT,
  node: process.version,
  pid: process.pid,
  consoleUrl: null,
};

export function patchStatus(patch) {
  Object.assign(status, patch);
  bus.emit('status', getStatus());
  return status;
}

export function getStatus() {
  // 待审计数从 state 实时取（避免各处手动维护导致数字对不上）。
  // state.mjs 不依赖 logbus.mjs，所以静态导入无循环依赖风险。
  let reviewCount = status.reviewCount;
  try {
    reviewCount = listReviewItems().length;
  } catch {
    /* 读取失败就用缓存值 */
  }
  return { ...status, reviewCount };
}

