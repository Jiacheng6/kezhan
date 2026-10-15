import * as THREE from 'three';

/** Opening status overlay; the original cassette artwork is left intact. */
export class ArchiveScanner {
  readonly scanner = new THREE.Mesh(
    new THREE.PlaneGeometry(.018, 2.25),
    new THREE.MeshBasicMaterial({color:'#91a0a3',transparent:true,opacity:0,depthWrite:false,toneMapped:false}),
  );
  constructor(){
    this.scanner.position.set(-2.08,1.43,.265);
    this.scanner.userData.courseArtwork=true;
    this.scanner.userData.excludeFromAO=true;
    this.scanner.visible=false;
  }
  scan(progress:number){
    this.scanner.visible=progress>0&&progress<1;
    this.scanner.position.x=-2.08+4.16*progress;
    this.scanner.material.opacity=Math.sin(Math.PI*progress)*.85;
  }
}
