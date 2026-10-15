// Original procedural scene: curved paper surfaces, a moving helical library,
// and a book built from parametric pages. No imported model or reference code.
import * as THREE from './vendor/three.module.min.js';
const TAU = Math.PI * 2;
function paper(width, height, side = 1) {
  const geometry = new THREE.PlaneGeometry(width, height, 26, 20);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), u = x / width + .5, y = positions.getY(i);
    positions.setXYZ(i, side * (u * width + .025), y, .34 * Math.sin(u * Math.PI) - .19 * u * u + .035 * Math.cos(y * 2) * u);
  }
  if (side < 0) {
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
  }
  geometry.computeVertexNormals(); return geometry;
}
function pageTexture(index = 0, title = '', main = false) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 768;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = main ? '#f4ecd9' : '#eee7d6'; ctx.fillRect(0, 0, 512, 768);
  ctx.fillStyle = '#a94d34'; ctx.fillRect(46, 65, 34, 4);
  ctx.font = '18px sans-serif'; ctx.fillStyle = '#4e5b4b'; ctx.fillText(main ? 'YOUR LEARNING / NEXT CHAPTER' : 'THE OPEN LIBRARY', 46, 105);
  if (main) {
    ctx.fillStyle = '#354a3d'; ctx.font = '56px "Microsoft YaHei UI",sans-serif';
    const letters = Array.from(title || '新的篇章');
    for (let row = 0; row < Math.min(4, Math.ceil(letters.length / 6)); row++) ctx.fillText(letters.slice(row * 6, row * 6 + 6).join(''), 45, 238 + row * 78);
    ctx.font = '22px sans-serif'; ctx.fillStyle = '#8e7251'; ctx.fillText(String(index + 1).padStart(2, '0') + ' / KNOWLEDGE IN MOTION', 46, 685);
  } else {
    ctx.font = '78px Georgia,serif'; ctx.fillStyle = '#53614f'; ctx.fillText(String(index + 1).padStart(2, '0'), 46, 233);
    for (let i = 0; i < 15; i++) { ctx.fillStyle = i % 5 === 0 ? '#a9ad96' : '#c4c4ae'; ctx.fillRect(46, 312 + i * 20, i % 4 === 3 ? 250 : 408, 2); }
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; return texture;
}
export class LibraryScene {
  constructor(host, { reduced = false, quality = 'standard', onFailure, onStep, onOpen } = {}) {
    Object.assign(this, { host, reduced, quality, onFailure, onStep, onOpen, disposed: false, paused: false, ready: false, rendered: 0, frame: null, elapsed: 0, lastFrame: 0, phase: 0, phaseTarget: 0, index: 0 });
    this.events = new AbortController(); this.frameTimes = []; this.textures = [];
    this.world = new THREE.Scene(); this.world.background = new THREE.Color('#efeddf');
    this.world.fog = new THREE.Fog('#efeddf', 23, 62);
    this.camera = new THREE.PerspectiveCamera(39, 1, .1, 100);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1;
    this.renderer.setClearColor('#efeddf');
    const canvas = this.renderer.domElement; canvas.setAttribute('aria-hidden', 'true'); host.append(canvas);
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this.setPaused(true); onFailure?.(new Error('Graphics context unavailable')); }, { signal: this.events.signal });
    this.world.add(new THREE.HemisphereLight('#fffbea', '#738476', 1.7));
    const key = new THREE.DirectionalLight('#fff4d2', 2.1); key.position.set(-6, 10, 15); this.world.add(key);
    const fill = new THREE.DirectionalLight('#b6c6b1', 1.5); fill.position.set(8, -2, -8); this.world.add(fill);
    this.pages = [];
    const leaf = new THREE.PlaneGeometry(1.8, 2.55, 16, 16);
    const positions = leaf.attributes.position;
    for (let i = 0; i < positions.count; i++) positions.setZ(i, .16 * Math.sin((positions.getX(i) + .9) / 1.8 * Math.PI) + positions.getY(i) * positions.getY(i) * .025);
    leaf.computeVertexNormals();
    this.flock = new THREE.Group(); this.world.add(this.flock);
    this.textures = Array.from({ length: 12 }, (_, i) => pageTexture(i));
    for (let i = 0; i < 84; i++) {
      const texture = this.textures[i % 12];
      const mesh = new THREE.Mesh(leaf, new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: .86, color: i % 11 === 0 ? '#d3a17e' : '#fffdf4' }));
      mesh.userData = { angle: i * .387, height: (i % 28) * .62 - 7.8, radius: 9 + Math.floor(i / 28) * 3.3, scale: .68 + (i % 5) * .09 };
      this.pages.push(mesh); this.flock.add(mesh);
    }
    this.book = new THREE.Group(); this.world.add(this.book);
    this.paperMaterials = [];
    for (const side of [-1, 1]) {
      const geometry = paper(2.25, 3.45, side);
      for (let layer = 5; layer >= 0; layer--) {
        const material = new THREE.MeshStandardMaterial({ color: layer === 0 ? '#fffaf0' : (layer % 2 ? '#dad6bf' : '#eee5cc'), side: THREE.DoubleSide, roughness: .85 });
        const sheet = new THREE.Mesh(geometry, material); sheet.position.z = -layer * .028; sheet.rotation.y = side * -.13 - side * layer * .012;
        this.book.add(sheet); if (layer === 0) this.paperMaterials.push(material);
      }
    }
    const spine = new THREE.Mesh(new THREE.CylinderGeometry(.055, .055, 3.49, 12), new THREE.MeshStandardMaterial({ color: '#a55539', roughness: .65 }));
    this.book.add(spine);
    this.pointer = new THREE.Vector2(); this.parallax = new THREE.Vector2();
    const hitBook = event => {
      const rect = canvas.getBoundingClientRect(), pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, this.camera); return ray.intersectObject(this.book, true).length > 0;
    };
    let down = null;
    canvas.addEventListener('pointermove', event => {
      const box = canvas.getBoundingClientRect(); this.pointer.set((event.clientX - box.left) / box.width - .5, (event.clientY - box.top) / box.height - .5);
      canvas.style.cursor = hitBook(event) ? 'pointer' : 'grab';
    }, { signal: this.events.signal });
    canvas.addEventListener('pointerleave', () => this.pointer.set(0, 0), { signal: this.events.signal });
    canvas.addEventListener('pointerdown', event => { if (event.button === 0) { down = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); } }, { signal: this.events.signal });
    canvas.addEventListener('pointerup', event => {
      if (!down) return; const dx = event.clientX - down.x, dy = event.clientY - down.y; down = null;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) onStep?.(dx > 0 ? -1 : 1);
      else if (Math.hypot(dx, dy) < 8 && hitBook(event)) onOpen?.();
    }, { signal: this.events.signal });
    canvas.addEventListener('pointercancel', () => { down = null; }, { signal: this.events.signal });
    let lastWheel = 0;
    canvas.addEventListener('wheel', event => { event.preventDefault(); if (Math.abs(event.deltaY) > 12 && performance.now() - lastWheel > 500) { lastWheel = performance.now(); onStep?.(event.deltaY > 0 ? 1 : -1); } }, { passive: false, signal: this.events.signal });
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host);
    this.tick = this.tick.bind(this); this.resize();
  }
  async load() { this.select(0, '新的篇章'); this.ready = true; this.warmUntil = performance.now() + 1400; this.invalidate(); }
  select(index, title) {
    this.index = index; this.phaseTarget = index * .78; this.turn = 1;
    for (let side = 0; side < 2; side++) {
      const material = this.paperMaterials[side], previous = material.map;
      material.map = pageTexture(index, title, side === 1); material.needsUpdate = true; previous?.dispose();
    }
    this.invalidate();
  }
  resize() {
    if (this.disposed) return; this.width = Math.max(1, this.host.clientWidth); this.height = Math.max(1, this.host.clientHeight);
    this.renderer.setPixelRatio(this.quality === 'smooth' ? 1 : Math.min(devicePixelRatio, 1.5));
    this.renderer.setSize(this.width, this.height, false); this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix(); this.invalidate();
  }
  setQuality(value) { this.quality = value; this.frameTimes = []; this.lastFrame = 0; this.resize(); }
  setReduced(value) { this.reduced = value; this.frameTimes = []; this.lastFrame = 0; this.invalidate(); }
  setPaused(value) { this.paused = value; this.lastFrame = 0; if (value) { cancelAnimationFrame(this.frame); this.frame = null; } else this.invalidate(); }
  schedule() { if (this.frame === null && !this.disposed && !this.paused && this.ready) this.frame = requestAnimationFrame(this.tick); }
  invalidate() { this.schedule(); }
  tick(now) {
    this.frame = null;
    if (this.disposed || this.paused || document.hidden || !this.ready) return;
    const still = this.reduced || this.quality === 'static', interval = 1000 / (this.quality === 'smooth' ? 30 : 60);
    if (this.lastFrame && now - this.lastFrame < interval - .6) { this.schedule(); return; }
    const dt = this.lastFrame ? Math.min(.05, (now - this.lastFrame) / 1000) : 1 / 60;
    if (this.lastFrame && now > this.warmUntil) { this.frameTimes.push(now - this.lastFrame); if (this.frameTimes.length > 240) this.frameTimes.shift(); }
    this.lastFrame = now; if (!still) this.elapsed += dt;
    const t = this.elapsed; this.phase += (this.phaseTarget - this.phase) * (still ? 1 : 1 - Math.exp(-dt * 5));
    for (const mesh of this.pages) {
      const p = mesh.userData, angle = p.angle + (still ? 0 : t * .17) + this.phase;
      mesh.position.set(Math.cos(angle) * p.radius - 2.6, p.height + (still ? 0 : Math.sin(t * .9 + p.angle) * .5), Math.sin(angle) * p.radius - 14);
      mesh.rotation.set(.15 * Math.sin(t * .7 + p.angle), -angle + Math.PI / 2, .23 * Math.sin(p.angle + t * .55));
      mesh.scale.setScalar(p.scale);
    }
    const portrait = this.camera.aspect < 1.05, sway = still ? 0 : Math.sin(t * .7);
    this.parallax.lerp(still ? new THREE.Vector2() : this.pointer, 1 - Math.exp(-dt * 4));
    this.turn = still ? 0 : (this.turn || 0) * Math.exp(-dt * 4);
    this.book.scale.setScalar(portrait ? 1 : 1.35);
    this.book.position.set(portrait ? 0 : -3.6, (portrait ? 3.1 : 1.6) + sway * .32, 5.4);
    this.book.rotation.set(-.1 + (still ? 0 : Math.sin(t * .47) * .08), -.2 + (still ? 0 : Math.sin(t * .4) * .13) + this.parallax.x * .17 + Math.sin(this.turn * Math.PI) * .4, -.13 + (still ? 0 : Math.sin(t * .56) * .055));
    const distance = portrait ? 22 : Math.max(20, 20 * 1.5 / this.camera.aspect);
    this.camera.position.set(this.parallax.x * 1.25, 3.1 - this.parallax.y * .8, distance);
    this.camera.lookAt(portrait ? 0 : -1, portrait ? 1 : 1.2, 0);
    this.renderer.render(this.world, this.camera); this.rendered++;
    if (!still) this.schedule();
  }
  metrics() {
    const values = [...this.frameTimes].sort((a, b) => a - b), mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    return { rendered: this.rendered, paused: this.paused, reduced: this.reduced, quality: this.quality, modelLoaded: this.ready, procedural: true, elapsed: this.elapsed, phase: this.phase, bookPosition: this.book.position.toArray(), bookRotation: this.book.rotation.toArray().slice(0, 3), samples: values.length, fps: mean ? 1000 / mean : 0, p95FrameMs: values[Math.floor(values.length * .95)] || 0, drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, memory: { ...this.renderer.info.memory } };
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    cancelAnimationFrame(this.frame); this.events.abort(); this.resizeObserver.disconnect();
    const geometries = new Set(), materials = new Set(), textures = new Set(this.textures);
    this.world.traverse(object => { if (object.geometry) geometries.add(object.geometry); for (const material of [].concat(object.material || [])) { materials.add(material); if (material.map) textures.add(material.map); } });
    for (const item of [...geometries, ...materials, ...textures]) item.dispose();
    this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
