const fs=require('node:fs');
// Windows scanners may briefly deny replacement of a file just read/written.
// Keep atomic rename semantics: never delete the existing destination first.
function renameWithRetry(from,to){
  const delays=[15,30,60,100];
  for(let attempt=0;;attempt++){
    try{return fs.renameSync(from,to);}
    catch(error){
      if(process.platform!=='win32'||!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=delays.length)throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,delays[attempt]);
    }
  }
}
module.exports={renameWithRetry};
