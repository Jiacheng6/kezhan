import {deflateSync} from 'node:zlib';
// Deterministic red square for local browser fixtures; no user screenshot.
export function fixturePng(size=8){
 if(!Number.isInteger(size)||size<1||size>1024)throw Error('Invalid fixture size');
 const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
 const chunk=(type,body)=>{const size=Buffer.alloc(4),sum=Buffer.alloc(4),name=Buffer.from(type);size.writeUInt32BE(body.length);sum.writeUInt32BE(crc(Buffer.concat([name,body])));return Buffer.concat([size,name,body,sum]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
 const pixels=Buffer.alloc(size*(1+size*4));for(let y=0;y<size;y++)for(let x=0;x<size;x++){const at=y*(1+size*4)+1+x*4;pixels[at]=201;pixels[at+1]=57;pixels[at+2]=38;pixels[at+3]=255;}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
