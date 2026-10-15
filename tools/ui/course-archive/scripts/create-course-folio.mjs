// Original hard-surface archive cartridge, with an independent geometric core.
import fs from 'node:fs';
import * as THREE from 'three';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob){blob.arrayBuffer().then(result=>{this.result=result;this.onloadend?.();});}
  readAsDataURL(blob){blob.arrayBuffer().then(result=>{this.result=`data:${blob.type};base64,${Buffer.from(result).toString('base64')}`;this.onloadend?.();});}
};
const group=new THREE.Group();group.name='Learning Archive Cartridge';
const materials={
  Frosted_Polymer:new THREE.MeshPhysicalMaterial({color:'#eaf0f2',roughness:.2,transmission:.78,thickness:.12,ior:1.46}),
  Ivory_Edges:new THREE.MeshPhysicalMaterial({color:'#cbd4da',roughness:.3,metalness:.2}),
  Optical_Diffuser:new THREE.MeshStandardMaterial({color:'#bfcbd2',roughness:.6}),
  Index_Inlay:new THREE.MeshStandardMaterial({color:'#6f8996',roughness:.34,metalness:.4}),
  Titanium_Fasteners:new THREE.MeshStandardMaterial({color:'#82929d',roughness:.3,metalness:.7}),
  Optical_Edges:new THREE.MeshPhysicalMaterial({color:'#aab7c0',roughness:.28,metalness:.45}),
  Internal_Ceramic:new THREE.MeshStandardMaterial({color:'#6f828d',roughness:.48,metalness:.25}),
  Course_Insert:new THREE.MeshStandardMaterial({color:'#dce4e8',roughness:.45}),
};for(const [name,mat]of Object.entries(materials))mat.name=name;
function outline(){const s=new THREE.Shape();s.moveTo(-2.35,0);s.lineTo(2.35,0);s.lineTo(2.5,.15);s.lineTo(2.5,3.55);s.lineTo(2.35,3.7);s.lineTo(-2.35,3.7);s.lineTo(-2.5,3.55);s.lineTo(-2.5,.15);s.closePath();return s;}
function add(name,geometry,material){const mesh=new THREE.Mesh(geometry,materials[material]);mesh.name=name;group.add(mesh);return mesh;}
add('Machined rear frame',new THREE.ExtrudeGeometry(outline(),{depth:.075,bevelEnabled:true,bevelSegments:2,steps:1,bevelSize:.025,bevelThickness:.018}).translate(0,0,-.12),'Ivory_Edges');
add('Clear chamfered enclosure',new THREE.ExtrudeGeometry(outline(),{depth:.075,bevelEnabled:true,bevelSegments:3,steps:1,bevelSize:.025,bevelThickness:.025}).translate(0,0,.12),'Frosted_Polymer');
add('Cool internal substrate',new THREE.BoxGeometry(4.5,3.2,.025).translate(0,1.85,-.025),'Optical_Diffuser');
for(const x of [-2.27,2.27])for(const y of [.25,3.45])add('Recessed corner latch',new THREE.BoxGeometry(.23,.1,.17).translate(x,y,.055),'Titanium_Fasteners');
add('Inset index channel',new THREE.BoxGeometry(.9,.065,.035).translate(1.52,3.42,.16),'Index_Inlay');
function coreRing(width,height,cut){const s=new THREE.Shape(),cx=.02,cy=1.65;const points=[[-width/2+cut,-height/2],[width/2-cut,-height/2],[width/2,-height/2+cut],[width/2,height/2-cut],[width/2-cut,height/2],[-width/2+cut,height/2],[-width/2,height/2-cut],[-width/2,-height/2+cut]];s.moveTo(points[0][0]+cx,points[0][1]+cy);for(const [x,y]of points.slice(1))s.lineTo(x+cx,y+cy);s.closePath();return s;}
const ring=coreRing(3.45,1.65,.35),hole=coreRing(3.13,1.33,.27);ring.holes.push(new THREE.Path(hole.getPoints().reverse()));
add('Offset polygonal archive core',new THREE.ExtrudeGeometry(ring,{depth:.04,bevelEnabled:true,bevelSegments:2,bevelSize:.018,bevelThickness:.012}).translate(0,0,.015),'Optical_Edges');
for(let i=0;i<3;i++)add('Stepped storage channel',new THREE.BoxGeometry(1.92-.23*i,.14,.055).translate(.12*i,1.27+.35*i,.025),'Internal_Ceramic');
add('Etched course identifiers',new THREE.PlaneGeometry(4.28,2.78).translate(0,1.85,.108),'Course_Insert');
const bytes=await new GLTFExporter().parseAsync(group,{binary:true,onlyVisible:true});
fs.writeFileSync(process.argv[2],Buffer.from(bytes));
console.log(`Original archive cartridge: ${bytes.byteLength} bytes; authored enclosure and geometric core.`);
