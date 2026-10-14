// utilityProcess 自带 Node.js，无需用户安装 Node 或 npm。
process.parentPort.on('message', ({ data }) => {
  if (data?.type === 'ping') process.parentPort.postMessage({ type: 'pong' });
});
import('../src/main.mjs').catch((err) => {
  process.parentPort.postMessage({ type: 'fatal', message: err.message });
  process.exitCode = 1;
});
