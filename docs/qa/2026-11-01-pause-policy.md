# 重试与暂停：三层整改（2026-11-01，批次 1–3 全部完成）

> 只记录工程决策与可复核证据，不含账号、课程名、题目或答题内容。
> 结论：**三个批次均已在根工作区完成并通过离线验证**；未构建、未安装、未触碰用户运行中的安装版。

## 1. 用户反馈

> "现在会莫名奇妙的暂停。"
> "运行一段时间，前面好好的，答题什么的就都行，后面就不行了，一直报错，
> 重试也不管用，有时我手动做完提交后，又恢复，然后重复上述步骤。"

## 2. 证据（只读 `XuexitongAssistant\logs\`）

| 日期 | 报错（原文节选） | 次数 |
|---|---|---|
| 10-13 | `elementHandle.screenshot: Timeout 30000ms exceeded … waiting for element to be stable` | 39 |
| 10-15 | `题目截图读取超时` | 18 |
| 10-16 | `豆包输入区已有附件，请先处理原草稿，避免混入其他题目` | 9 |
| 10-27 | `题目字体加载失败，请刷新题目后重试` / `DeepSeek本次回答未能确认` / `API 未返回可读取的回答` | 8 / 8 / 3 |
| 10-28 | `视频准备失败：读不到视频时长（duration）` | 19 |
| 10-28 | `连续 3 个任务点失败，已全局暂停。请检查后手动继续。` | 2 |

**关键旁证**：10-28 同一条视频首次失败、重试立刻成功
（`13:41:03 失败：读不到视频时长` → `13:41:07 时长 14分47秒`），
证明这些失败是**环境/时序性**，不是"任务做不出来"。

## 3. 三层整改

### 批次 1 —— 失败分级与暂停阈值（`src/failure-policy.mjs` + `src/batch.mjs`）

- `classifyFailure()` 把失败分成 `transient`（环境性）与 `real`，tag 覆盖：
  `screenshot-timeout` / `font-not-ready` / `video-duration` / `ai-draft` /
  `ai-answer-unconfirmed` / `ai-api-empty` / `ai-busy` / `page-not-ready`。
  规则**顺序有意义**：`题目截图超时（题目字体尚未加载）` 先判字体。
- 两条连击独立计数，成功同时清零：`consecutiveFail` / `consecutiveTransient`。
- 暂停条件：真失败 ≥ `batch.pauseAfterFailures`（默认 3）
  或 环境性 ≥ `batch.pauseAfterTransient`（默认 5）。
- 暂停原因从"连续 3 个失败"变成**带任务定位的清单**
  （节号 + 名称 + 失败 tag），并写入通知。
- 新增两个设置项（范围夹紧 1–10 / 2–20，界面「高级」可见）。

### 批次 2 —— 让"重试"真的有作用（AI 侧自愈）

| 文件 | 改动 |
|---|---|
| `src/ai/session-policy.mjs`（新） | `shouldResetSession()` / `sessionAction()` / `nextSessionMemory()` / `planComposerReset()` |
| `src/ai/composer-reset.mjs`（新） | `clearComposerResidue()`：清掉**我们自己**残留的附件/提问文本 |
| `src/ai/web-chat.mjs` | `askWebImage` 变成包装层：上一次失败若与页面状态有关 → 本次先重载 + 新对话（同一错误连续 2 次升级为硬重置）；两处 `draft-attachment` 直接拒绝改为**先自动清理**，清不掉才拒绝 |
| `src/chaoxing/shot.mjs`（新） | `screenshotPlan()` / `clampClip()` / `captureArea()`：元素(8s) → 裁剪(8s) → 整页，内置模式优先 native 成像 → CDP → 整页 |
| `src/chaoxing/popup.mjs`、`discussion.mjs` | 裸调 `element.screenshot()`（默认 30s、要求"元素稳定"）改为 `captureArea()` |

安全边界未变：**用户自己敲进输入框的内容仍然拒绝覆盖**（`planComposerReset` 的 `refuse` 分支有测试）。

### 批次 3 —— 视频元数据（`src/chaoxing/player.mjs`）

- 新增纯函数 `durationVerdict()`：读到时长 → 完成；`video.error` 有值 → **立刻失败并带码**；
  3 秒还没有 → 重新 `load()` 一次（只一次）；预算耗尽 → `duration-timeout`。
- `waitDuration()` 重写：装一次 `loadedmetadata`/`durationchange`/`error` 监听（缓存到
  `__xxtVideoMeta`），轮询读缓存 + `v.error`；返回值改为 `{ok, duration|errorCode, waitedMs}`。
