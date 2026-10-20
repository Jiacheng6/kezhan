const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Windows renders native toasts in the system style. In-app reminders use the
// shared application dialog; both surfaces carry the same copy and action.
const catalog = {
  'ai-verification': ['AI 需要人工验证', '当前题目已暂停。请在软件内 AI 网页完成验证，再点击“验证已完成，继续本题”。', 'ai', true],
  'ai-login': ['AI 登录已失效', '本批次已暂停，题目已保留。请在软件内 AI 网页登录后重新开始。', 'ai', true],
  'ai-limited': ['AI 暂时无法继续', '已暂停任务并保留题目。请查看 AI 网页的额度或使用限制，稍后重新开始。', 'ai', true],
  'ai-draft': ['AI 网页有待处理内容', '已有草稿或附件，已暂停任务，避免混入下一题。请在软件内查看后重新开始。', 'ai', true],
  'ai-busy': ['AI 仍在回答', '本批次已暂停，题目已保留。请等待当前回答结束后重新开始。', 'ai', true],
  'login-required': ['需要登录学习通', '学习通未登录或登录已失效，请在软件内完成登录并重新检测。', 'login', true],
  'zhihuishu-login': ['需要登录智慧树', '智慧树测验登录已失效，请在保留的软件内网页重新登录后继续。', 'zhihuishu', true],
  'task-attention': ['学习已暂停，需要你处理', '当前任务尚未完成，页面与题目已尽可能保留。请查看待审答案和运行记录。', 'review', true],
  'task-failed': ['有任务未能完成', '尝试后仍未成功，已记录到待人工清单。请查看运行记录，不计为已完成。', 'logs', true],
  'batch-paused': ['本批学习已暂停', '遇到连续失败，任务尚未全部完成。请检查运行记录后再继续。', 'logs', true],
  'batch-error': ['学习任务异常中断', '本批未能正常结束，已有进度已尽可能保留。请查看运行记录。', 'logs', true],
  'review-ready': ['有答案需要你确认', '答案已保存到待审列表，尚未提交。请核对后决定是否提交。', 'review', false],
  'batch-review': ['本批处理结束，仍有待处理任务', '待审或未完成的任务不计为完成。请查看待审答案及运行记录。', 'review', false],
  'batch-complete': ['本批学习已完成', '本批可执行任务已处理完成，可回到软件查看结果。', 'courses', false],
  'batch-stopped': ['学习已停止', '已按你的要求停止，当前进度保留，可稍后继续。', 'courses', false],
  'scan-complete': ['课程扫描已完成', '课程清单已更新，可以选择本次学习范围。', 'courses', false],
  'scan-failed': ['课程扫描未完成', '本次未能读取完整课程清单。请查看运行记录后重试。', 'logs', true],
  'scan-stopped': ['课程扫描已停止', '原有课程清单保留，可以稍后重新扫描。', 'courses', false],
  'submit-success': ['答案已确认提交', '平台已确认提交结果，可以在待审答案中查看。', 'review', false],
  'submit-failed': ['答案提交未完成', '未确认平台提交成功，待审记录已保留。请打开页面核对，避免重复提交。', 'review', true],
  'service-error': ['软件服务异常', '任务可能已中断，请打开软件查看。已有进度已尽可能保留。', 'logs', true],
  'update-available': ['发现软件更新', '新版已可下载。打开软件查看更新内容并决定是否安装。', 'updates', false],
  'update-ready': ['新版已下载完成', '安装包已通过校验。打开软件后可选择保存进度并安装。', 'updates', false],
  'update-error': ['软件更新未完成', '下载、校验或安装准备失败，当前版本仍可使用。请打开更新面板查看。', 'updates', true],
};

class NotificationCenter {
  constructor({ dataDir, Notification, icon, onState = () => {}, onOpen = () => {}, onAttention = () => {}, log = () => {}, nativeEnabled = true }) {
    Object.assign(this, { Notification, icon, onState, onOpen, onAttention, log, nativeEnabled });
    this.file = path.join(dataDir, 'notifications.json'); this.items = []; this.live = new Map(); this.saveError = false;
    try {
      if (fs.existsSync(this.file)) this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')).filter(n => catalog[n.kind] && typeof n.id === 'string').slice(0, 100);
    } catch { this.log('通知历史无法读取，保留原文件'); this.saveError = true; }
  }
  snapshot() {
    return { items: this.items.map(n => ({...n})), unread: this.items.filter(n => !n.read).length,
      nativeSupported: this.nativeEnabled && !!this.Notification.isSupported(), saveError: this.saveError };
  }
  publish() { this.onState(this.snapshot()); }
  save() {
    try {
      const temp = this.file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(this.items)); fs.renameSync(temp, this.file); this.saveError = false;
    } catch { this.saveError = true; this.log('通知历史保存失败，当前提醒仍保留在软件中'); }
    this.publish();
  }
  push({ kind, key = kind, detail = '', provider = null } = {}) {
    const spec = catalog[kind]; if (!spec) return null;
    key = String(key).slice(0, 240);
    // Repeated polling/status changes must never generate a toast storm.
    const prior = this.items.find(n => n.key === key && n.kind === kind && !n.read);
    if (prior) return {...prior};
    const [title, body, action, urgent] = spec;
    const item = { id:crypto.randomUUID(),kind,key,title,body,action,urgent,provider:['qianwen','doubao','deepseek'].includes(provider)?provider:null,detail:String(detail).slice(0,600),at:Date.now(),read:false,delivery:'in-app' };
    this.items.unshift(item);
    for (const old of this.items.splice(100)) { this.live.get(old.id)?.close(); this.live.delete(old.id); }
    if (this.nativeEnabled && this.Notification.isSupported()) {
      try {
        const toast = new this.Notification({title,body,icon:this.icon,silent:false,timeoutType:urgent?'never':'default'});
        this.live.set(item.id, toast);
        toast.on('click', () => this.activate(item.id));
        toast.on('close', () => this.live.delete(item.id));
        toast.on('failed', () => { item.delivery='failed';this.live.delete(item.id);this.save();this.onAttention(item); });
        toast.show(); item.delivery='requested';
      } catch { item.delivery='failed'; }
    }
    this.save(); this.onAttention(item); return {...item};
  }
  read(id) {
    const item = this.items.find(n => n.id === id); if (!item) return false;
    item.read = true; this.live.get(id)?.close(); this.live.delete(id); this.save(); return true;
  }
  activate(id) {
    const item = this.items.find(n => n.id === id); if (!item) return false;
    this.read(id); this.onOpen({...item}); return true;
  }
}
module.exports = { NotificationCenter, catalog };
