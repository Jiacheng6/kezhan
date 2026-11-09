// Auto-WeLearn; GPL-3.0; see ../../NOTICE.md and original source.
                                                         

/**
 * 构造 setscoinfo 的 `data` 字段。
 *
 * 格式必须逐字符对齐真实请求：
 *   JSON.stringify(cmi/adl/cci) + 字面量 "[INTERACTIONINFO]" + interactionInfo
 * 三个 key 的顺序、字段名、字符串化的数字都不能改。
 */

                                
                              
                              
                
                 
                      
                      
                    
 

                         
                            
                              
                      
                           
                                         
                       
                         
                     
               
 

export const INTERACTION_MARKER = '[INTERACTIONINFO]';

export function buildCmi(params               )         {
  return {
    completion_status: 'completed',
    interactions: params.interactions,
    launch_data: '',
    progress_measure: '1',
    score: { scaled: String(Math.round(params.crate)), raw: '100' },
    session_time: String(Math.max(0, Math.round(params.sessionTime))),
    success_status: 'unknown',
    total_time: String(Math.max(0, Math.round(params.totalTime))),
    mode: 'normal',
  };
}

export function buildScoData(params               , interactionInfo        )         {
  const payload = {
    cmi: buildCmi(params),
    adl: { data: []              },
    cci: {
      data: []             ,
      service: {
        dictionary: { headword: '', short_cuts: '' },
        new_words: []             ,
        notes: []             ,
        writing_marking: []             ,
        record: { files: []              },
        play: { offline_media_id: '9999' },
      },
      retry_count: '0',
      submit_time: '',
    },
  };

  return JSON.stringify(payload) + INTERACTION_MARKER + interactionInfo;
}
