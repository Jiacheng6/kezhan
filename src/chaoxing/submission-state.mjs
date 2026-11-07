export const WORK_SUBMIT_SELECTOR = '.btnSubmit, a.workBtnIndex[onclick^="validateTime("]';

export function workIdentity(url) {
  try {
    const identity = {};
    for (const [key,value] of new URL(url).searchParams) {
      const name = key.toLowerCase();
      if (!/^(workid|workanswerid)$/.test(name)) continue;
      if (!/^[\w-]{1,120}$/.test(value) || name in identity && identity[name] !== value) return {};
      identity[name] = value;
    }
    return identity;
  } catch { return {}; }
}

export async function frameWorkIdentity(frame) {
  const url = frame.url();
  const identity = workIdentity(url);
  if (identity.workid && identity.workanswerid) return identity;
  const fields = await frame.evaluate(() => {
    const result = {};
    for (const input of document.querySelectorAll('input[type="hidden"]')) {
      const name = (input.name || input.id).toLowerCase();
      if (!/^(workid|workanswerid)$/.test(name) || !/^[\w-]{1,120}$/.test(input.value)) continue;
      if (name in result && result[name] !== input.value) return {};
      result[name] = input.value;
    }
    return result;
  }).catch(() => ({}));
  if (url !== frame.url() || Object.entries(fields).some(([name,value]) => identity[name] && identity[name] !== value)) return {};
  return {...identity,...fields};
}

// Check only platform result UI; a missing submit button by itself is not proof.
export async function submissionState(frame) {
  return frame.evaluate(selector=>{
    const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
    const body=document.body?.innerText||'';
    const submit=[...document.querySelectorAll(selector)].some(visible);
    // Questions and answers can themselves contain words such as “已提交”.
    const hasQuestions = !!document.querySelector('.TiMu,.newTiMu,.questionLi');
    const resultPage = /\/(?:viewWork|workView|workAnswer|selectWorkQuestionYiPiYue)(?:[/?]|$)/i.test(location.pathname);
    // Reviewed work pages retain all question blocks. Read the result summary
    // outside those blocks, so answer text cannot masquerade as a receipt.
    let summary = body;
    if (resultPage) {
      const resultBody = document.body.cloneNode(true);
      for (const node of resultBody.querySelectorAll('.TiMu,.newTiMu,.questionLi,script,style')) node.remove();
      summary = resultBody.textContent || '';
    }
    const result=/提交成功|已提交|测评结果|本次成绩\s*[:：]?\s*[\d.]+\s*分|老师正在批阅|待批阅|已完成本次作业|作业已完成/.test(summary);
    const receipt=[...document.querySelectorAll('#submitBackOk')].some(visible);
    const score=summary.match(/本次成绩\s*[:：]?\s*([\d.]+)\s*分|得分\s*[:：]?\s*([\d.]+)/);
    return {submitted:(!submit&&result&&(!hasQuestions||resultPage))||receipt,confirmation:receipt,score:score?.[1]||score?.[2]||null};
  },WORK_SUBMIT_SELECTOR);
}

export async function pageSubmissionState(page,preferred,{expected}={}) {
  const frames=[preferred,...page.frames()].filter((f,i,a)=>f&&a.indexOf(f)===i);
  for(const frame of frames){
    // The parent can hold a confirmation, but generic text on a course page
    // must never certify an unrelated work. Result pages and the original work only.
    if(frame!==preferred&&!/\/work\/|doHomeWork|workAnswer|workView/.test(frame.url()))continue;
    if(expected){
      const params = await frameWorkIdentity(frame);
      if(!expected.workid||!expected.workanswerid||params.workid!==expected.workid||params.workanswerid!==expected.workanswerid)continue;
    }
    const result=await submissionState(frame).catch(()=>null);
    if(result?.submitted)return {...result,frame};
  }
  return {submitted:false};
}
