import { ArchiveScene } from "./scene";
import {
  records,
  courseList,
  updateCourses,
  columnFiles,
  fileLocation,
  type Course,
} from "./data";
import { wrap, type ArchiveNavigation } from "./archive-loop";
import { qualityPresets } from "./render-quality";
import type { RenderQuality } from "./render-quality";
import "./course-app.css";
import { courseMarkSvg } from "./brand";
import { loadArchiveStudio, createStudioTexture } from "./archive-lighting";
const root = document.querySelector<HTMLElement>("#archive-app")!;
root.innerHTML = `<div id="scene" class="three-scene"></div>
<header class="archive-brand"><span class="brand-index">XXT / 01</span><h1>学习通助手</h1><p>课程档案 <i>／</i> LEARNING ARCHIVE</p></header>
<section id="array-copy" class="array-copy"><p class="overline">你的课程，随时继续</p><h2 id="selected-title">正在读取课程…</h2><div class="copy-rule"></div><div class="course-meta"><span id="selected-progress"></span><span id="selected-count"></span></div><button id="open-course" class="text-action">预览这门课程 <span>↗</span></button></section>
<div id="hover-label" class="hover-label" hidden></div>
<nav id="array-nav" class="array-nav" aria-label="课程导航"><span>课程索引</span><button id="previous" aria-label="上一门课程">↑</button><b id="course-number">01</b><i>/</i><span id="course-total">00</span><button id="next" aria-label="下一门课程">↓</button><small>拖动浏览 · 点击抽取</small></nav>
<section id="preview" class="course-surface" hidden tabindex="-1" aria-label="课程预览"><button class="back" data-back>← 返回课程阵列 <kbd>ESC</kbd></button><div class="surface-copy"><div id="archive-boot" class="archive-boot" data-step="extracting" role="status"><div class="boot-mark" aria-hidden="true">${courseMarkSvg}<b></b></div><div><span class="boot-caption">COURSE ACCESS</span><strong id="archive-boot-status">正在抽取课程档案</strong></div><span class="boot-state">01 / 03</span></div><p class="overline">已选课程 <span id="preview-code"></span></p><h2 id="preview-title"></h2><div class="copy-rule"></div><p id="preview-progress" class="muted"></p><button id="confirm-course" class="primary" disabled>查看课程详情 <span>→</span></button><small>确认后查看章节及各项任务的完成状态</small></div></section>
<section id="detail" class="course-surface" hidden aria-label="课程详情"><button class="back" data-back>← 返回课程阵列 <kbd>ESC</kbd></button><div class="surface-copy detail-copy"><p class="overline">课程详情 <span id="detail-code"></span></p><h2 id="detail-title"></h2><div class="detail-progress"><span id="detail-progress"></span><span id="detail-selection"></span></div><div class="progress-track"><i id="progress-fill"></i></div><h3>章节与任务 <span id="detail-total"></span></h3><div id="task-list" class="task-list" tabindex="0" aria-label="章节任务完成状态"></div><button id="choose-scope" class="primary">选择学习范围 <span>→</span></button><p class="detail-note">在工作台确认任务范围后，再开始学习。</p></div></section>
<div id="empty" class="empty" hidden><p class="overline">从这里开始</p><h2>把课程带进来。</h2><p id="empty-message">先在工作台登录学习通，再扫描课程。已有的清单和进度会自动显示在这里。</p><button data-workspace class="primary">进入工作台 <span>→</span></button></div>
<section id="loading" class="loading-screen" role="status"><div class="loading-content"><div class="boot-mark large" aria-hidden="true">${courseMarkSvg}<b></b></div><span class="boot-caption">学习通助手 / LEARNING SPACE</span><h2>正在打开课程档案</h2><p id="loading-phase">准备本地视图</p><div class="loading-track"><i></i></div><button data-workspace>直接进入工作台 →</button></div></section><div id="notice" class="notice" hidden role="status">三维画面暂不可用，可进入工作台继续使用。<button data-workspace>进入工作台 →</button><button id="retry-scene">重试画面</button></div>
<footer><span><i></i><span id="session-state">进度保存在本机</span></span><small>3D BASE / RHINELABUI · MIT</small></footer>`;
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  root.querySelector<T>(s)!;
type Phase = "array" | "preview" | "detail";
let phase: Phase = "array",
  scene: ArchiveScene | undefined,
  selected = 2,
  active = true,
  visible = true,
  ready = false,
  failed = false;
