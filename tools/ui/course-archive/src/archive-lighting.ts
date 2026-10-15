import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { assetUrl } from "./asset-url";

export type LightingLook = "baseline" | "refined";

type Studio = { width: number; height: number; pixels: Uint16Array };
let studio: Promise<Studio> | undefined;
export function loadArchiveStudio() {
  return studio ??= (async () => {
    const [metadata, compressed] = await Promise.all([
      fetch(assetUrl("assets/archive-studio.json")).then(response => { if (!response.ok) throw Error('Studio metadata'); return response.json(); }),
      fetch(assetUrl("assets/archive-studio.bin.gz")).then(response => { if (!response.ok) throw Error('Studio texture'); return response.arrayBuffer(); }),
    ]);
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    const bytes = await new Response(stream).arrayBuffer();
    if(metadata.format !== 'rgba-f16-le' || bytes.byteLength !== metadata.width * metadata.height * 8) throw Error('Studio texture size');
    return {width:metadata.width,height:metadata.height,pixels:new Uint16Array(bytes)};
  })().catch(error => { studio = undefined; throw error; });
}

export function createStudioTexture(studio: Studio) {
  const texture = new THREE.DataTexture(studio.pixels, studio.width, studio.height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.mapping = THREE.CubeUVReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// The archive and its independent viewer use the same studio illumination.
// Each renderer needs its own PMREM render target / WebGL texture.
export function createArchiveLighting(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  look: LightingLook = "baseline",
  studioTexture?: THREE.Texture,
) {
  const refined = look === "refined";
  renderer.toneMappingExposure = refined ? 1.0 : 1.05;
  if (studioTexture) scene.environment = studioTexture;
  else {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
  }
  scene.environmentIntensity = refined ? 0.52 : 0.48;
  scene.add(
    new THREE.HemisphereLight(
      "#fffaf5",
      refined ? "#b49b80" : "#b4a18c",
      refined ? 0.5 : 0.65,
    ),
  );
  const key = new THREE.DirectionalLight(
    refined ? "#fff4e5" : "#fff7ed",
    refined ? 1.7 : 1.4,
  );
  key.position.set(
    ...((refined ? [-8, 14, 4] : [-6, 14, -5]) as [number, number, number]),
  );
  const fill = new THREE.DirectionalLight("#ffffff", refined ? 0.3 : 0.6);
  fill.position.set(7, 8, -10);
  scene.add(key, fill);
  return key;
}
