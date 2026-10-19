/**
 * 全局配置与默认值。
 * 所有可调项集中在此，UI「设置」页改动会落到 state.json 的 settings 段，
 * 读取时以 loadSettings() 的合并结果为准。
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 源码目录与用户数据分开，安装目录不需要写权限。
export const DATA_ROOT = process.env.XXT_DATA_DIR ? path.resolve(process.env.XXT_DATA_DIR) : ROOT;

export const PATHS = {
  root: ROOT,
  userData: DATA_ROOT,
  local: path.join(DATA_ROOT, 'local.json'),
  selection: path.join(DATA_ROOT, 'recon-selection.json'),
  /** 专用 Edge 配置目录（含你的学习通登录态，勿删） */
  edgeProfile: path.join(DATA_ROOT, 'edge-profile'),
  browserProfile: path.join(DATA_ROOT, 'Partitions', 'learning-web'),
  state: path.join(DATA_ROOT, 'state.json'),
  logs: path.join(DATA_ROOT, 'logs'),
  answers: path.join(DATA_ROOT, 'logs', 'answers'),
  ui: path.join(ROOT, 'src', 'ui'),
  /**
   * 运行产物目录（侦察报告、调试快照）。
   * 以前它藏在 tools/probe-out —— 「数据」混在「工具」里，容易误删也不好找；
   * 现在统一放 data/ 下，路径由这里唯一决定。
   */
  data: path.join(DATA_ROOT, 'data'),
  probeOut: path.join(DATA_ROOT, 'data', 'probe-out'),
  /** 执行清单读的那份报告（侦察完成后写在这里） */
  taskReport: path.join(DATA_ROOT, 'data', 'probe-out', 'task-report.json'),
  tmp: path.join(os.tmpdir(), 'xuexitong-auto'),
};

/** Edge 调试端口：被脚本接管的关键 */
export const DEBUG_PORT = Number(process.env.XXT_DEBUG_PORT || 9222);
if (!Number.isInteger(DEBUG_PORT) || DEBUG_PORT < 1 || DEBUG_PORT > 65535) {
  throw new Error('浏览器调试端口无效');
}

/**
 * 本机个人标识（学习通账号内部 ID，即 URL 里的 `cpi=`）。
 *
 * 为什么从文件读而不是写死在代码里：它是**账号标识**，写死在源码里会随仓库上传
 * （.gitignore 再全也挡不住源码里的字面量）。现在存 `local.json`（已被忽略）。
 *
 * 使用者**不需要手填**：启动后登录学习通，程序会自动从页面里识别出来并写入
 * `local.json`（见 `src/chaoxing/identity.mjs`）。手填只在自动识别失败时才需要。
 */
let LOCAL = {};
try {
  LOCAL = JSON.parse(fs.readFileSync(PATHS.local, 'utf8'));
} catch {
  /* 没有 local.json：首次运行会自动识别并创建 */
}
/** 学习通账号内部 ID；空字符串表示"还没识别到" */
export let PERSON_ID = String(LOCAL.personId || '');

/**
 * 更新（并可选持久化）账号 ID。
 *
 * 用 `export let` + setter 而不是常量：ESM 的实时绑定让所有 `import { PERSON_ID }`
 * 的地方都能看到新值，不必到处传参。
 *
 * @param {string} id
 * @param {{persist?: boolean, file?: string}} [opts] persist=true 时写入 local.json
 */
export function setPersonId(id, { persist = true, file = null } = {}) {
  const v = String(id || '').trim();
  PERSON_ID = v;
  if (!persist) return v;

  const target = file || PATHS.local;
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    /* 文件不存在或坏了：重建 */
  }
  const next = {
    _说明:
      cur._说明 ||
      '本机个人配置（已被 .gitignore 忽略，不会上传）。personId 由程序在登录学习通后自动识别写入，正常无需手改。',
    ...cur,
    personId: v,
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return v;
}

/** local.json 的原始内容（预留：以后其它本机配置也放这里） */
export const LOCAL_CONFIG = LOCAL;

/** 控制台起点端口，占用则自动 +1 探测 */
export const CONSOLE_PORT_START = 8787;
export const CONSOLE_PORT_MAX_TRIES = 12;

