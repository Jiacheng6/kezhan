import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

export async function loadModel(file){
  const bytes=fs.readFileSync(file);
  return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene;
}
const reels=new Set(['Subsurface_Optics','Optical_Film_Edge','Amber_Optical_Inlay','Optical_Film']);
export function retainEnclosure(scene){
  const meshes=[];scene.traverse(m=>{if(m.isMesh)meshes.push(m);});
  for(const mesh of meshes){
    const name=mesh.material.name.replace(/\.\d+$/,'');
    if(reels.has(name)){mesh.removeFromParent();continue;}
    if(name!=='Optical_Edges'&&name!=='Internal_Ceramic')continue;
    const g=mesh.geometry,p=g.attributes.position,ix=g.index,kept=[];
    for(let i=0;i<ix.count;i+=3){
      const vertices=[ix.getX(i),ix.getX(i+1),ix.getX(i+2)];
      const internal=name==='Optical_Edges'
        ?vertices.every(v=>p.getY(v)>.8&&p.getY(v)<3.1&&p.getX(v)>-1.5&&p.getX(v)<1.8)
        :vertices.every(v=>p.getZ(v)<0);
      if(!internal)kept.push(...vertices);
    }
    g.setIndex(kept);
  }
}
function fingerprint(mesh){
  const h=crypto.createHash('sha256'),g=mesh.geometry;
  for(const name of Object.keys(g.attributes).sort()){
    const a=g.attributes[name];h.update(name);
    h.update(Buffer.from(new Float64Array(Array.from(a.array)).buffer));
  }
  h.update(Buffer.from(new Uint32Array(Array.from(g.index.array)).buffer));
  return h.digest('hex');
}
export async function verifyArchiveModel(original,prepared){
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex'),'dda42b9b3b471d11c69820a64084d254a64b27761287ab0e35dd8387ec0a0bed','Original reference asset must remain intact');
  const [source,result]=await Promise.all([loadModel(original),loadModel(prepared)]);
  retainEnclosure(source);
  let artwork;result.traverse(node=>{artwork??=node.userData.archiveArtwork;});
  assert.equal(artwork,'index-tracks');
  const actual=new Map();result.traverse(m=>{if(m.isMesh)actual.set(m.name,m);});
  let retained=0;source.traverse(m=>{if(m.isMesh){assert.ok(actual.has(m.name),`Missing original enclosure part: ${m.name}`);assert.equal(fingerprint(actual.get(m.name)),fingerprint(m),`Changed enclosure geometry: ${m.name}`);retained++;}});
  assert.equal(retained,13);
  for(const name of reels)assert.ok(![...actual.values()].some(m=>m.material.name.replace(/\.\d+$/,'')===name&&!m.name.startsWith('Archive_index_tracks_')),'Old reel assembly must be replaced');
}
