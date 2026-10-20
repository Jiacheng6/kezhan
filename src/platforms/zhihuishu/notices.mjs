import {readZhihuishuPage} from './read-page.mjs';
async function dismissKnownNotice(control) {
  try { await control.click({timeout:1500}); }
  catch (error) {
    if(await control.count()===0||!await control.isVisible())return;
    // The site's fixed-size notice can put its close control outside a small
    // embedded viewport. Activate only the already identified nonbinding control.
    if(await control.count()!==1)throw error;
    await control.evaluate(element=>element.click());
  }
  await control.waitFor({state:'hidden',timeout:3000});
}
/** Dismiss only the two observed nonbinding study notices. Never touch verification. */
export async function dismissZhihuishuNotices(page) {
  const state=await readZhihuishuPage(page),dismissed=[];
  if(state.pageKind!=='study'||state.blockers.includes('human-verification'))return {dismissed,waitingForHuman:state.blockers.includes('human-verification')};
  const reminder=page.locator('.el-dialog__wrapper').filter({hasText:'课程提醒'}).getByText('下次再说',{exact:true});
  if(await reminder.count()===1&&await reminder.isVisible()){await dismissKnownNotice(reminder);dismissed.push('course-reminder');}
  const header=page.locator('.el-dialog__header').filter({has:page.getByRole('heading',{name:'学前必读',exact:true})});
  const close=header.locator('.iconguanbi');
  if(await close.count()===1&&await close.isVisible()){await dismissKnownNotice(close);dismissed.push('learning-guide');}
  return {dismissed,waitingForHuman:false};
}
