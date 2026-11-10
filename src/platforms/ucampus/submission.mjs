// A received submission and a credited learning point are separate facts.
// Read only the original native result page, never infer credit from HTTP 200.
export async function readUcampusSubmission(page,{expectedUrl,expectedQuestions}={}){
  if(!expectedUrl||page.url()!==expectedUrl)return {accepted:false,reason:'identity-changed'};
  const state=await page.evaluate(()=>{
    const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
    const answers=[...document.querySelectorAll('.analysis-item')].filter(visible).filter(e=>/^你的答案[：:]?$/.test((e.querySelector('.analysis-item-title')?.innerText||'').trim()));
    const answerCount=answers.filter(e=>(e.querySelector('.analysis-item-content')?.innerText||'').trim()).length;
    const hasSummary=[...document.querySelectorAll('#pc-foot .question-common-course-page a.btn')].some(e=>visible(e)&&(e.innerText||'').trim()==='查看答题小结');
    const editable=[...document.querySelectorAll('textarea,input[type="text"]')].some(e=>visible(e)&&!e.disabled&&!e.readOnly);
    return {answerCount,hasSummary,editable};
  });
  if(page.url()!==expectedUrl)return {accepted:false,reason:'identity-changed'};
  return {...state,accepted:state.hasSummary&&!state.editable&&state.answerCount>0&&(expectedQuestions==null||expectedQuestions===state.answerCount)};
}
