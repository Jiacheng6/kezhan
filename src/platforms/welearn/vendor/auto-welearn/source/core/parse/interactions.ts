import type { Interaction, InteractionBundle, Question } from '../../types/domain.js';
import { jsEscape } from './js-escape.js';

/**
 * 按目标正确率生成 SCORM 答题记录。
 *
 * 两个产物必须同时生成且一一对应：
 * - interactions：写进 cmi.interactions
 * - interactionInfo：拼在 [INTERACTIONINFO] 之后，用 `$$` 分隔
 *
 * 错答策略与 §5.3 一致；`correct_responses` 只在答对时给出，
 * 这与平台真实回包一致（答错时给 pattern 反而会暴露正确答案）。
 */

export interface GenerateOptions {
  /** 目标正确率，0-100 */
  crate: number;
  random?: () => number;
}

export function wrongAnswerFor(question: Question, index: number): string {
  switch (question.type) {
    case 'tof': {
      const normalized = question.answer.trim().toLowerCase();
      return normalized === 't' ? 'f' : 't';
    }
    case 'choice':
      return question.answer.trim().toUpperCase() === 'A' ? 'B' : 'A';
    default:
      return `wrong_answer_${index}`;
  }
}

export function generateInteractions(questions: Question[], opts: GenerateOptions): InteractionBundle {
  const random = opts.random ?? Math.random;
  const interactions: Interaction[] = [];
  const infoParts: string[] = [];

  questions.forEach((question, index) => {
    const isCorrect = random() * 100 < opts.crate;
    const response = isCorrect ? question.answer : wrongAnswerFor(question, index);
    const result = isCorrect ? 'correct' : 'wrong';

    const interaction: Interaction = {
      id: `interaction_${index}`,
      type: question.type,
      student_response: response,
      result,
      weighting: '1',
    };
    if (isCorrect) {
      interaction.correct_responses = [{ pattern: question.answer }];
    }
    interactions.push(interaction);

    infoParts.push(`${index}[]false[]false[]${jsEscape(response)}[]${result}`);
  });

  return { interactions, interactionInfo: infoParts.join('$$') };
}
