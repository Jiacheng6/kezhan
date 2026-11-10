# 第三方开源组件

课栈 0.9.2，修改日期：2026-11-10。整体组合程序按 GNU GPL version 3 发布；第三方组件保留原许可与版权。

## RhineLabUI

- 上游：https://github.com/LBEILC/RhineLabUI
- 作者：LBEILC；Copyright (c) 2026 LBEILC。
- 协议：MIT，原文保留在 `tools/ui/course-archive/LICENSE`、`src/ui/library/archive/LICENSE.txt` 及 `src/ui/library/vendor/LICENSE`。
- 用途：课程档案阵列及相关视觉实现。课栈修改了课程数据绑定、选择交互、主题与性能处理。

## Auto-WeLearn

- 上游：https://github.com/SubmergeDQ/Auto-WeLearn
- 固定版本：9459bb7fafcd98868f9796d6187afd1d5fe6c049。
- 协议：GNU GPL version 3，原文保留在 `src/platforms/welearn/vendor/auto-welearn/LICENSE`。
- 原始 TypeScript、生成的运行模块、改动说明保留在该目录；适配层增加软件内会话、选课、停止控制和平台结果核对。

## 对应源码与构建

每次发布随安装包提供 `Kezhan-版本-Source.zip`，含本版本完整源代码、第三方许可、依赖锁文件和构建脚本。解压后使用 Node.js 22 或更新兼容版本，在根目录和 `tools/ui/course-archive` 分别执行 `npm ci`，再在根目录执行 `npm run build`（Windows x64）。不需要私人账户、令牌或签名密钥。

可按 GPLv3 复制、修改及再分发课栈；分发修改版时须保留许可和署名、说明修改，并提供对应源码。软件不提供任何保证。独立依赖（Electron、Three.js、Cheerio 等）保留各自随包附带的许可；字体解析模块许可另见 `src/chaoxing/vendor/cx-font/THIRD-PARTY-LICENSES.txt`。
