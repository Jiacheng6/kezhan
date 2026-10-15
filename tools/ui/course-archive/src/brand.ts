const originalPaths = `<path d="M156 75C127 48 103 15 70 15C37 15 15 39 15 70S38 128 70 128C103 128 127 96 176 52M155 75C182 99 208 128 240 128C273 128 295 105 295 73S273 15 240 15C221 15 207 23 192 38" fill="none" stroke="currentColor" stroke-width="26"/><path d="M44 70h50M69 45v50M219 70h44" fill="none" stroke="currentColor" stroke-width="15"/>`;
// Two pages, no small decorative details; legible in the Windows tray as well.
const paths = `<path fill="currentColor" d="M48 72H96C106 72 116 76 123 83V190C115 182 105 178 96 178H48Z"/><path class="bookmark" fill="#b18b48" d="M133 83C140 76 150 72 160 72H208V178H160C150 178 141 182 133 190Z"/>`;
export const courseMarkSvg = `<svg viewBox="0 0 256 256" aria-hidden="true">${paths}</svg>`;
export const labelMarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 310 145" color="#171713">${originalPaths}</svg>`;

