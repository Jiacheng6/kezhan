// Batch execution supplies a BrowserContext; older single-node hooks supply
// a getter. Normalize once so both entry points use the same connection.
export function ucampusContext(value){
  const context=typeof value==='function'?value():value;
  if(!context||typeof context.pages!=='function'||typeof context.newPage!=='function'){
    throw Object.assign(new Error('U校园网页连接尚未就绪，请重新连接后再开始任务'),{code:'INVALID_BROWSER_CONTEXT',retryable:false});
  }
  return context;
}
