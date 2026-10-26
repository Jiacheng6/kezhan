export function reviewOperationBlock(scope,{chaoxingRunning=false,zhihuishuRunning=false,chaoxingScanning=false,zhihuishuScanning=false,syncRunning=false}={}){
 if(syncRunning)return '正在核对平台完成状态，请稍候';
 const zhs=scope?.taskKey?.startsWith('zhihuishu:'),all=scope?.all===true;
 if((all||!zhs)&&(chaoxingRunning||chaoxingScanning))return '请先停止学习通任务或扫描，再处理学习通待审作业';
 if((all||zhs)&&(zhihuishuRunning||zhihuishuScanning))return '请先停止智慧树任务或扫描，再处理智慧树待审作业';
 return null;
}
