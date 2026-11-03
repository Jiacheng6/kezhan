# 交互精修与课程档案统一

本轮使用 distinctive-ai-design 与 emil-design-eng，依据用户对动效、残留入口、设置组织和档案主题的反馈继续精修。仅修改源码与独立演示预览，未打包或上传。

| Before | After | Why |
| --- | --- | --- |
| 导航和平台按钮各自亮灭 | 共享底色在按钮之间滑移，可在中途反向 | 建立连续的位置反馈 |
| 课程切换只替换文字 | 章节区域 240ms 淡入与短距离位移 | 让课程内容的切换可感知 |
| 日夜藏在外观菜单 | 顶栏独立日夜按钮，主题从触发点展开 | 提高入口可发现性 |
| 左栏残留网页捷径和工具折叠菜单 | 网页集中在查看网页与管理平台，工具集中进设置 | 去除重复入口 |
| 设置工具仍被旧菜单逻辑收起 | 旧关闭逻辑仅作用于侧栏菜单 | 迁移后保持控件可用 |
| 档案独立固定浅色 | 父页面传递主题，档案文字、面板与 Three.js 阵列材质同步日夜 | 两种视图保持一致 |
| 档案文字直接浮于背景 | 课程信息卡、索引条、顶栏工具统一到主题表面 | 保证背景复杂时的阅读性 |

档案原模型与镜头抽取交互保留；修改源文件位于 `tools/ui/course-archive/src/course-app.ts`、`course-app.css`，并已运行 `node tools/build/build-course-archive.mjs` 重建本地静态产物。不是手改压缩包。

工作台主要修改：`interaction-polish.js`、`theme.js`、`workbench.css`、`selection-desk.js`、`embedded-browser.js`、`index.html`。`library/home.js` 负责向档案 iframe 传递主题和同步上层工具栏。

验收入口：先启动 `node tools/preview/workspace.mjs --workbench --multiplatform`，再运行 `node tools/preview/check-workbench.mjs`。测试仅允许连接 `design-preview-*` 的隔离实例，不处理真实课程。

截图：`.desktop-test/ui-polish-1103/`，包括设置、选课、档案日夜状态。实际打开截图自查后清理了档案页索引旁重复入口。菜单与设置可见性、滑动导航、课程切换动画、档案主题与独立日夜按钮、减少动态效果均有对应验证；页面脚本错误为零。

未验证：真实账号课程/AI 执行、长时间负载与低性能显卡表现。本次未执行完整离线套件；截图自查不能代替用户对动效手感的评价。

## 档案白天材质与主题细节修正

用户发现白天档案仍是深色。原因是 `setTheme/themeAmount` 使用系统时间，逐实例材质波浪使用场景累计时间。统一为 `scene.clock` 后，环境和阵列材质使用同一进度。

| Before | After | Why |
| --- | --- | --- |
| 背景变亮但档案仍深色 | 日夜往返后背景与材质均能到达同一终态 | 统一动画时间基准 |
| 索引嵌条固定金色 | 仅 Index_Inlay 与 Orange 标记使用主题强调色 | 主体保持中性浅色，细节配色呼应工作台 |
| 静止时可能复用旧颜色画面 | 渲染缓存状态包含强调色 | 切色后立即重绘，无需重建网格 |

`node tools/preview/check-archive-theme.mjs` 在独立演示数据中验证白天蓝色、白天粉色、深色粉色与返回白天：真实场景材质进度分别收敛到 0、1、0，页面错误为零。已打开截图检查浅色主体与蓝/粉索引标记；产物在 `.desktop-test/archive-accent-1103/`。该测试需先启动多平台工作台演示预览。
