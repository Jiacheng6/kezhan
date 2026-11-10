/**
 * U校园 AI 版：扫描（课程 → 教程 → 必修节点），写入平台清单。
 *
 * 与学习通/智慧树的扫描保持一致的三件事：
 *   1) 只读：不进入学习、不上报进度；
 *   2) 断点续跑：已完成数量写进 taskPoints.finished；
 *   3) 只更新"这次真读到的"课程，读不到就保留旧数据（见 catalog.mjs）。
 */
import { log } from '../../logbus.mjs';
import { throwIfStopped, interruptibleSleep } from '../../control.mjs';
import { savePlatformCourses } from '../catalog.mjs';
import { readStudentCourses, readStrategy, readTutorialDetail } from './api.mjs';
import { buildTaskPoints, summarizeTutorial, ucampusTaskKey } from './policy.mjs';
import {ucampusContext} from './context.mjs';

const UAI_URL = 'https://uai.unipus.cn/portal';
const PLAYER_HOST = 'https://ucontent.unipus.cn';

/**
 * 打开/复用一个 uai 页面。
 * 注意：不用嵌入式视图，直接走 context 里的普通标签页（与其它平台一致）。
 */
export async function ensureUcampusPage(context, { create = true } = {}) {
  context=ucampusContext(context);
  let page = context.pages().find((p) => !p.isClosed() && /^https:\/\/uai\.unipus\.cn\//.test(p.url()));
  if (!page && create) {
    page = await context.newPage();
    await page.goto(UAI_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  return page || null;
}

/**
 * 扫描 U校园 全部课程与教程，返回与其它平台一致的 course 结构。
 *
 * @param {{context:Function, shouldStop?:Function, onProgress?:Function}} ctx
 */
export async function scanUcampusCourses({ context, shouldStop = () => false, onProgress = () => {} } = {}) {
  throwIfStopped(shouldStop);
  const page = await ensureUcampusPage(context);
  if (!page) throw new Error('打不开 U校园 页面');
  if (!/uai\.unipus\.cn/.test(page.url())) {
    await page.goto(UAI_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
  }

  onProgress({ phase: 'courses', detail: '读取课程与教程' });
  const courseList = await readStudentCourses(page, { shouldStop });
  log(`U校园：读到 ${courseList.length} 门课程`, 'info');

  const courses = [];
  for (const course of courseList) {
    throwIfStopped(shouldStop);
    const tutorials = course.courseResourceList || [];
    const taskPoints = [];
    const sections = [];

    for (const tutorial of tutorials) {
      const progress = summarizeTutorial(tutorial);
      if (!tutorial.totalPointNum) {
        log(`   教程「${tutorial.name}」未激活或暂无任务，跳过明细`, 'info');
        sections.push({
          knowledgeId: `ucampus-tutorial:${tutorial.id}`,
          secNo: '—',
          name: tutorial.name,
          taskCount: 0,
          note: '未激活',
        });
        continue;
      }

      onProgress({ phase: 'strategy', detail: `读取「${tutorial.name}」必修节点` });
      let units = [];
      try {
        units = await readStrategy(page, { strategyId: tutorial.strategyId, courseResourceId: tutorial.id }, { shouldStop });
      } catch (error) {
        log(`   教程「${tutorial.name}」策略读取失败：${error.message}`, 'warn');
      }
      await interruptibleSleep(200, shouldStop);

      /*
       * 已知完成情况：平台接口只给"完成个数"，不能按顺序推断前 N 个已完成。
       * 改成读**教程页目录树的真实状态**（每个必修项都写着 已完成/未开始），
       * 这样已完成的节点会被标记 finished，批量执行就不会重复作答。
       */
      let statuses = {};
      try {
        statuses = await readRequiredStatuses({ context, units, shouldStop, courseResourceId: String(tutorial.id) });
      } catch (error) {
        log(`   教程「${tutorial.name}」节点状态读取失败：${error.message}`, 'warn');
      }
      const points = applyRequiredStatuses(buildTaskPoints({ tutorial, units, progress: {} }), statuses);
      const doneCount = points.filter((p) => p.finished).length;
      if (doneCount) log(`   已识别 ${doneCount}/${points.length} 个必修节点为已完成`, 'info');

      // 播放器地址（续学入口）：执行器用它打开跨域播放器
      let studyUrl = '';
      try {
        const detail = await readTutorialDetail(page, tutorial, course, { shouldStop });
        const rel = detail?.continueStudyData?.url || '';
        if (rel) studyUrl = rel.startsWith('http') ? rel : PLAYER_HOST + rel;
      } catch (error) {
        log(`   教程「${tutorial.name}」续学地址读取失败：${error.message}`, 'warn');
      }
      for (const point of points) point.studyUrl = studyUrl;

      taskPoints.push(...points);
      for (const [i, unit] of units.entries()) {
        sections.push({
          knowledgeId: `ucampus-unit:${tutorial.id}:${i + 1}`,
          secNo: `U${i + 1}`,
          name: `${tutorial.name} · ${unit.unitName}`,
          taskCount: (unit.requiredTask || []).length,
        });
      }
      log(`   教程「${tutorial.name}」：${progress.label}（${progress.percent}%），必修节点 ${points.length} 个`, 'info');
    }

    if (!taskPoints.length) continue;
    courses.push({
      platform: 'ucampus',
      // 课程用平台自己的 id，教程作为 section 挂在下面
      courseId: `ucampus:${course.id}:${course.classId}`,
      clazzId: String(course.classId || ''),
      name: course.name,
      studyUrl: UAI_URL,
      sectionTreeKnown: true,
      sections,
      taskPoints: taskPoints.map((p) => ({
        ...p,
        platformTaskKey: p.platformTaskKey,
        courseResourceId: p.courseResourceId,
      })),
    });
  }

  if (courses.length) savePlatformCourses('ucampus', courses);
  log(`U校园：扫描完成，${courses.length} 门课程、${courses.reduce((n, c) => n + c.taskPoints.length, 0)} 个必修节点`, 'ok');
  return { courses, at: new Date().toISOString() };
}

/** 读一个教程的最新进度（执行完一个节点后用它判断平台是否记账） */
/**
 * 读教程页目录树里每个单元的必修状态（已完成/未开始）。
 *
 * 手风琴式：一次只展开一个单元，所以要逐单元点开再读。
 * 返回 { 'Unit 1': ['已完成', '未开始', ...] }，顺序与 unit.requiredTask 一致。
 */
export async function readRequiredStatuses({ context, units = [], shouldStop = () => false, courseResourceId = '', unitIndex=null }) {
  /*
   * 状态必须从**这门教程自己的目录树**读（不同教程的必修项完全不同）。
   * 所以这里单开一个教程详情页，读完就关，不影响主页面。
   */
  const browserContext = ucampusContext(context);
  let page = null;
  let temp = null;
  try {
  if (courseResourceId) {
    if(!/^\d+$/.test(String(courseResourceId)))throw new Error('U校园教程标识无效');
    temp = await browserContext.newPage();
    await temp.goto(`https://uai.unipus.cn/app/cmgt/resource-detail/${courseResourceId}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await interruptibleSleep(6000,shouldStop);
    page = temp;
  } else {
    page = await ensureUcampusPage(browserContext);
  }
  const out = {};
  const unitNames = [];
  if(Number.isInteger(unitIndex)&&unitIndex>0&&unitIndex<=200)unitNames.push(`Unit ${unitIndex}`);
  else for (const [i] of (units || []).entries()) unitNames.push(`Unit ${i + 1}`);

  for (const unitName of unitNames) {
    throwIfStopped(shouldStop);
    const selected=await page.evaluate((name) => {
      const el = [...document.querySelectorAll('[class*="unitTabItemContainer"], [class*="unitName"]')].find(
        (n) => (n.innerText || '').trim() === name && n.getClientRects().length && n.children.length <= 2,
      );
      if (!el)return false;
      el.click();return true;
    }, unitName);
    if(!selected)continue;
    await interruptibleSleep(1800,shouldStop);
    const rows = await readRequiredRows(page);
    out[unitName] = rows;
  }
  return out;
  } finally {
    if (temp && !temp.isClosed()) await temp.close().catch(() => {});
  }
}

export async function readRequiredRows(page){
  return page.evaluate(() => {
      const containers = [...document.querySelectorAll('[class*="taskNameContainer"]')].filter((el) => el.getClientRects().length&&!el.querySelector('[class*="taskNameContainer"]'));
      const out = [];
      for (const el of containers) {
        const required = !!el.querySelector('[class*="taskRequireIcon"]') || /必修/.test(el.innerText || '');
        if (!required) continue;
        // Only the same task row can supply its status; an ancestor can also
        // contain neighbouring completed tasks. Same-name rows are distinct.
        const row=el.closest('[class*="taskItemInnerLayout"]')||el.parentElement;
        const status=(row?.querySelector('[class*="nodePassStateTip"]')?.innerText||'').trim();
        out.push({ name: (el.innerText || '').replace(/必修|选修/g, '').trim(), status });
      }
      return out;
    });
}

/** 把状态映射回 taskPoints（按单元内顺序） */
export function applyRequiredStatuses(taskPoints = [], statuses = {}) {
  for (const point of taskPoints) {
    const rows = statuses[`Unit ${point.unitIndex || 1}`] || [];
    const expectedCount=taskPoints.filter(p=>p.unitIndex===point.unitIndex&&p.courseResourceId===point.courseResourceId).length;
    const verdict=requiredNodeVerdict(point,rows,{expectedCount});
    if(verdict)point.finished=verdict.finished;
  }
  return taskPoints;
}

export async function readRequiredNodeStatus({context,task,shouldStop=()=>false}){
 if(!requiredNodeNames[task.type]||!task.courseResourceId||!task.unitIndex||!task.nodeIndex)return null;
 const statuses=await readRequiredStatuses({context,courseResourceId:String(task.courseResourceId),unitIndex:Number(task.unitIndex),shouldStop});
 return requiredNodeVerdict(task,statuses[`Unit ${task.unitIndex}`]||[]);
}

const requiredNodeNames={'vocab-cards':'Vocabulary','video-quiz':'Quiz',review:'Review & check','unit-vocab':'Vocabulary','unit-cloze':'Banked cloze','unit-reading':'Reading','unit-translation':'Translation'};
export function requiredNodeVerdict(task,rows,{expectedCount=7}={}){
 const row=rows[Number(task.nodeIndex)-1],name=requiredNodeNames[task.type];
 if(rows.length!==expectedCount||!row||name&&String(row.name||'').replace(/\s/g,'')!==name.replace(/\s/g,''))return null;
 if(!['已完成','未开始','进行中','学习中','待完成'].includes(row.status))return null;
 return {finished:row.status==='已完成',source:'native-required-node'};
}

export async function readTutorialProgress({ context, courseResourceId, shouldStop = () => false }) {
  const page = await ensureUcampusPage(context);
  const courseList = await readStudentCourses(page, { shouldStop });
  for (const course of courseList) {
    for (const tutorial of course.courseResourceList || []) {
      if (String(tutorial.id) === String(courseResourceId)) return tutorial;
    }
  }
  return null;
}

export { ucampusTaskKey };
