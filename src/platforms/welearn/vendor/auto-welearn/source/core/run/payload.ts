import type { Interaction } from '../../types/domain.js';

/**
 * 构造 setscoinfo 的 `data` 字段。
 *
 * 格式必须逐字符对齐真实请求：
 *   JSON.stringify(cmi/adl/cci) + 字面量 "[INTERACTIONINFO]" + interactionInfo
 * 三个 key 的顺序、字段名、字符串化的数字都不能改。
 */

export interface ScoDataParams {
  interactions: Interaction[];
  /** 目标正确率，写入 score.scaled */
  crate: number;
  /** 本次会话已过秒数 */
  sessionTime: number;
  /** 历史累计 + 本次已过秒数 */
  totalTime: number;
}

export interface ScoCmi {
  completion_status: string;
  interactions: Interaction[];
  launch_data: string;
  progress_measure: string;
  score: { scaled: string; raw: string };
  session_time: string;
  success_status: string;
  total_time: string;
  mode: string;
}

export const INTERACTION_MARKER = '[INTERACTIONINFO]';

export function buildCmi(params: ScoDataParams): ScoCmi {
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

export function buildScoData(params: ScoDataParams, interactionInfo: string): string {
  const payload = {
    cmi: buildCmi(params),
    adl: { data: [] as unknown[] },
    cci: {
      data: [] as unknown[],
      service: {
        dictionary: { headword: '', short_cuts: '' },
        new_words: [] as unknown[],
        notes: [] as unknown[],
        writing_marking: [] as unknown[],
        record: { files: [] as unknown[] },
        play: { offline_media_id: '9999' },
      },
      retry_count: '0',
      submit_time: '',
    },
  };

  return JSON.stringify(payload) + INTERACTION_MARKER + interactionInfo;
}
