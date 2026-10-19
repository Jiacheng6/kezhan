// Group repeated answers, never votes/replies. Keep mathematical distinctions.
export const MAX_DISCUSSION_ANSWER=1500;
export function discussionText(value){return String(value||'').replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\r\n?/g,'\n').replace(/[\t ]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();}
const comparable=text=>text.replace(/[\s，。！？、；：,.!?;:‘’“”"'（）()【】\[\]]/g,'');
const signature=text=>JSON.stringify([
 text.match(/[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)||[],
 text.match(/[A-Za-z]+|[\p{Sm}*/^√∞∫∑∂!%\-]/gu)||[],
 text.match(/不一定|不连续|不可导|不存在|不收敛|不单调|不能|不是|不|否|非|无|未/g)||[],
 text.match(/递增|递减|增大|减小|增加|减少|上升|下降|极大|最大|极小|最小|大于|小于|等于|充分|必要|奇函数|偶函数|发散|收敛|连续|可导|有界|无界|正数|负数|[零一二三四五六七八九十百千万半]/g)||[],
]);
function grams(text){const set=new Set();for(let i=0;i<text.length-1;i++)set.add(text.slice(i,i+2));return set;}
function near(a,b,cache){
 if(a===b)return true;
 const max=Math.min(20,Math.floor(Math.max(a.length,b.length)*0.08));
 if(Math.min(a.length,b.length)<16||Math.abs(a.length-b.length)>max)return false;
 if(!cache.has(a))cache.set(a,grams(a));if(!cache.has(b))cache.set(b,grams(b));
 const ga=cache.get(a),gb=cache.get(b);let common=0;for(const g of ga)if(gb.has(g))common++;
 if(2*common/(ga.size+gb.size)<0.88)return false;
 // Banded edit distance: long unrelated posts cannot cause quadratic work.
 let prev=new Map(Array.from({length:Math.min(b.length,max)+1},(_,j)=>[j,j]));
 for(let i=1;i<=a.length;i++){
  const row=new Map();if(i<=max)row.set(0,i);let best=max+1;
  for(let j=Math.max(1,i-max);j<=Math.min(b.length,i+max);j++){
   const distance=Math.min((prev.get(j)??max+1)+1,(row.get(j-1)??max+1)+1,(prev.get(j-1)??max+1)+(a[i-1]===b[j-1]?0:1));
   row.set(j,distance);best=Math.min(best,distance);
  }
  if(best>max)return false;prev=row;
 }
 return (prev.get(b.length)??max+1)<=max;
}
export function repeatedDiscussionAnswer(comments){
 const seen=new Set(),variants=new Map();let scanned=0;
 for(const [index,comment]of (comments||[]).entries()){
  if(comment.id&&seen.has(String(comment.id)))continue;if(comment.id)seen.add(String(comment.id));
  if(comment.isSelf)continue;
  const text=discussionText(comment.text);scanned++;
  if(text.length<2||text.length>MAX_DISCUSSION_ANSWER||/^(同意|赞同|支持|已阅|打卡|签到|学习了|受益匪浅|老师讲得很好|谢谢老师)[\s!！。,.，]*$/.test(text)||!/[\p{L}\p{N}]/u.test(text))continue;
  const canonical=text.normalize('NFKC'),normalized=comparable(canonical),sig=signature(canonical),key=sig+'\0'+normalized;
  if(!variants.has(key))variants.set(key,{text,normalized,signature:sig,authors:new Set(),index});
  variants.get(key).authors.add(comment.authorId?`author:${comment.authorId}`:`post:${comment.id||index}`);
 }
 const groups=[],buckets=new Map(),cache=new Map();
 for(const variant of variants.values()){
  if(!buckets.has(variant.signature))buckets.set(variant.signature,[]);
  const bucket=buckets.get(variant.signature);
  const group=bucket.find(g=>g.variants.every(v=>near(v.normalized,variant.normalized,cache)));
  if(group){group.variants.push(variant);for(const author of variant.authors)group.authors.add(author);}
  else{const added={signature:variant.signature,variants:[variant],authors:new Set(variant.authors)};groups.push(added);bucket.push(added);}
 }
 const candidates=groups.filter(g=>g.authors.size>=2).sort((a,b)=>b.authors.size-a.authors.size||a.variants[0].index-b.variants[0].index);
 if(!candidates.length)return {found:false,scanned,reason:'没有可用的重复或近似回答'};
 const best=candidates[0],variant=[...best.variants].sort((a,b)=>b.authors.size-a.authors.size||a.text.length-b.text.length||a.index-b.index)[0];
 return {found:true,text:variant.text,source:'popular-copy',matches:best.authors.size,variants:best.variants.length,scanned};
}
