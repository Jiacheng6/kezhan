// Observe the public chat DOM before sending. Virtual lists may unmount the
// question before a polling reader sees the reply, so retain a verified link.
import {observeDoubaoReceipt} from './doubao-receipt.mjs';
const receipts=new WeakMap();
export const webRequestMarker = prompt => /本次提问标记：([0-9a-f-]{36})。标记仅用于区分本次提问，答案中不要重复标记。$/.exec(prompt)?.[1] || '';

export async function beginWebTurn(page, provider, prompt, {resume=false}={}) {
  const marker = provider.id === 'doubao' ? webRequestMarker(prompt) : '';
  if (!marker) return '';
  receipts.get(page)?.dispose();
  await page.evaluate(({marker,resume}) => {
    const symbol = Symbol.for('xxt.web-chat-turn');
    globalThis[symbol]?.observer.disconnect();
    const root = node => node?.closest('[data-testid="union_message"]') || node;
    const messageId = node => node?.closest('[data-message-id]')?.getAttribute('data-message-id')
      || root(node)?.querySelector('[data-message-id]')?.getAttribute('data-message-id') || '';
    const answers = scope => {
      const nodes = [...scope.querySelectorAll('[data-testid="receive_message"] [data-testid="message_text_content"]')];
      return nodes.filter(node => !nodes.some(other => other !== node && node.contains(other)));
    };
    const before = (a, b) => {const position=root(a).compareDocumentPosition(root(b));return !(position&Node.DOCUMENT_POSITION_DISCONNECTED)&&!!(position&Node.DOCUMENT_POSITION_FOLLOWING);};
    const knownAnswers = new Set(resume?[]:answers(document).map(messageId).filter(Boolean));
    const turn = {marker, observed: false, answerId: '', answerNode: null, invalidated: false, receipt: false};
    const scan = scope => {
      const users = [...scope.querySelectorAll('[data-testid="send_message"]')].filter(node => (node.textContent || '').trim());
      const user = users.findLast(node => (node.textContent || '').includes(marker));
      if (!user) return;
      turn.observed = true;
      const laterUsers = users.filter(node => before(user, node));
      if (laterUsers.length) {turn.invalidated = true;turn.invalidatedReason='later-user'; return;}
      const answer = answers(scope).find(node => before(user, node));
      if (!answer) return;
      const id = messageId(answer);
      if (id && knownAnswers.has(id)) return;
      if (id && turn.answerId && id !== turn.answerId) {turn.invalidated = true;turn.invalidatedReason='answer-id-changed'; return;}
      turn.answerId = id;
      turn.answerNode = answer;
    };
    turn.read = () => {
      scan(document);
      const answer = turn.answerId ? answers(document).find(node => messageId(node) === turn.answerId)
        : turn.answerNode?.isConnected && [...document.querySelectorAll('[data-testid="send_message"]')].some(node => (node.textContent || '').includes(marker)) ? turn.answerNode : null;
      if (answer && [...document.querySelectorAll('[data-testid="send_message"]')].some(node => (node.textContent || '').trim() && before(answer, node))) {turn.invalidated = true;turn.invalidatedReason='user-after-answer';}
      return {marker, observed: turn.observed, answer: turn.invalidated ? null : answer, answerId: turn.answerId, invalidated: turn.invalidated, invalidatedReason:turn.invalidatedReason||'', receipt: turn.receipt};
    };
    turn.observer = new MutationObserver(records => {
      // A virtual-list replacement can remove the question and reply together.
      // Read their original order in that detached subtree before it is lost.
      for (const record of records) for (const node of record.removedNodes) if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      scan(document);
    });
    globalThis[symbol] = turn;
    turn.observer.observe(document, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-message-id']});
  }, {marker,resume});
  const dispose=observeDoubaoReceipt(page,marker,
    ({answerId})=>page.evaluate(({marker,answerId})=>{
      const turn=globalThis[Symbol.for('xxt.web-chat-turn')];
      if(turn?.marker!==marker||turn.invalidated)return;
      if(turn.answerId&&turn.answerId!==answerId){turn.invalidated=true;turn.invalidatedReason='receipt-id-changed';return;}
      turn.observed=true;turn.receipt=true;turn.answerId=answerId;
    },{marker,answerId}),
    ()=>page.evaluate(marker=>{const turn=globalThis[Symbol.for('xxt.web-chat-turn')];if(turn?.marker===marker){turn.invalidated=true;turn.invalidatedReason='superseded-request';}},marker));
  receipts.set(page,{marker,dispose});
  return marker;
}

export async function endWebTurn(page, marker) {
  if (!marker) return;
  const receipt=receipts.get(page);
  if(receipt?.marker===marker){receipt.dispose();receipts.delete(page);}
  await page.evaluate(marker => {
    const symbol = Symbol.for('xxt.web-chat-turn'), turn = globalThis[symbol];
    if (turn?.marker === marker) {turn.observer.disconnect(); delete globalThis[symbol];}
  }, marker);
}
