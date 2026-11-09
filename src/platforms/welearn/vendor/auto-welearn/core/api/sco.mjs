// Auto-WeLearn; GPL-3.0; see ../../NOTICE.md and original source.
import { AppError } from '../errors.mjs';
                                                      
                                                  
import { ACCEPT_JSON } from '../http/headers.mjs';
import { PATHS, refStudyCourse, refStudyShort } from './endpoints.mjs';
import { isLoginWall, isRetOk, parseJsonOrThrow } from './response.mjs';
import { parseScormTime } from '../parse/scorm-time.mjs';

/**
 * SCO 相关接口。
 *
 * scoAddr 是理解整个课程内容结构的关键，实测结果与规格假设不同（附录 C-5）：
 *   addr 形如 `//centercourseware.sflep.com/<课程名>/unit_03/main5.html?m-1-3-5|Unit 3 > … > Task 1`
 * - 没有 `#/2/4-3` 这种 hash 路由
 * - 路径里带空格（课程名），需要交给 fetch 自身编码
 * - `|` 后面是小节路径，仅用于展示
 * 也就是说：**addr 去掉 `|` 后缀就是内容页地址本身**，不需要再推导 data/{unit}/{file}.html。
 */

                             
                         
              
                         
                   
              
 

                          
               
                
                
 

export async function getScoAddr(
  session         ,
  params                                ,
  opts                                                              = {},
)                             {
  const referer = opts.classid
    ? refStudyShort(session.baseUrl, params.cid, params.scoid)
    : `${session.baseUrl}/Student/StudyCourse.aspx?cid=${encodeURIComponent(params.cid)}&sco=${encodeURIComponent(params.scoid)}`;

  const res = await session.postForm(
    PATHS.sco,
    { action: 'scoAddr', cid: params.cid, scoid: params.scoid },
    { referer, accept: ACCEPT_JSON, signal: opts.signal },
  );

  if (isLoginWall(res.text, res.status)) {
    throw new AppError({ code: 'AUTH_EXPIRED', message: '会话已失效：scoAddr 被跳转到登录页', retryable: false });
  }

  const payload = parseJsonOrThrow                (res.text, 'scoAddr');
  if (payload.ret !== 0 || !payload.addr) {
    opts.logger?.debug(`scoAddr 无内容地址（ret=${String(payload.ret)}）：${params.scoid}`);
    return null;
  }

  const raw = payload.addr;
  const [addrPart = '', location = ''] = raw.split('|');
  if (addrPart.length === 0) return null;

  const url = addrPart.startsWith('//')
    ? `${session.baseUrl.startsWith('http://') ? 'http:' : 'https:'}${addrPart}`
    : addrPart;
  return { url, location: location.trim(), raw };
}

/** 抓取内容页 HTML。404 或空内容返回 null，按「无模板」处理 */
export async function fetchTemplate(
  session         ,
  url        ,
  opts                                            = {},
)                         {
  try {
    const res = await session.get(url, {
      referer: `${session.baseUrl}/`,
      signal: opts.signal,
      allowErrorStatus: true,
    });
    if (res.status !== 200) {
      opts.logger?.debug(`内容页返回 HTTP ${res.status}：${url.slice(0, 120)}`);
      return null;
    }
    return res.text;
  } catch (err) {
    if (err instanceof AppError && err.code === 'INTERRUPTED') throw err;
    opts.logger?.debug(`内容页抓取失败：${(err         ).message}`);
    return null;
  }
}

                           
               
                
                   
 

/** 读写类调用统一入口，返回原始响应文本供调用方判定 */
export async function postScoAction(
  session         ,
  form                        ,
  opts                                           ,
)                  {
  const res = await session.postForm(PATHS.sco, form, {
    referer: opts.referer,
    accept: ACCEPT_JSON,
    signal: opts.signal,
  });

  if (isLoginWall(res.text, res.status)) {
    throw new AppError({ code: 'AUTH_EXPIRED', message: '会话已失效：SCO 写操作被跳转到登录页', retryable: false });
  }
  return res.text;
}

export function scoOk(text        )          {
  return isRetOk(text);
}

/** 解析 getscoinfo_v7 的 comment 双层 JSON */
export function parseCmiComment(text        )                                 {
  try {
    const outer = parseJsonOrThrow                 (text, 'getscoinfo_v7');
    if (!outer.comment) return null;
    const inner = JSON.parse(outer.comment)                                     ;
    return inner.cmi ?? null;
  } catch {
    return null;
  }
}

