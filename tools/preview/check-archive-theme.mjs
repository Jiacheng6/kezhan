import fs from 'node:fs';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';
import {enterTestWorkspace,openTestArchive} from '../test/desktop-test-helpers.mjs';
const meta=JSON.parse(fs.readFileSync('.desktop-test/design-preview-current.json','utf8'));assert.match(meta.data,/design-preview-/);
const b=await chromium.connectOverCDP(`http://127.0.0.1:${meta.cdpPort}`);
const p=b.contexts().flatMap(c=>c.pages()).find(p=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url()));
const out='.desktop-test/archive-accent-1103';fs.mkdirSync(out,{recursive:true});const errors=[];p.on('pageerror',e=>errors.push(e.message));
try{
await p.reload();await enterTestWorkspace(p);
for(const accent of ['blue','pink']) {
 await p.locator('[data-tab=settings]').click();
 if(await p.locator('html').getAttribute('data-mode')!=='light')await p.locator('#modeToggle').click();
 await p.locator(`.theme-accent[data-accent=${accent}]`).click();
 await openTestArchive(p);
 await p.waitForFunction(()=>document.querySelector('#libraryHome')?.shadowRoot?.querySelector('iframe')?.contentWindow?.courseArchive?.snapshot().ready,null,{timeout:60000});
 const f=p.frames().find(f=>f.url().includes('/library/archive/'));
 await f.waitForFunction(()=>window.courseArchive?.snapshot().ready && window.courseArchive.snapshot().theme.materialAmount===0,null,{timeout:60000});
 assert.equal(await f.locator('html').getAttribute('data-accent'),accent);
 await p.waitForTimeout(550);
 await p.screenshot({path:`${out}/light-${accent}.png`});
 await p.locator('#libraryHome #enterWorkspace').click();
 await p.locator('#libraryHome').waitFor({state:'hidden'});
}
await openTestArchive(p);let f=p.frames().find(f=>f.url().includes('/library/archive/'));
await p.waitForTimeout(350);
await p.locator('#libraryHome button').filter({hasText:'切换日夜'}).click();
await f.waitForFunction(()=>window.courseArchive.snapshot().theme.materialAmount===1);
await p.screenshot({path:`${out}/dark-pink.png`});
await p.locator('#libraryHome button').filter({hasText:'切换日夜'}).click();
await f.waitForFunction(()=>window.courseArchive.snapshot().theme.materialAmount===0);
await p.screenshot({path:`${out}/returned-light-pink.png`});
assert.deepEqual(errors,[]);console.log(JSON.stringify({daylightMaterial:0,darkMaterial:1,dayNightRoundTrip:true,accents:['blue','pink'],errors}));
}finally{await b.close();}
