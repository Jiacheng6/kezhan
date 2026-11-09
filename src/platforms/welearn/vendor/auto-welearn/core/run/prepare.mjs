// Auto-WeLearn; GPL-3.0; see ../../NOTICE.md and original source.
                                                      
                                                      
                                                  
import { fetchTemplate, getScoAddr,                 } from '../api/sco.mjs';
import { parseSco,                    } from '../parse/sco-parser.mjs';

/**
 * 单节的「准备阶段」：拿内容地址 → 抓模板 → 解析答案。
 * 这一步纯读，dry-run 与真实提交共用，保证两者看到的是同一份解析结果。
 */

                                    
                             
                        
               
                          
                     
 

export async function prepareLesson(
  session         ,
  params                                                  ,
  opts                                                                        = {},
)                             {
  const address = await getScoAddr(
    session,
    { cid: params.cid, scoid: params.scoid },
    { signal: opts.signal, classid: params.classid, logger: opts.logger },
  );

  if (!address) {
    return { address: null, questions: [], oral: 0, strategy: 'none', warnings: ['NO_TEMPLATE'] };
  }

  const html = await fetchTemplate(session, address.url, { signal: opts.signal, logger: opts.logger });
  if (html === null) {
    return { address, questions: [], oral: 0, strategy: 'none', warnings: ['TEMPLATE_FETCH_FAILED'] };
  }

  const parsed = parseSco(html, { skipOral: opts.skipOralQuestion ?? true });
  return {
    address,
    questions: parsed.questions,
    oral: parsed.oral,
    strategy: parsed.strategy,
    warnings: parsed.warnings,
  };
}