/** 写操作需要的上下文，四个字段缺一不可 */
                             
              
                
              
                  
 

function refererFor(session         , ctx            )         {
  return refStudyCourse(session.baseUrl, { cid: ctx.cid, classid: ctx.classid, scoid: ctx.scoid });
}

/** 注册本次学习会话 */
export async function startSco(
  session         ,
  ctx            ,
  opts                           = {},
)                   {
  const text = await postScoAction(
    session,
    { action: 'startsco160928', cid: ctx.cid, scoid: ctx.scoid, uid: ctx.uid },
    { referer: refererFor(session, ctx), signal: opts.signal },
  );
  return scoOk(text);
}

/** 提交 SCORM 数据与答题记录。isend 必须是字符串 "False"（首字母大写） */
export async function setScoInfo(
  session         ,
  ctx            ,
  data        ,
  opts                           = {},
)                   {
  const text = await postScoAction(
    session,
    {
      action: 'setscoinfo',
      cid: ctx.cid,
      scoid: ctx.scoid,
      uid: ctx.uid,
      data,
      isend: 'False',
    },
    { referer: refererFor(session, ctx), signal: opts.signal },
  );
  return scoOk(text);
}

                                
                
                      
                    
                    
                   
 

/** 保存进度与成绩 */
export async function saveScoInfo(
  session         ,
  ctx            ,
  params               ,
  opts                           = {},
)                   {
  const text = await postScoAction(
    session,
    {
      action: 'savescoinfo160928',
      cid: ctx.cid,
      scoid: ctx.scoid,
      uid: ctx.uid,
      progress: String(params.progress ?? 100),
      crate: String(Math.round(params.crate)),
      status: 'unknown',
      cstatus: params.cstatus ?? 'completed',
      trycount: '0',
      session_time: String(Math.max(0, Math.round(params.sessionTime))),
      total_time: String(Math.max(0, Math.round(params.totalTime))),
    },
    { referer: refererFor(session, ctx), signal: opts.signal },
  );
  return scoOk(text);
}

                              
                      
                        
                               
 

                           
                                
                                                            
                                                           

/**
 * 读取当前 CMI，拿到历史累计时长作为累加基线。
 *
 * 实测（附录 C-10）：从未学过的小节返回 `{"ret":-1, "msg":"学习数据不正确"}`，
 * 这是「还没有 CMI」的正常状态，不是错误 —— 首次 setscoinfo 之后才存在 cmi。
 * 因此默认 alreadyStarted=true 时不再补发 startsco（调用方已经发过了）。
 */
export async function getCmi(
  session         ,
  ctx            ,
  opts                                                                      = {},
)                         {
  const referer = refererFor(session, ctx);

  const read = async ()                                                                 => {
    const text = await postScoAction(
      session,
      { action: 'getscoinfo_v7', uid: ctx.uid, cid: ctx.cid, scoid: ctx.scoid },
      { referer, signal: opts.signal },
    );
    return { text, cmi: parseCmiComment(text) };
  };

  let { text, cmi } = await read();
  const uninitialized = !cmi && text.includes('学习数据不正确');

  // 仅当调用方尚未 startsco 时才补发（历史实现供时间模式使用，本流程不需要）
  if (uninitialized && opts.alreadyStarted === false) {
    opts.logger?.debug('CMI 未初始化，补发 startsco 后重试');
    await startSco(session, ctx, opts);
    const retry = await read();
    cmi = retry.cmi;
  }

  if (!cmi) {
    return { ok: false, reason: uninitialized ? 'uninitialized' : 'unavailable' };
  }

  return {
    ok: true,
    totalBefore: parseScormTime(cmi.total_time),
    sessionBefore: parseScormTime(cmi.session_time),
    cmi,
  };
}

/**
 * 心跳保活。等待期间必须周期性上报 session_time/total_time，
 * 否则长时长的"挂机"容易被平台判为无效学习（这是 Node 版相对 Python 版的核心差异）。
 */
export async function keepSco(
  session         ,
  ctx            ,
  times                                            ,
  opts                           = {},
)                   {
  const text = await postScoAction(
    session,
    {
      action: 'keepsco_with_getticket_with_updatecmitime',
      uid: ctx.uid,
      cid: ctx.cid,
      scoid: ctx.scoid,
      session_time: String(Math.max(0, Math.round(times.sessionTime))),
      total_time: String(Math.max(0, Math.round(times.totalTime))),
    },
    { referer: refererFor(session, ctx), signal: opts.signal },
  );
  return scoOk(text);
}
