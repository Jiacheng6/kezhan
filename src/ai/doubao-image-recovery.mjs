import {createHash} from 'node:crypto';
import {throwIfStopped} from '../control.mjs';

// Old checkpoints may have sent an image-only turn. Read only that existing
// image, never infer ownership from the last answer's text or its position alone.
export function readDoubaoImageCandidate(){
 const root=e=>e?.closest('[data-testid="union_message"]')||e;
 const id=e=>e?.closest('[data-message-id]')?.getAttribute('data-message-id')||e?.querySelector('[data-message-id]')?.getAttribute('data-message-id')||root(e)?.querySelector('[data-message-id]')?.getAttribute('data-message-id')||'';
 const users=[...document.querySelectorAll('[data-testid="send_message"]')].filter(e=>(e.textContent||'').trim()||e.querySelector('img'));
 const user=users.at(-1);if(!user)return null;
 const images=[...user.querySelectorAll('img')].map(e=>e.currentSrc||e.src).filter(src=>/^https:\/\//.test(src));
 if(images.length!==1)return null;
 const nodes=[...document.querySelectorAll('[data-testid="receive_message"] [data-testid="message_text_content"]')];
 const answers=nodes.filter(e=>!nodes.some(n=>n!==e&&e.contains(n))).filter(e=>{const order=root(user).compareDocumentPosition(root(e));return !(order&Node.DOCUMENT_POSITION_DISCONNECTED)&&!!(order&Node.DOCUMENT_POSITION_FOLLOWING);});
 if(answers.length!==1||!id(user)||!id(answers[0]))return null;
 return {url:location.href,src:images[0],userId:id(user),answerId:id(answers[0])};
}
async function readPublicImage(url){
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000)});
 if(!response.ok||!/^image\//i.test(response.headers.get('content-type')||''))return null;
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4*1024*1024){await reader.cancel();return null;}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
 return Buffer.concat(chunks);
}
export async function recoverDoubaoImageTurn(page,draft,{shouldStop,readImage=readPublicImage}={}){
 if(!draft?.imageHash||draft.phase==='prepared')return false;
 throwIfStopped(shouldStop);
 const candidate=await page.evaluate(readDoubaoImageCandidate);if(!candidate)return false;
 try{
  const saved=new URL(draft.pageUrl),current=new URL(candidate.url),image=new URL(candidate.src);
  if(saved.href!==current.href||saved.protocol!=='https:'||!['www.doubao.com','doubao.com'].includes(saved.hostname)||!/^\/chat\/\d+\/?$/.test(saved.pathname))return false;
  if(image.protocol!=='https:'||!image.hostname.endsWith('.byteimg.com')||image.username||image.password||image.port)return false;
  const bytes=await readImage(image.href);throwIfStopped(shouldStop);
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==draft.imageHash)return false;
  // Recheck after the asynchronous download so a new user turn or navigation
  // cannot bind an old image's answer to the current question.
  const latest=await page.evaluate(readDoubaoImageCandidate);
  if(JSON.stringify(latest)!==JSON.stringify(candidate))return false;
  return await page.evaluate(candidate=>{
   const turn=globalThis[Symbol.for('xxt.web-chat-turn')];if(!turn||turn.invalidated)return false;
   if(turn.answerId&&turn.answerId!==candidate.answerId)return false;
   turn.observed=true;turn.answerId=candidate.answerId;return true;
  },candidate);
 }catch(error){if(error.code==='STOPPED')throw error;return false;}
}
