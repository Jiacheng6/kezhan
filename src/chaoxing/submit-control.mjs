// A tall work iframe centres its fixed modal outside the outer viewport.
// Use native keyboard activation of the same confirmed button when pointer
// actionability reports that exact clipping failure; never dispatch a JS click.
export async function activateSubmitConfirmation(control,page){
  try{await control.click({timeout:2000});return 'pointer';}
  catch(error){
    if(!/outside (?:of )?(?:the )?viewport/i.test(error.message))throw error;
    const native=await control.evaluate(e=>{
      const visible=e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!!e.getClientRects().length;
      return visible&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&
        (e.tagName==='BUTTON'||(e.tagName==='A'&&e.hasAttribute('href')))&&
        ['popok','popOk'].includes(e.id)&&/提交|交卷/.test((e.closest('.popDiv,.layui-layer,[role="dialog"]')||e.parentElement)?.innerText||'');
    }).catch(()=>false);
    if(!native)throw error;
    const session=await page.context().newCDPSession(page);
    try{
      await session.send('Emulation.setFocusEmulationEnabled',{enabled:true});
      await control.focus({timeout:2000});
      if(!await control.evaluate(e=>document.activeElement===e))throw Error('确认按钮未获得焦点，未提交');
      await control.press('Enter',{timeout:3000});
      return 'keyboard';
    }finally{await session.send('Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});await session.detach().catch(()=>{});}
  }
}
