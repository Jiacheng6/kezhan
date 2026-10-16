import { workspace } from "../app.js";
import { completionOf, courseCompletion, sectionCompletion } from "../task-status.js";
import { animate } from "../motion.js";

const preferences = {
  read(key, fallback = null) {
    try {
      return localStorage.getItem("xxt-library-" + key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem("xxt-library-" + key, value);
    } catch {}
  },
};
const entry = document.createElement("button");
entry.id = "enterLibrary";
entry.className = "utility-button library-entry";
entry.textContent = "课程档案 ↗";
document.querySelector("#libraryTools").append(entry);
const media = matchMedia("(prefers-reduced-motion: reduce)");
let startup = preferences.read("startup", "show") === "show",
  reduced =
    preferences.read("motion") === null
      ? media.matches
      : preferences.read("motion") === "reduce",
  quality = preferences.read("quality", "standard");
if (!["standard", "smooth"].includes(quality)) quality = "standard";
let model = workspace.snapshot(),
  active = false,
  windowVisible = true,
  host,
  root,
  frame,
  frameReady = false,
  previousFocus,
  previousOverflow = "",
  lastPayload = "",
  exitAnimation;
const $ = (selector) => root.querySelector(selector);
function courses() {
  return (model.checklist?.courses || [])
    .filter((c) => !c.empty)
    .map((c) => ({
      id: c.courseId,
      title: c.name,
      enabled: !!c.enabled,
      ...courseCompletion(c),
      sections:(c.sections||[]).filter(s=>!(c.tasks||[]).some(t=>t.knowledgeId===s.knowledgeId)).map(s=>({
        name:[s.secNo,s.name].filter(Boolean).join(' '),
        status:sectionCompletion(c,s).label,
        finished:sectionCompletion(c,s).finished,
      })),
      tasks: (c.tasks || []).map((t) => {
        const state = completionOf(t);
        return {
          key: t.key,
          name: t.name || t.typeName || "课程任务",
          section: [t.secNo, t.sectionName].filter(Boolean).join(" "),
          type:
            { video: "视频", work: "测验", doc: "阅读" }[t.type] ||
            t.typeName ||
            "任务",
          status: state.label,
          finished: state.finished,
        };
      }),
    }));
}
function publish(force = false) {
  if (!frameReady) return;
  const value = {
    type: "xxt-archive-state",
    active,
    visible: windowVisible && !document.hidden,
    reduced,
    quality,
    status: { running: !!model.status?.running, loading: !!model.loading },
    courses: courses(),
  };
  const signature = JSON.stringify(value);
  if (!force && signature === lastPayload) return;
  lastPayload = signature;
  frame.contentWindow.postMessage(value, location.origin);
}
workspace.subscribe((next) => {
  model = next;
  publish();
});
function inert(value) {
  for (const el of [
    document.querySelector(".sidebar"),
    document.querySelector(".workspace"),
  ]) {
    el.inert = value;
    if (value) el.setAttribute("aria-hidden", "true");
    else el.removeAttribute("aria-hidden");
  }
}
function syncMotion() {
  document.documentElement.classList.toggle("reduce-motion", reduced);
  if (root) {
    $("#motion").setAttribute("aria-pressed", String(reduced));
    $("#motion").textContent = reduced ? "恢复动态" : "减少动态";
  }
  publish();
}
syncMotion();
media.addEventListener("change", (event) => {
  if (preferences.read("motion") === null) {
    reduced = event.matches;
    syncMotion();
  }
});
window.desktopApp?.onVisibility?.((value) => {
  windowVisible = value;
  publish();
});
document.addEventListener("visibilitychange", () => publish());
async function show() {
  if (!root) {
    host = document.createElement("section");
    host.id = "libraryHome";
    host.hidden = true;
    host.setAttribute("aria-label", "课程档案");
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
:host{position:fixed;inset:0;z-index:100;background:#ebe7e1}:host([hidden]){display:none}*{box-sizing:border-box}iframe{border:0;width:100%;height:100%;display:block}button,input,select{font:inherit}button{cursor:pointer;color:#292c26;background:transparent;border:0;font:12px 'Segoe UI','Microsoft YaHei',sans-serif}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #9a6b2f;outline-offset:4px}.toolbar{position:absolute;top:8.5%;right:3.6%;display:flex;align-items:center;gap:24px;font:12px 'Segoe UI','Microsoft YaHei',sans-serif}.toolbar #enterWorkspace{font-size:13px;font-weight:600}.options{position:absolute;top:45px;right:0;width:275px;padding:24px;background:#f7f4ed;border:1px solid #c5c1b4;box-shadow:0 16px 44px #292c261a;font-size:12px;color:#292c26}.options[hidden]{display:none}.options label{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px;line-height:1.7}.options select{max-width:130px;background:#eeebe2;border:1px solid #bcb6a7;padding:7px;color:inherit}.options #motion{border:1px solid #bcb6a7;padding:9px 12px;width:100%;text-align:left}.options small{display:block;color:#686b61;line-height:1.8;margin-top:14px}.options #closeOptions{position:absolute;right:10px;top:6px}input{accent-color:#9a6b2f}#skip{position:absolute;left:3.6%;bottom:7%;font-size:11px;color:#686b61}.loading-frame{position:absolute;left:3.6%;bottom:11%;font:12px 'Microsoft YaHei',sans-serif;color:#686b61}.loading-frame[hidden]{display:none}@media(max-width:800px){.toolbar{top:5%;gap:16px}.toolbar #enterWorkspace{font-size:12px}.toolbar #appearance{font-size:11px}#skip{display:none}}
</style><iframe id="archiveFrame" src="/library/archive/index.html" title="课程档案三维浏览与课程详情" referrerpolicy="no-referrer"></iframe><div class="toolbar"><button id="archiveWebPages">查看网页 ↗</button><button id="appearance" aria-expanded="false">显示设置</button><button id="enterWorkspace">进入工作台 ↗</button><section id="displayOptions" class="options" hidden aria-label="档案页显示设置"><button id="closeOptions" aria-label="关闭显示设置">×</button><label>启动时显示课程档案<input id="showOnStartup" type="checkbox"></label><label>三维画质<select id="quality"><option value="standard">标准画质</option><option value="smooth">流畅优先</option></select></label><button id="motion" aria-pressed="false">减少动态</button><small>离开档案页或隐藏窗口后，三维画面暂停；学习任务继续运行。</small></section></div><button id="skip">直接进入工作台 →</button><span id="frameLoading" class="loading-frame" role="status">正在打开课程档案…</span>`;
    document.body.append(host);
    frame = $("#archiveFrame");
    $("#archiveWebPages").hidden = !window.desktopApp?.webState;
    $("#archiveWebPages").onclick = () => {
      enterWorkspace();
      document.dispatchEvent(new CustomEvent('open-web-pages', { detail: { mode: 'all' } }));
    };
    $("#enterWorkspace").onclick = $("#skip").onclick = enterWorkspace;
    $("#appearance").onclick = () => options($("#displayOptions").hidden);
    $("#closeOptions").onclick = () => options(false);
    $("#showOnStartup").onchange = (e) => {
      startup = e.target.checked;
      preferences.write("startup", startup ? "show" : "skip");
    };
    $("#quality").onchange = (e) => {
      quality = e.target.value;
      preferences.write("quality", quality);
      publish();
    };
    $("#motion").onclick = () => {
      reduced = !reduced;
      preferences.write("motion", reduced ? "reduce" : "full");
      syncMotion();
    };
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!$("#displayOptions").hidden) options(false);
        else enterWorkspace();
      }
    });
    frame.addEventListener("load", () => {
      frameReady = true;
      $("#frameLoading").hidden = true;
      publish(true);
    });
  }
  if (!active) {
    previousFocus = document.activeElement;
    previousOverflow = document.documentElement.style.overflow;
  }
  exitAnimation?.cancel();
  active = true;
  host.hidden = false;
  host.style.removeProperty("pointer-events");
  document.documentElement.style.overflow = "hidden";
  inert(true);
  $("#showOnStartup").checked = startup;
  $("#quality").value = quality;
  syncMotion();
  publish(true);
  $("#enterWorkspace").focus({ preventScroll: true });
  animate(host, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
}
function options(open) {
  $("#displayOptions").hidden = !open;
  $("#appearance").setAttribute("aria-expanded", String(open));
  (open ? $("#quality") : $("#appearance")).focus();
}
function enterWorkspace() {
  if (!active) return;
  active = false;
  document.documentElement.style.overflow = previousOverflow;
  options(false);
  inert(false);
  publish();
  host.style.pointerEvents = "none";
  exitAnimation = animate(
    host,
    [
      { opacity: 1, transform: "scale(1)" },
      { opacity: 0, transform: "scale(1.015)" },
    ],
    { duration: 260 },
  );
  const finish = () => {
    if (!active) {
      host.hidden = true;
      host.style.removeProperty("pointer-events");
    }
  };
  if (exitAnimation) exitAnimation.finished.then(finish, finish);
  else finish();
  animate(
    document.querySelector(".workspace"),
    [
      { opacity: 0.25, transform: "translateY(10px)" },
      { opacity: 1, transform: "translateY(0)" },
    ],
    { duration: 350 },
  );
  (previousFocus?.isConnected && previousFocus !== document.body
    ? previousFocus
    : document.querySelector(".tab.active")
  )?.focus({ preventScroll: true });
}
window.addEventListener("message", (event) => {
  if (
    !frame ||
    event.source !== frame.contentWindow ||
    event.origin !== location.origin
  )
    return;
  if (event.data?.type === "xxt-archive-ready") {
    frameReady = true;
    $("#frameLoading").hidden = true;
    publish(true);
    return;
  }
  if (event.data?.type !== "xxt-archive-action" || !active) return;
  const { action, courseId } = event.data;
  if (action === "workspace") {
    enterWorkspace();
    return;
  }
  if (action === "open-course" && courses().some((c) => c.id === courseId)) {
    enterWorkspace();
    workspace.openCourse(courseId);
  }
});
entry.onclick = show;
// The archive is a landing layer; it must yield when an internal page opens.
document.addEventListener('embedded-browser-show', enterWorkspace);
export const libraryDiagnostics = Object.freeze({
  snapshot: () => ({
    active,
    windowVisible,
    quality,
    reduced,
    startup,
    loading: !frameReady,
    sceneFailed: !!frame?.contentWindow?.courseArchive?.snapshot().failed,
    scene: frame?.contentWindow?.courseArchive?.snapshot(),
  }),
});
if (startup || location.hash === "#library") void show();
