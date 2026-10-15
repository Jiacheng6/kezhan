// Replace the two optical reels while preserving the original enclosure.
import fs from 'node:fs';
import * as THREE from 'three';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {loadModel, retainEnclosure, verifyArchiveModel} from './verify-model.mjs';
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob){blob.arrayBuffer().then(result=>{this.result=result;this.onloadend?.();});}
  readAsDataURL(blob){blob.arrayBuffer().then(result=>{this.result=`data:${blob.type};base64,${Buffer.from(result).toString('base64')}`;this.onloadend?.();});}
};
const [input,output]=process.argv.slice(2);
const scene=await loadModel(input),materials=new Map();
scene.traverse(mesh=>{if(mesh.isMesh)materials.set(mesh.material.name.replace(/\.\d+$/,''),mesh.material);});
retainEnclosure(scene);
const parts=new Map();
function add(geometry,material){
  const list=parts.get(material)||[];list.push(geometry.index?geometry.toNonIndexed():geometry);parts.set(material,list);
}
function block(x,y,w,h,z,depth,material){add(new THREE.BoxGeometry(w,h,depth).translate(x,y,z),material);}
function outline(cx,cy,w,h,cut){
  return [[-w/2+cut,-h/2],[w/2-cut,-h/2],[w/2,-h/2+cut],[w/2,h/2-cut],[w/2-cut,h/2],[-w/2+cut,h/2],[-w/2,h/2-cut],[-w/2,-h/2+cut]].map(([x,y])=>new THREE.Vector2(x+cx,y+cy));
}
function rail(cx,cy,w,h,cut,thick,z,material){
  const shape=new THREE.Shape(outline(cx,cy,w,h,cut));
  shape.holes.push(new THREE.Path(outline(cx,cy,w-2*thick,h-2*thick,Math.max(.025,cut-thick*.6)).reverse()));
  add(new THREE.ExtrudeGeometry(shape,{depth:.035,bevelEnabled:true,bevelSize:.009,bevelThickness:.007,bevelSegments:2,steps:1}).translate(0,0,z),material);
}
function trace(points,width,z,material){
  for(let i=1;i<points.length;i++){
    const [a,b]=[points[i-1],points[i]],dx=b[0]-a[0],dy=b[1]-a[1];
    add(new THREE.BoxGeometry(Math.hypot(dx,dy),width,.025).rotateZ(Math.atan2(dy,dx)).translate((a[0]+b[0])/2,(a[1]+b[1])/2,z),material);
  }
}
// Stepped chamfered rails: visible physical depth, no flat printed insert.
rail(-.43,1.64,2.82,1.64,.33,.09,-.008,'Subsurface_Optics');
rail(-.37,1.7,2.53,1.35,.27,.055,.047,'Optical_Edges');
rail(-.31,1.76,2.19,1.01,.21,.035,.094,'Optical_Film_Edge');
rail(1.32,2.63,.77,.62,.13,.065,.025,'Optical_Edges');
for(let i=0;i<4;i++)block(1.1+i*.145,2.63,.055,.25,.103,.032,'Subsurface_Optics');
trace([[.24,2.3],[.54,2.6],[.87,2.6]],.035,.086,'Optical_Film_Edge');
trace([[.44,2.26],[.69,2.5],[.87,2.5]],.022,.035,'Subsurface_Optics');
for(let i=0;i<5;i++)block(-.96+i*.27,1.76,.11,.30+(i%3)*.09,.062,.045,'Subsurface_Optics');
block(-1.59,1.64,.035,.37,.112,.026,'Amber_Optical_Inlay');
for(let i=0;i<6;i++)block(.51+i*.105,.93,.05,.10,.055,.03,'Optical_Edges');
for(const [material,geometries]of parts){
  const mesh=new THREE.Mesh(mergeGeometries(geometries),materials.get(material));
  mesh.name=`Archive index tracks ${material}`;scene.add(mesh);
}
scene.userData.archiveArtwork='index-tracks';
fs.writeFileSync(output,Buffer.from(await new GLTFExporter().parseAsync(scene,{binary:true,onlyVisible:true})));
await verifyArchiveModel(input,output);
console.log(`Archive index tracks prepared: ${fs.statSync(output).size} bytes; original enclosure verified.`);
