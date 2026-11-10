import {prepareLesson} from './vendor/auto-welearn/core/run/prepare.mjs';
import {fetchTemplate} from './vendor/auto-welearn/core/api/sco.mjs';
import {parseSco} from './vendor/auto-welearn/core/parse/sco-parser.mjs';
import {load} from 'cheerio';

// Positive evidence from the exact lesson template, not a blanket fallback
// for empty/failed extraction. Unknown widgets and oral tasks stay blocked.
export function isWelearnReadingTemplate(html) {
  const $=load(html);
  if ($('et-item').length!==1 || !$('et-preface .main-content').text().trim()) return false;
  const tags=new Set(['et-item','et-sub-title','et-preface','et-my-words']);
  if ($('*').toArray().some(el=>el.name?.startsWith('et-')&&!tags.has(el.name))) return false;
  return !$('input,textarea,select,video,audio,iframe,object,[data-controltype],[data-solution],[answer],[data-answer],script').length;
}
// Some legacy courses return an Angular index shell with #/unit/file instead
// of a standalone template. Resolve that shell's configured template route,
// then give the unmodified upstream parser the actual HTML.
export async function prepareWelearnLesson(session,meta,options={}){
  const prepared=await prepareLesson(session,meta,options);
  if(prepared.questions.length||!prepared.address)return prepared;
  const address=new URL(prepared.address.url),route=/^#\/(\d{1,3})\/([0-9-]{1,40})$/.exec(address.hash);
  if(!route||!/\/index\.html$/i.test(address.pathname))return prepared;
  const script=await fetchTemplate(session,new URL('res/script/main.js',address).href,options);
  const folder=script&&/\bresFolder\s*:\s*["']([A-Za-z0-9_-]+)["']/.exec(script)?.[1];
  if(!folder||!script.includes('templateUrl')||!script.includes('e.file+".html"'))return prepared;
  const templateUrl=new URL(`${folder}/${route[1]}/${route[2]}.html`,address).href;
  const html=await fetchTemplate(session,templateUrl,options);if(!html)return prepared;
  const parsed=parseSco(html,{skipOral:options.skipOralQuestion??true});
  if(parsed.questions.some(q=>/[{}]|\[object Object\]/.test(q.answer)))return {...prepared,warnings:['动态答案表达式未解析，未提交']};
  return {...prepared,...parsed,templateUrl,contentOnly:!parsed.questions.length&&!parsed.oral&&isWelearnReadingTemplate(html)};
}