- `prepare()` 的错误信息带上错误码与等待秒数，便于 `classifyFailure` 归类为环境性失败。

## 4. 验证

| 项 | 结果 |
|---|---|
| `tools/test/test-pause-policy.mjs` | 43 项通过（含设置层集成） |
| `tools/test/test-self-heal.mjs` | 37 项通过（截图降级 / 会话自愈 / 输入区清理 / 元数据判定） |
| `tools/test/check-modules.mjs` | 102 项通过（新模块指纹 + 关键标记） |
| 完整离线套件 | **41 套全部通过** |

## 5. 真实运行验证（2026-11-01 16:36–17:05）

**环境**：源码版 + 隔离数据目录 `.desktop-test/verify-1101`（复制自用户数据，只读复制），
控制台 `8788`（避让用户正在运行的 8787），专用 Edge 调试端口 `9333`。
用户正在运行的安装版**全程未动**（只读核对：0.6.10、exe 时间未变）。

| 环节 | 结果 |
|---|---|
| 启动 / 登录 / 账号识别 | ✅ 登录态正常；`已自动识别账号 ID`（课程列表接口） |
| 清单读取 | ✅ 17 门课；149 个未完成测验、272 个未完成视频 |
| **章节测验端到端**（某门课的 1.1 节，5 题） | ✅ 逐题截图 → 千问作答（节流 33 秒/题）→ 回填 → 4 题高可靠 + 1 题中等 → **安全阀未自动提交** |
| 提交校验 | ✅ 第 2 题回填未落页 → 提交被拒：`第 2 题尚未填写完整，已保留答案` |
| 人工改答案后提交 | ✅ `submitted:1 failed:0`；待审条目归档、清单 `completion.state=done` |
| **视频端到端**（某门课的 4.1 节，6 分 54 秒） | ✅ 时长一次读到 → 2× 播放 → 90% 平台核对未确认 → 继续到片尾 → `✓ 本任务点已完成` |
| 日志告警 | ✅ 全量日志中 `读不到视频时长` **0 次**；无异常暂停 |

### 验证中发现并修复的真实缺陷

1. **千问 `generating` 恒为真**（本次最重要）
   页面有两个装饰元素 `rn-right-navigator-loading-empty …--top/--bot`（253×0），
   类名含 `loading`；旧规则"页面上任何可见的 loading/generating/typing 元素"只判可见性、
   不看尺寸 → **永远认为在生成** → 每次提问立刻 `already-generating`，
   5 道题全部空壳待审，AI 通道彻底堵死。这正是用户说的"后面一直报错、重试也不管用"。
   修复：`generatingFrom()` 规则改为"有实际尺寸 **且** 位于回答卡片内"，
   `readAnswer` 内联同一规则；新增 6 项测试（含 253×0 装饰元素的真实用例）。

2. **"AI 正在回答上一条"被当成硬障碍**
   旧逻辑直接 `needs-human` → 暂停整批。现在：先等 `ai.busyWaitMs`（默认 60 秒）让它答完；
   真的等不到才报告忙碌，且**只记「待续跑」不暂停整批**（`isBusyOnlyFailure()` + 测试）。

3. 验证过程中的工具性问题（已修，不涉及产品逻辑）
   用 PowerShell `Set-Content` 写 `state.json` 会写入 UTF-8 BOM，导致服务启动报
   `Unexpected token '﻿'`；改用 `UTF8Encoding(false)` 写入。

### 本轮新增的排障工具

- `tools/diag/verify-one-task.mjs` —— 把执行范围收敛到**单个任务点**并观察全过程（HTTP 接口驱动）
- `tools/diag/inspect-qianwen-generating.mjs` —— 用原始 CDP WebSocket 看"到底什么被判成生成中"
- `tools/diag/unstick-ai.mjs` —— 查/清 AI 网页卡住的生成状态

### 未覆盖（如实说明）

- 豆包 / DeepSeek 网页通道：隔离副本里该账号未登录，`session-policy` 的硬重置路径**未做真机验证**（仅有单测）。
- 视频内弹窗题：本次所选视频未出现弹窗，`shot.mjs` 的降级路径未在真实弹窗上触发。
- 讨论题发布、智慧树流程：未在本轮验证。

## 6. 边界与未做

- 未构建安装包、未替换/重启用户正在运行的安装版（只读核对其为 0.6.10，exe 未变更）。
- 未启动任何真实课程、未做任何提交。
- 真实平台回归（学习通 / 智慧树 / 豆包 / 千问）仍需要在隔离预览里逐条验证；
  涉及提交的步骤需要用户单独授权。
