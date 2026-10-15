const locks=new Set();
export const isReviewLocked=key=>locks.has(key);
export async function withReviewLock(key, action) {
  if(locks.has(key))throw new Error('该作业正在恢复或提交，请稍候');
  locks.add(key);
  try{return await action();}finally{locks.delete(key);}
}
