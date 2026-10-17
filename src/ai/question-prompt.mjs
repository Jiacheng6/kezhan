// Some learning pages draw unlabeled radio circles. Supply only the verified
// option order/letters, never encrypted DOM text or an assumed correct answer.
export function questionPrompt(base, question) {
  if (!['single','multiple'].includes(question?.qtype)) return base;
  const letters=(question.options||[]).map(option=>String(option.letter||'').trim().toUpperCase());
  if (letters.length<2||letters.length>26||letters.some(letter=>!/^[A-Z]$/.test(letter))||new Set(letters).size!==letters.length) return base;
  const mapping=letters.map((letter,index)=>`第${index+1}项对应${letter}`).join('，');
  return `${base}\n\n本题为${question.qtype==='single'?'单选题，只选一项':'多选题，可选多项'}。截图中的选项可能没有显示字母。按题面顺序从上到下（同一行从左到右），${mapping}。请依据图片判断答案，再转换成对应选项字母。只输出“答案：”加选项字母；多选字母连续书写。不要只回答人名、名称或选项正文，也不要把上述对应表当作答案。看不清时明确说明看不清，不要猜测。`;
}
