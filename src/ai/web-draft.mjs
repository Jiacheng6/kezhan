import fs from 'node:fs';import {createHash} from 'node:crypto';
import {loadState,mutateState} from '../state.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const promptHash=prompt=>hash(prompt);
export function draftKey(provider,taskKey,question){const id=question?.questionId;return provider==='doubao'&&taskKey&&id?hash(JSON.stringify([provider,taskKey,String(id),question.qtype,question.stemTextRaw,(question.options||[]).map(o=>[o.letter,o.optionId,o.text])])):'';}
export function readWebDraft(key,prompt,pageUrl){
 if(!key)return null;const item=loadState().aiWebDrafts?.[key];
 if(!item||item.promptHash!==promptHash(prompt))return null;
 // Sending a first message may push a new conversation path before its receipt
 // arrives. That navigation must not turn an uncertain send into a new send.
 try{if(item.phase==='prepared'?item.pageUrl!==pageUrl:new URL(item.pageUrl).origin!==new URL(pageUrl).origin)return null;}catch{return null;}
 try{if(hash(fs.readFileSync(item.imagePath))!==item.imageHash)return null;}catch{return null;}
 return item;
}
export function saveWebDraft(key,data){if(!key)return;mutateState(s=>{s.aiWebDrafts||={};s.aiWebDrafts[key]={...s.aiWebDrafts[key],...data,at:new Date().toISOString()};});}
export function createWebDraft(key,{prompt,basePrompt,pageUrl,imagePath}){saveWebDraft(key,{prompt,promptHash:promptHash(basePrompt),pageUrl,imagePath,imageHash:hash(fs.readFileSync(imagePath)),phase:'prepared'});}
export function clearWebDraft(key){if(key)mutateState(s=>{if(s.aiWebDrafts)delete s.aiWebDrafts[key];});}

// A process restart opens the provider homepage. Sent work belongs to the
// original conversation, never whichever empty chat happens to be open now.
export function savedWebConversation(item,currentUrl){
 if(!item||item.phase==='prepared')return '';
 try{
  const saved=new URL(item.pageUrl),current=new URL(currentUrl);
  if(saved.protocol!=='https:'||!['www.doubao.com','doubao.com'].includes(saved.hostname)||saved.origin!==current.origin||!/^\/chat\/\d+\/?$/.test(saved.pathname)||saved.search||saved.hash)return '';
  return saved.pathname.replace(/\/$/,'')===current.pathname.replace(/\/$/,'')?'':saved.href;
 }catch{return '';}
}
