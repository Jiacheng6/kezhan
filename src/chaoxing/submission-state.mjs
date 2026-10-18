// Check only platform result UI; a missing submit button by itself is not proof.
export async function submissionState(frame) {
  return frame.evaluate(()=>{
    const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
    const body=document.body?.innerText||'';
    const submit=[...document.querySelectorAll('.btnSubmit, .workBtnIndex')].some(e=>visible(e)&&(e.matches('.btnSubmit')||/提交|交卷/.test(e.innerText||e.value||'')));
    const result=/提交成功|已提交|测评结果|本次成绩\s*[\d.]+\s*分|老师正在批阅|待批阅|已完成本次作业|作业已完成/.test(body);
    const receipt=[...document.querySelectorAll('#submitBackOk')].some(visible);
    const score=body.match(/本次成绩\s*([\d.]+)\s*分|得分[:：]?\s*([\d.]+)/);
    return {submitted:(!submit&&result)||receipt,confirmation:receipt,score:score?.[1]||score?.[2]||null};
  });
}

export async function pageSubmissionState(page,preferred) {
  const frames=[preferred,...page.frames()].filter((f,i,a)=>f&&a.indexOf(f)===i);
  for(const frame of frames){
    // The parent can hold a confirmation, but generic text on a course page
    // must never certify an unrelated work. Result pages and the original work only.
    if(frame!==preferred&&!/\/work\/|doHomeWork|workAnswer|workView/.test(frame.url()))continue;
    const result=await submissionState(frame).catch(()=>null);
    if(result?.submitted)return {...result,frame};
  }
  return {submitted:false};
}