let reduced = matchMedia("(prefers-reduced-motion: reduce)").matches,
  quality = "standard",
  titleAt = 0,
  scanAt = 0,
  clock = 0,
  last = 0,
  frames = 0;
let lastDraw = -Infinity;
let status: { running?: boolean; loading?: boolean } = {},
  catalogSignature = "",
  taskSignature = "",
  modelGeneration = 0,
  loadingScene = false;
// Preserve the reference's glass, contact shadows and soft cast shadows.
// Standard mode uses the reference preset, including full-resolution AO and DOF.
const balancedQuality:RenderQuality={...qualityPresets.original};
const timings:Record<string,number>={started:performance.now()};
const afterPaint=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const send = (action: string, courseId?: string) =>
  parent.postMessage(
    { type: "xxt-archive-action", action, courseId },
    location.origin,
  );
function current() {
  return records[selected] || records[0];
}
function progressText(r:typeof records[number]) {
  return r.total ? `已读取任务 ${r.completed} / ${r.total} 项已完成` : r.course.label || '任务详情未读取';
}
function copySelection() {
  const r = current(),
    index = selected % Math.max(1, courseList.length);
  $("#selected-title").textContent = r.title;
  $("#selected-progress").textContent = progressText(r);
  $("#selected-count").textContent = r.course.finished ? '课程已完成' : r.total-r.completed ? `${r.total - r.completed} 项待完成` : r.course.label || '待确认';
  $("#course-number").textContent = String(index + 1).padStart(2, "0");
  $("#course-total").textContent = String(courseList.length).padStart(2, "0");
  $("#previous").toggleAttribute("disabled", courseList.length < 2);
  $("#next").toggleAttribute("disabled", courseList.length < 2);
}
function select(i: number, navigation?: ArchiveNavigation) {
  selected = wrap(i, records.length);
  scene?.select(selected, navigation);
  copySelection();
  taskSignature = "";
}
function step(direction: number) {
  if (phase !== "array" || !courseList.length) return;
  const files = columnFiles(fileLocation(selected).lane);
  select(files[wrap(files.indexOf(selected) + direction, files.length)], {
    axis: "row",
    direction,
  });
}
function changeLane(direction: number) {
  if (phase !== "array") return;
  const lane = wrap(fileLocation(selected).lane + direction, 5);
  select(columnFiles(lane)[selected % Math.max(1, courseList.length)], {
    axis: "lane",
    direction,
  });
}
function extract() {
  if (!ready || !courseList.length || phase !== "array" || !scene) return;
  phase = "preview";
  root.dataset.phase = phase;
  $("#preview").hidden = false;
  $("#preview").classList.remove("title-ready");
  $("#array-copy").inert = $("#array-nav").inert = true;
  const r = current();
  $("#preview-title").textContent = r.title;
  $("#preview-code").textContent = "课程 " + r.courseCode;
  $("#preview-progress").textContent =
    progressText(r);
  $<HTMLButtonElement>("#confirm-course").disabled = true;
  titleAt = 0;
  scanAt = 0;
  $("#archive-boot").dataset.step="extracting";
  $("#archive-boot-status").textContent="正在抽取课程档案";
  $(".boot-state").textContent="01 / 03";
  scene.inspectionEnabled = false;
  scene.setMode("detail");
  $("#preview").focus({ preventScroll: true });
}
function confirm() {
  if (phase !== "preview" || $<HTMLButtonElement>("#confirm-course").disabled)
    return;
  phase = "detail";
  root.dataset.phase = phase;
  $("#preview").hidden = true;
  $("#detail").hidden = false;
  scene!.inspectionEnabled = true;
  renderDetails();
  $("#task-list").focus({ preventScroll: true });
}
function back() {
  scene?.setArchiveBoot(0);
  phase = "array";
  root.dataset.phase = phase;
  $("#preview").hidden = $("#detail").hidden = true;
  $("#array-copy").inert = $("#array-nav").inert = false;
  scene?.setMode("archive");
  $("#open-course").focus({ preventScroll: true });
}
function renderDetails() {
  const r = current();
  $("#detail-title").textContent = r.title;
  $("#detail-code").textContent = "课程 " + r.courseCode;
  $("#detail-progress").textContent = progressText(r);
  $("#detail-selection").textContent = r.course.enabled
    ? "已纳入学习范围"
    : "尚未选入学习范围";
  $("#progress-fill").style.width =
    `${r.course.finished ? 100 : r.total ? (r.completed / r.total) * 100 : 0}%`;
  $("#detail-total").textContent = r.total ? `已读取 ${r.total} 项任务` : r.course.label || '任务详情未读取';
  const signature = JSON.stringify([r.course.tasks,r.course.sections]);
  if (signature === taskSignature) return;
  taskSignature = signature;
  const list = $("#task-list"),
    scroll = list.scrollTop,
    groups = new Map<string, typeof r.course.tasks>();
  for (const t of r.course.tasks) {
    if (!groups.has(t.section)) groups.set(t.section, []);
    groups.get(t.section)!.push(t);
  }
  list.innerHTML =
    [...groups]
      .map(
        ([section, tasks]) =>
          `<section class="chapter"><h4>${escape(section || "其他任务")}</h4>${tasks.map((t) => `<div class="task-row"><span class="task-type">${escape(t.type)}</span><span class="task-name">${escape(t.name)}</span><b class="${t.finished ? "done" : "pending"}">${escape(t.status)}</b></div>`).join("")}</section>`,
      )
      .join("") + (r.course.sections||[]).map(s=>`<section class="chapter"><h4>${escape(s.name)}</h4><p class="muted">${escape(s.finished?'平台已标记此小节完成，未重复读取任务详情。':s.status)}</p></section>`).join('') || '<p class="muted">任务详情尚未读取，请到工作台检查扫描结果。</p>';
  list.scrollTop = scroll;
}
function applyCatalog(courses: Course[]) {
  const before = current()?.course.id,
    key = JSON.stringify(courses.map((c) => [c.id, c.title])),
    changed = key !== catalogSignature;
  catalogSignature = key;
  updateCourses(courses);
  if (changed) {
    if (phase !== "array") back();
    selected =
      2 * Math.max(1, courses.length) +
      Math.max(
        0,
        courses.findIndex((c) => c.id === before),
      );
    scene?.select(selected);
  }
  copySelection();
  scene?.refreshArtwork(selected);
  $("#empty").hidden = !!courses.length;
  $("#array-copy").hidden = $("#array-nav").hidden = !courses.length;
  if (!courses.length)
    $("#empty-message").textContent = status.loading
      ? "正在读取本机已保存的课程清单…"
      : "先在工作台登录学习通，再扫描课程。已有的清单和进度会自动显示在这里。";
  if (phase === "detail") renderDetails();
  if (phase === "preview")
    $("#preview-progress").textContent =
      progressText(current());
}
function syncPreferences() {
  document.documentElement.classList.toggle("reduced", reduced);
  scene?.setReduced(reduced);
  scene?.setQuality(
    quality === "smooth" ? qualityPresets.performance : balancedQuality,
  );
  scene?.setSuperPerformance(quality === "smooth");
}
async function loadScene() {
  if (loadingScene) return;
  loadingScene = true;
  ready = false;
  const request = ++modelGeneration;
  $("#loading").hidden = false;
  failed = false;
  try {
    await afterPaint();
    $("#loading-phase").textContent="载入本地档案模型";
    const studio = await loadArchiveStudio();
    if (request !== modelGeneration) return;
    scene?.dispose();
    $("#scene").replaceChildren();
    scene = new ArchiveScene($("#scene"), undefined, false, "baseline", createStudioTexture(studio));
    syncPreferences();
    scene.setMode("archive");
    scene.select(selected);
    await scene.load();
    if (request !== modelGeneration) return;
    timings.modelLoaded=performance.now();
    scene.setSuperPerformance(quality === "smooth");
    scene.select(selected);
    $("#loading-phase").textContent="准备课程画面";
    await afterPaint();
    await scene.warmup();
    timings.shadersReady=performance.now();
    scene.update(clock);
    await afterPaint();
    scene.update(clock+.016);
    scene.onSelect = (i, cell) => {
      if (phase === "array") select(i, cell ? { cell } : undefined);
    };
    scene.onActivate = extract;
    scene.onNavigate = (axis, d) => (axis === "lane" ? changeLane(d) : step(d));
    scene.onHover = (i) => {
      const label = $("#hover-label");
      label.hidden = i === null;
      if (i !== null) label.textContent = records[i].title;
    };
    ready = true;
    timings.ready=performance.now();
    $("#notice").hidden = true;
  } catch {
    scene?.dispose();
    scene = undefined;
    failed = true;
    ready = false;
    $("#notice").hidden = false;
  } finally {
    if (request === modelGeneration) {
      $("#loading").hidden = true;
      loadingScene = false;
    }
  }
}
window.addEventListener("message", (event) => {
  if (
    event.source !== parent ||
    event.origin !== location.origin ||
    event.data?.type !== "xxt-archive-state"
  )
    return;
  const m = event.data;
  const resumed=!!m.active&&!!m.visible&&(!active||!visible);
  active = !!m.active;
  visible = !!m.visible;
  // The model can finish loading while the workspace hides this iframe.
  // Reopening it must restore the renderer from its hidden (zero-size) layout.
  if(resumed)requestAnimationFrame(()=>scene?.resize());
  status = m.status || {};
  const nextReduced = !!m.reduced,
    nextQuality = m.quality === "smooth" ? "smooth" : "standard";
  if (nextReduced !== reduced || nextQuality !== quality) {
    reduced = nextReduced;
    quality = nextQuality;
    syncPreferences();
  }
  applyCatalog(Array.isArray(m.courses) ? m.courses : []);
  $("#session-state").textContent = status.running
    ? "任务运行中 · 离开档案页仍会继续"
    : "进度保存在本机";
});
$("#open-course").onclick = extract;
$("#confirm-course").onclick = confirm;
$("#previous").onclick = () => step(-1);
$("#next").onclick = () => step(1);
root
  .querySelectorAll<HTMLButtonElement>("[data-back]")
  .forEach((b) => (b.onclick = back));
