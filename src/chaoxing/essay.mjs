import { normalizeEssayText, MAX_ESSAY_LENGTH } from '../ai/parse.mjs';
import { throwIfStopped } from '../control.mjs';

// 运行在题目所在 frame。全部定位限定在一道题内，避免误写相邻题的编辑器。
function editorAction({ domIndex, text, write, overwrite }) {
  const q = document.querySelectorAll('.TiMu, [class*="TiMu"]')[domIndex];
  if (!q) return { ok: false, error: '找不到对应的简答题' };
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/[\u0000\u200b\ufeff]/g, '').trim();
  const equal = (a, b) => normalize(a).replace(/\s+/g, ' ') === normalize(b).replace(/\s+/g, ' ');
  const htmlText = (html) => {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    doc.querySelectorAll('script,style').forEach((node) => node.remove());
    doc.querySelectorAll('br').forEach((node) => {
      // 空段落 <p><br></p> 的换行由段落本身提供，避免回读多一个空行。
      const parent = node.parentElement;
      if (/^(P|DIV|LI)$/.test(parent?.tagName || '') && parent.childNodes.length === 1) node.remove();
      else node.replaceWith(doc.createTextNode('\n'));
    });
    doc.querySelectorAll('p,div,li').forEach((node) => node.appendChild(doc.createTextNode('\n')));
    return normalize(doc.body.textContent);
  };
  const areas = Array.from(q.querySelectorAll('textarea[name^="answerEditor"], input[name^="answerEditor"]'));
  if (areas.length > 1) return { ok: false, error: '一道题有多个答案存储区，无法安全定位' };
  const storage = areas[0] || null;
  const candidates = [];
  for (const editor of Object.values(window.UE?.instances || {})) {
    if (!(editor?.container && q.contains(editor.container)) && !(editor?.iframe && q.contains(editor.iframe))) continue;
    if (editor.isReady === false) return { ok: false, error: '简答编辑器尚未就绪' };
    const body = editor.body || editor.document?.body || editor.iframe?.contentDocument?.body;
    if (body && typeof editor.setContent === 'function') candidates.push({ kind: 'ueditor', body, editor });
  }
  if (!candidates.length) {
    for (const iframe of q.querySelectorAll('iframe')) {
      try {
        const doc = iframe.contentDocument;
        if (doc?.body && (doc.body.isContentEditable || doc.designMode === 'on')) {
          candidates.push({ kind: 'iframe', body: doc.body });
        }
      } catch { /* 跨域或未就绪的 iframe 不修改 */ }
    }
    for (const body of q.querySelectorAll('[contenteditable="true"]')) {
      if (!body.parentElement?.closest('[contenteditable="true"]')) candidates.push({ kind: 'contenteditable', body });
    }
    for (const area of q.querySelectorAll('textarea')) {
      const style = getComputedStyle(area);
      if (!area.hidden && style.display !== 'none' && style.visibility !== 'hidden' && area.getClientRects().length) candidates.push({ kind: 'textarea', area });
    }
  }
  if (candidates.length !== 1) return { ok: false, error: candidates.length ? '发现多个简答输入区，无法安全定位' : '未找到可填写的简答编辑器' };
  const target = candidates[0];
  if (target.area?.readOnly || target.area?.disabled || target.editor?.disabled === true || target.body?.getAttribute('contenteditable') === 'false') {
    return { ok: false, error: '简答编辑器不可编辑' };
  }
  const read = () => {
    const visibleText = target.area ? normalize(target.area.value) : htmlText(target.body.innerHTML);
    const storedText = storage ? (target.kind === 'textarea' && storage === target.area ? normalize(storage.value) : htmlText(storage.value)) : visibleText;
    return { visibleText, storedText };
  };
  const before = read();
  if (!write) return { ok: true, kind: target.kind, ...before, hasStorage: !!storage };
  if (!overwrite && ((before.visibleText && !equal(before.visibleText, text)) || (before.storedText && !equal(before.storedText, text)))) {
    return { ok: false, error: '已有答案，未覆盖；请在待审队列核对后选择保存并填入', code: 'existing-answer', kind: target.kind };
  }
  // AI 文本作为纯文本处理，禁止把返回的 HTML 当成可执行内容。
  const html = text.split('\n').map((line) => {
    const paragraph = document.createElement('p');
    if (line) paragraph.textContent = line; else paragraph.appendChild(document.createElement('br'));
    return paragraph.outerHTML;
  }).join('');
  const event = (node, type) => node.dispatchEvent(new node.ownerDocument.defaultView.Event(type, { bubbles: true }));
  if (target.kind === 'textarea') {
    target.area.value = text;
    event(target.area, 'input'); event(target.area, 'change'); target.area.focus(); target.area.blur();
    if (storage && storage !== target.area) { storage.value = html; event(storage, 'input'); event(storage, 'change'); }
  } else {
    if (target.editor) target.editor.setContent(html);
    else target.body.innerHTML = html;
    event(target.body, 'input'); event(target.body, 'change');
    target.editor?.fireEvent?.('contentchange');
    target.body.focus(); target.body.blur();
    target.editor?.fireEvent?.('blur');
    if (target.editor && typeof target.editor.sync === 'function') target.editor.sync();
    else if (storage) { storage.value = html; event(storage, 'input'); event(storage, 'change'); }
  }
  const back = read();
  if (!equal(back.visibleText, text) || !equal(back.storedText, text)) return { ok: false, error: '简答正文与表单存储值回读不一致，请人工检查', kind: target.kind };
  return { ok: true, verified: true, kind: target.kind, text: back.visibleText, chars: text.length, hasStorage: !!storage };
}

export async function readEssayAnswer(workFrame, domIndex) {
  return workFrame.evaluate(editorAction, { domIndex, write: false });
}

export async function fillEssayAnswer(workFrame, domIndex, value, { overwrite = false, shouldStop } = {}) {
  throwIfStopped(shouldStop);
  const text = normalizeEssayText(value);
  if (!text || text.length > MAX_ESSAY_LENGTH) return { ok: false, error: `简答正文须为 1～${MAX_ESSAY_LENGTH} 字符` };
  const result = await workFrame.evaluate(editorAction, { domIndex, text, write: true, overwrite });
  throwIfStopped(shouldStop);
  if (!result.ok) return result;
  // 再回读一次，抓编辑器事件随后将内容覆盖/清空的情况。
  const back = await readEssayAnswer(workFrame, domIndex);
  const equal = (a, b) => normalizeEssayText(a).replace(/\s+/g, ' ') === normalizeEssayText(b).replace(/\s+/g, ' ');
  if (!back.ok || !equal(back.visibleText, text) || !equal(back.storedText, text)) return { ok: false, error: '简答草稿填写后回读校验失败' };
  return result;
}
