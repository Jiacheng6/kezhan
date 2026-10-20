const stylesheet = document.querySelector("#workspaceDesign");
const toggle = document.createElement("button");
toggle.id = "toggleClassicUi";
toggle.className = "utility-button";
toggle.title = "切换工作台外观";
document.querySelector("#desktopToolbar").before(toggle);
let classic = false;
try {
  classic = localStorage.getItem("xxt-classic-workspace") === "true";
} catch {}
function sync() {
  document.documentElement.dataset.workspaceAppearance = classic ? "classic" : "kezhan";
  stylesheet.disabled = classic;
  document.querySelector('#kezhanDesign').disabled = classic;
  toggle.textContent = classic ? "切换新版界面" : "切换经典界面";
  toggle.setAttribute("aria-pressed", String(classic));
}
toggle.onclick = () => {
  classic = !classic;
  try {
    localStorage.setItem("xxt-classic-workspace", String(classic));
  } catch {}
  sync();
};
sync();