root
  .querySelectorAll<HTMLButtonElement>("[data-workspace]")
  .forEach((b) => (b.onclick = () => send("workspace")));
$("#choose-scope").onclick = () => send("open-course", current().course.id);
$("#retry-scene").onclick = () => void loadScene();
window.addEventListener("keydown", (event) => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (phase !== "array") back();
    else send("workspace");
  }
  if (
    event.key === "Enter" &&
    (event.target === document.body || event.target === $("#preview"))
  ) {
    event.preventDefault();
    if (phase === "array") extract();
    else if (phase === "preview") confirm();
  }
  if (
    phase === "array" &&
    ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
  ) {
    event.preventDefault();
    if (event.key === "ArrowUp") step(-1);
    if (event.key === "ArrowDown") step(1);
    if (event.key === "ArrowLeft") changeLane(-1);
    if (event.key === "ArrowRight") changeLane(1);
  }
});
window.addEventListener("resize", () => {
  root.dataset.layout = innerWidth < 1000 ? "compact" : "desktop";
  scene?.resize();
});
root.dataset.layout = innerWidth < 1000 ? "compact" : "desktop";
root.dataset.phase = "array";
function frame(ms: number) {
  requestAnimationFrame(frame);
  const delta = last ? Math.min(0.05, (ms - last) / 1000) : 0;
  last = ms;
  if (!active || !visible || document.hidden) return;
  clock += delta;
  const interval=1000/(quality==="smooth"?45:60);
  if(ms-lastDraw<interval-.7)return;
  lastDraw=ms;
  if (scene && ready) {
    scene.update(clock);
    frames++;
    if (phase === "preview") {
      if (!scanAt && scene.detailVisibility > 0.94) {
        scanAt = clock || 0.001;
        $("#archive-boot").dataset.step="reading";
        $("#archive-boot-status").textContent="正在读取章节索引";
        $(".boot-state").textContent="02 / 03";
      }
      if(scanAt&&!titleAt){
        const progress=reduced?1:Math.min(1,(clock-scanAt)/.72);
        scene.setArchiveBoot(progress);
        if(progress>=1){
          titleAt=clock;
          $("#archive-boot").dataset.step="ready";
          $("#archive-boot-status").textContent="课程档案已就绪";
          $(".boot-state").textContent="03 / 03";
          $("#preview").classList.add("title-ready");
        }
      }
      if (titleAt && clock - titleAt > (reduced ? 0 : 0.55))
        $<HTMLButtonElement>("#confirm-course").disabled = false;
    }
  }
}
Object.assign(window, {
  courseArchive: {
    snapshot: () => ({
      phase,
      ready,
      failed,
      active,
      visible,
      reduced,
      quality,
      frames,
      openingStep:$("#archive-boot").dataset.step,
      timings:{...timings},
      courseId: current()?.course.id,
      courseTitle: current()?.title,
      courseCount: courseList.length,
      scene: scene?.getStats(),
    }),
    extract,
    back,
  },
});
parent.postMessage({ type: "xxt-archive-ready" }, location.origin);
requestAnimationFrame(frame);
void loadScene();
window.addEventListener("pagehide", () => {
  modelGeneration++;
  scene?.dispose();
});
