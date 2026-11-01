/**
 * 输入区自清理（AI 网页）——把"重试前先擦干净"这件事做成一次可复用操作。
 *
 * 背景：旧逻辑在 `web-chat.mjs` 里检测到输入区已有附件/草稿时**直接拒绝**：
 *   ⛔ 豆包输入区已有附件，请先处理原草稿，避免混入其他题目
 * 于是同一道题重试 3 次全都撞同一堵墙，最后转「待人工」并可能触发全局暂停；
 * 用户手动处理掉之后立刻恢复 —— 这正是"重试不管用、手动做完又好了"的成因。
 *
 * 现在的策略（判定在 session-policy.mjs 的 planComposerReset）：
 *   · 残留的是**我们上一轮的附件/提问文本** → 自动清掉，继续发送；
 *   · 输入框里是**用户自己敲的内容** → 仍然拒绝（不覆盖用户的东西）。
 */
import { log } from '../logbus.mjs';

/** 附件「删除/移除」按钮的通用特征（三个站点结构不同，按语义找） */
const REMOVE_RE = /删除|移除|移除附件|清空|close|remove|delete|×|✕/i;

/**
 * 清掉输入区里"我们自己的残留"。
 *
 * @param {import('playwright-core').Page} page
 * @param {object} ui WEB_UI[provider.id]
 * @param {object} opts
 * @param {(page:any, ui:any)=>Promise<boolean>} opts.hasAttachment 复查是否还有附件（由调用方注入，避免重复实现）
 * @param {boolean} [opts.clearAttachment]
 * @param {boolean} [opts.clearEditor]
 * @returns {Promise<{ok:boolean, removed:number, clearedEditor:boolean, reason:string}>}
 */
export async function clearComposerResidue(page, ui, { hasAttachment, clearAttachment = false, clearEditor = false } = {}) {
  let removed = 0;
  let clearedEditor = false;

  const composer = page.locator(ui.composer).filter({ visible: true }).first();

  if (clearAttachment) {
    // 最多点 6 次：有的站点一个附件一个 ×，也有把整条 chip 一起清掉的
    for (let i = 0; i < 6; i += 1) {
      const clicked = await page
        .evaluate(
          ({ composerSel, pattern }) => {
            const visible = (e) => !!e?.getClientRects().length;
            const box = [...document.querySelectorAll(composerSel)].find(visible);
            if (!box) return false;
            const rx = new RegExp(pattern, 'i');
            const candidates = [
              ...box.querySelectorAll('button,[role="button"],[class*="close"],[class*="remove"],[class*="delete"]'),
            ];
            const target = candidates.find((el) => {
              if (!visible(el)) return false;
              const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.innerText || ''} ${el.className || ''}`;
              return rx.test(label);
            });
            if (!target) return false;
            target.click();
            return true;
          },
          { composerSel: ui.composer, pattern: REMOVE_RE.source },
        )
        .catch(() => false);
      if (!clicked) break;
      removed += 1;
      await page.waitForTimeout(180);
    }
    const still = await hasAttachment(page, ui).catch(() => true);
    if (still && removed === 0) {
      return { ok: false, removed, clearedEditor, reason: '找不到可点的"删除/移除"按钮' };
    }
    if (still) {
      return { ok: false, removed, clearedEditor, reason: `点了 ${removed} 个删除按钮，附件仍在` };
    }
  }

  if (clearEditor) {
    try {
      const editor = composer.locator(ui.editor).filter({ visible: true }).first();
      await editor.click({ timeout: 2000 });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.waitForTimeout(120);
      clearedEditor = true;
    } catch (error) {
      return { ok: false, removed, clearedEditor, reason: `清空输入框失败：${String(error.message || error).slice(0, 60)}` };
    }
  }

  if (removed || clearedEditor) {
    log(`    已清理 AI 输入区残留（附件 ${removed} 个${clearedEditor ? '、提问文本' : ''}）`, 'warn');
  }
  return { ok: true, removed, clearedEditor, reason: '' };
}
