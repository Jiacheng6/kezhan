import {runWelearnTask} from './runner.mjs';
import {runWelearnProtocolTask} from './protocol-runner.mjs';
// Unit goals and quotations are content pages, not failed question extraction.
// Use the native courseware for these known page kinds; never synthesize answers
// or completion. Unknown names continue through the guarded parser.
export function isWelearnContentPage(task){
  const leaf=String(task?.name||'').split('>').at(-1).trim().replace(/^\d+[.、\s]+/,'').trim();
  return /^(?:Unit Goals|Quotation|单元目标|引言)$/i.test(leaf);
}
export async function runWelearnSelectedTask(args,{native=runWelearnTask,protocol=runWelearnProtocolTask}={}){
  if(isWelearnContentPage(args.task))return native(args);
  const result=await protocol(args);
  return result?.nativeContent?native(args):result;
}