export const TARGETS = {
  /** 学习通个人空间首页（登录落点） */
  chaoxingHome: 'https://i.chaoxing.com/',
  /** 课程列表 */
  courseSpace: 'https://i.mooc.chaoxing.com/space/index',
  /** 千问网页版 */
  qianwen: 'https://www.tongyi.com/',
};
// Full desktop integration tests can use a local synthetic website. A packaged
// normal launch never sets this flag; arbitrary remote overrides are rejected.
if (process.env.XXT_EMBEDDED_TEST === '1' && process.env.XXT_EMBEDDED_TEST_HOME) {
  const testHome = new URL(process.env.XXT_EMBEDDED_TEST_HOME);
  if (testHome.protocol !== 'http:' || testHome.hostname !== '127.0.0.1') throw new Error('内置网页测试仅允许本机地址');
  TARGETS.chaoxingHome = testHome.href;
}

/**
 * 拉起 Edge 时必须带的参数。
 * 其中四条 disable-* 是「后台不被节流」的地基 —— 正因为要带这些参数，
 * 才必须用专用 Profile 另起实例（运行中的 Edge 无法追加启动参数）。
 */
export const EDGE_FLAGS = [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PATHS.edgeProfile}`,
  '--no-first-run',
  '--no-default-browser-check',
  // ↓ 关掉账号同步：否则全新专用 Profile 一启动就弹「同步你的浏览数据」对话框挡路。
  //   注意：这只影响专用 Profile，不影响你日常那个 Edge。
  '--disable-sync',
  '--disable-features=msEdgeSyncPromo,Translate,OptimizationHints',
  // ↓ 抑制「设为默认浏览器」「首次运行」等推广弹窗
  '--no-service-autorun',
  '--disable-search-engine-choice-screen',
  '--disable-component-update',
  '--disable-edge-sync-promo',
  '--hide-crash-restore-bubble',
  // ↓ 恢复上次会话：学习通多数登录 Cookie 是"会话级"，靠这条让 Edge
  //   重启后重新加载上次的标签页，登录态才不会随关闭丢失。
  '--restore-last-session',
  // ↓ 反节流：窗口被遮挡 / 后台时不降频、不停 timer，视频才不会被挂起
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-background-media-suspend',
  // ↓ 允许无手势自动播放
  '--autoplay-policy=no-user-gesture-required',
  // ↓ 挂机减少内存压力
  '--disable-dev-shm-usage',
];

export const DEFAULT_SETTINGS = {
  /** 遇题策略：'defer' = 暂存继续播（默认） | 'pause' = 暂停等我 */
  quizPolicy: 'defer',
  /** 提交模式：'manual' = 人工确认（默认） | 'auto' = 高可靠答案自动提交 */
  submitMode: 'manual',
  essayAutoFill: true,
  discussionDrafts: false,
  essayPrompt: '请阅读截图中的简答题，按题意给出完整、直接可填写的答案。只输出答题正文，可分段或编号；不要重复题干、不要输出选项字母、不要写思考过程或附加说明。图片看不清或信息不足时请明确说明，不要猜测。',
  /**
   * 是否处理课程章节里的「章节测验」。
   * 用户第 9 问确认：章节测验要做（截图问千问 → 确认 → 提交）。
   */
  quizModule: true,
  /**
   * 是否处理独立的「作业」列表（/work/）。
   * 用户第 9 问确认：默认关闭，因为作业通常只有 1 次提交机会。
   */
  homeworkModule: false,
  /** 问千问时使用的提问词 */
  quizPrompt:
    '请给出这道题的答案。只回答答案本身，不要解释：选择题回答选项字母（多选题形如 AB），判断题回答「对」或「错」。',

  /**
   * 千问提问节流与退避（踩过风控才加的）。
   *
   * 实测教训：一小时内连续几十次自动化提问会触发阿里 baxia 风控，
   * 要求人工滑块验证，此时页面永远停在"接收中"，整条答题链路就断了。
   * 所以必须限速。
   */
  ai: {
    /** 手动选择网页版通道，不自动转发到其他平台。 */
    provider: 'qianwen',
    /** 两次提问之间的最小间隔（毫秒）。默认 45 秒 —— 慢，但不容易被风控 */
    minIntervalMs: 45000,
    /** 每次提问后额外随机抖动上限（毫秒），避免固定节奏像机器 */
    jitterMs: 15000,
    /**
     * 千问没给出回答时，重新提问几次。
     *
     * 用户实测反馈："千问卡了，此时若没回答应该重新提问，而不是卡着"。
     * 早期每次提问只试一遍、干等满 4 分钟才失败，一条题就这么变成"待人工"。
     */
    askRetries: 2,
    /** 多久没有任何进展（不吐字、也不在生成中）就判定"卡住"并重新提问（毫秒） */
    answerStuckMs: 60000,
    /** 单次提问最多等多久（毫秒）；正常生成中会一直等到这个上限 */
    answerTimeoutMs: 240000,
    /** 是否每道题都新建对话。复用同一对话更像真人，也少一次页面动作 */
    freshChatPerQuestion: false,
    /** 出现"卡在生成中"时的冷却时间（毫秒），冷却期内不再提问 */
    stuckCooldownMs: 300000,
    /** 连续失败多少次就暂停整个答题流程 */
    consecutiveFailLimit: 2,
  },
  /** 单个任务点失败重试上限 */
  maxRetries: 3,
  /**
   * 小节最多探几张"卡片"。
   *
   * 实测：小节是分卡片的，num=0 常常只是「学习目标」纯文本卡，
   * 真正的视频任务点在 num=1（示例课程甲 1.1 就是这样）。
   * 一律按 num=0 读，会把这些小节误判成"没有任务点"。
   */
  maxCardProbe: 6,
  /**
   * 是否监听 cards 页的老式弹窗（showCustomPop/.customMaskDiv）。
   *
   * 实测结论：视频弹窗题**不走**这条路径（钩子记录为 null），
   * 真正的弹窗在视频 iframe 内的 .ans-videoquiz，由 videoquiz.mjs 处理。
   * 所以默认关掉，避免两套监听同时抢答。
   */
  cardsPopupWatch: false,
  /** 弹窗题点提交后，等站点反馈的上限（毫秒） */
  quizSubmitTimeoutMs: 20000,
  /**
   * 播放完成阈值。
   *
   * 课程完成条件不同；默认播到片尾，90% 模式会查询平台，未通过则继续。
   *   309 秒视频：playingTime=239 → isPassed:false
   *               playingTime=299 → isPassed:true
   *               currentTime 307s(99.4%) 时 aria 才变「已完成」
   *   97%(307s) 早停 → 绿点不变；必须播到 308.5s 才通过。
   *
   * 现在默认 99.9% + 距结束 1 秒双保险，宁可多播几秒也不早停。
   */
  // Courses differ: the optional 90% check still requires a platform verdict.
  playbackSpeed: '1',
  videoCompletionMode: 'full',
  progressThreshold: 0.999,
  /** 距视频结束多少秒即视为播完 */
  finishMarginSec: 1,
  /**
   * 不做任何 seek/补播。
   *
   * 学习通页面明写「未完成任务点前，当前视频不可拖拽」，
   * 程序化改 currentTime 同样被当拖拽（实测 seek 后立刻连续"被暂停"），
   * 反而破坏这条视频。而完整播放本身是有效的，不需要 seek 辅助。
   */
  allowSeek: false,
  /**
   * 播到片尾后耐心等绿点生效的时长。
   *
   * 实测绿点延迟**不稳定**：短则 11 秒，长则超过 3 分钟
   * （3.4 播完等 3 分钟仍"未生效"，事后再查早已变绿）。
   * 所以放宽到 6 分钟，避免把"其实成功了"误判为失败。
   */
  greenDotPatientMs: 360000,
  greenDotPatientStepMs: 10000,
  /** 绿点核对失败后的复核次数与等待间隔（上报有延迟） */
  greenDotRetries: 3,
  greenDotWaitMs: 8000,
  /** 文档/PPT/阅读类任务点的停留秒数（触发学习通浏览上报） */
  docDwellSec: 12,
  /** 播放声音：默认静音 */
  muted: true,
  /** 千问地址 */
  qianwenUrl: TARGETS.qianwen,
  /** 检查点落盘间隔（秒） */
  checkpointSec: 5,
  /*
   * 说明：早期这里有个 `reconOnly`（"只侦察模式"）开关。
   * 它**从来没有真正控制过任何行为** —— 只影响界面上一颗灯，
   * 而那颗灯一直亮着"只侦察模式"，让人以为脚本不会动手（实际一直在真刷）。
   * 已删除；界面改成显示"提交模式"和"答题通道"两颗说真话的灯。
   */
};

/** 启动时确保运行所需目录存在（缺了就地创建，不报错） */
export function ensureDirs() {
  for (const d of [PATHS.logs, PATHS.answers, PATHS.data, PATHS.probeOut, PATHS.tmp]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(PATHS.state, 'utf8'));
    return mergeSettings(raw.settings);
  } catch {
    return mergeSettings();
  }
}

export function mergeSettings(overrides = {}) {
  const defaults = structuredClone(DEFAULT_SETTINGS);
  const saved = overrides && typeof overrides === 'object' ? overrides : {};
  return { ...defaults, ...saved, ai: { ...defaults.ai, ...(saved.ai || {}) } };
}
