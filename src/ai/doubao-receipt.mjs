import {waitForRead} from '../control.mjs';

// Passive observation of a request made by the normal web UI. Never creates,
// repeats or modifies requests, and never reads cookies or authorization headers.
export function doubaoRequestTurn(request, marker) {
  try {
    const url=new URL(request.url());
    if(url.protocol!=='https:'||!['www.doubao.com','doubao.com'].includes(url.hostname)||url.pathname!=='/chat/completion'||request.method()!=='POST')return null;
    const body=request.postDataJSON();
    const message=body?.messages?.find(message=>message.content_block?.some(block=>typeof block.content?.text_block?.text==='string'&&block.content.text_block.text.includes(marker)));
    return {localId:typeof message?.local_message_id==='string'?message.local_message_id:'',matches:!!message};
  }catch{return null;}
}

export function doubaoReplyReceipt(body, localId) {
  if(!localId||typeof body!=='string'||body.length>4*1024*1024)return null;
  let acknowledged=false,ended=false;const announced=new Set(),finished=new Set();
  for(const frame of body.replace(/^\ufeff/,'').split(/\r?\n\r?\n/)){
    const lines=frame.split(/\r?\n/),event=lines.find(line=>line.startsWith('event:'))?.slice(6).trim();
    if(!['SSE_ACK','STREAM_MSG_NOTIFY','SSE_REPLY_END'].includes(event))continue;
    let data;try{data=JSON.parse(lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n'));}catch{continue;}
    if(event==='SSE_ACK'&&data.query_list?.some(query=>query.local_message_id===localId))acknowledged=true;
    if(event==='STREAM_MSG_NOTIFY'&&typeof data.meta?.message_id==='string')announced.add(data.meta.message_id);
    if(event==='SSE_REPLY_END'){
      if(typeof data.msg_finish_attr?.msgid==='string')finished.add(data.msg_finish_attr.msgid);
      if(data.end_type===3)ended=true;
    }
  }
  const ids=[...announced].filter(id=>finished.has(id));
  return acknowledged&&ended&&ids.length===1?{answerId:ids[0]}:null;
}

export function observeDoubaoReceipt(page, marker, onReceipt, onSuperseded) {
  let active=true;
  const onRequest=request=>{
    const turn=doubaoRequestTurn(request,marker);
    if(active&&turn&&!turn.matches)void onSuperseded().catch(()=>{});
  };
  const onResponse=response=>{
    const turn=doubaoRequestTurn(response.request(),marker);
    if(!active||!turn?.matches||!turn.localId||response.status()!==200)return;
    void (async()=>{
      // The owning question controls timeout and disposes this observer. Human
      // verification may pause that question for longer than two minutes.
      const body=await waitForRead(()=>response.text(),{shouldStop:()=>!active,timeoutMs:24*60*60*1000,message:'网页回执尚未结束'});
      const receipt=doubaoReplyReceipt(body,turn.localId);
      if(active&&receipt)await onReceipt(receipt);
    })().catch(()=>{}); // The DOM reader remains available when receipts change.
  };
  page.on('request',onRequest);page.on('response',onResponse);
  return ()=>{active=false;page.off('request',onRequest);page.off('response',onResponse);};
}
