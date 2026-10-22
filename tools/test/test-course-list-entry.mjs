// Local replicas of personal-space navigation and its cross-origin course iframe.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium}from 'playwright-core';
fs.mkdirSync('.desktop-test',{recursive:true});process.env.XXT_DATA_DIR=fs.mkdtempSync(path.resolve('.desktop-test/course-entry-'));
const {findEdge}=await import('../../src/browser/launch.mjs');const {listCourses}=await import('../../src/chaoxing/recon.mjs');
const b=await chromium.launch({executablePath:findEdge(),headless:true});let mode='new',allClicks=0;
const card='<div class="course clearfix learnCourse" id="c_demo" info="class_demo_student_demo"><input class="courseId" value="course-demo"><input class="clazzId" value="class-demo"><input class="curPersonId" value="student-demo"><p class="course-name" title="示例课程">示例课程</p><div class="btm-cover"><span class="l-txt">2/3</span></div></div>';
try{
 const ctx=await b.newContext();await ctx.exposeBinding('fixtureAllClicked',()=>{allClicks++});
 await ctx.route('https://i.chaoxing.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:mode==='missing'?'<h1>个人空间</h1>':mode==='old'?'<button class="label-item" onclick="document.querySelector(\'iframe\').src=\'https://mooc2-ans.chaoxing.com/visit/interaction\'">全部课程</button><iframe></iframe>':'<ul class="menu-list-ul"><li onclick="document.querySelector(\'iframe\').src=\'https://mooc2-ans.chaoxing.com/visit/interaction\'"><h3>课程</h3></li></ul><iframe></iframe>'}));
 await ctx.route('https://mooc2-ans.chaoxing.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<a href="javascript:void(0)" onclick="window.fixtureAllClicked();document.querySelector('#cards').innerHTML=document.querySelector('template').innerHTML">全部课程</a><div id="cards">${mode==='ready'?card:''}</div><template>${card}</template>`}));
 const p=await ctx.newPage();const options={initialWaitMs:30,timeoutMs:4000,pollMs:30};
 await p.goto('https://i.chaoxing.com/base');let result=await listCourses(p,options);assert.equal(result.length,1);assert.equal(result[0].courseId,'course-demo');assert.equal(result[0].clazzId,'class-demo');assert.equal(allClicks,1,'新版外层课程、内层全部课程只激活一次');
 const before=allClicks;result=await listCourses(p,options);assert.equal(result.length,1);assert.equal(allClicks,before,'已加载的课程列表纯读取，不重复导航');
 mode='old';await p.goto('https://i.chaoxing.com/base');result=await listCourses(p,options);assert.equal(result.length,1,'旧版全部课程标签仍兼容');
 mode='missing';await p.goto('https://i.chaoxing.com/base');await assert.rejects(listCourses(p,{...options,timeoutMs:100}),/找不到课程列表/,'加载失败不能返回空列表覆盖已有课程');
 await assert.rejects(listCourses(p,{...options,shouldStop:()=>true}),e=>e.code==='STOPPED');
 await p.close();await assert.rejects(listCourses(p,options),/页面已关闭/);
 console.log('✓ 学习通新版课程导航、跨域 iframe 全部课程、旧版标签、已加载纯读取、停止与空清单保护');
}finally{await b.close();}
