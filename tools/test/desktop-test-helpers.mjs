// Test instances only. Exercise the same orderly exit choice as the user.
export async function requestTestExit(application) {
  if (application.process()?.exitCode != null) return;
  const page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window=>window.getOpacity()>0).showInactive());
  await application.evaluate(({ app }) => { app.quit(); }).catch(() => {});
  await page.locator('#desktopClosePanel[open]').waitFor({ timeout: 10000 });
  await page.locator('#closeExit').click();
}
export async function enterTestWorkspace(page) {
  await dismissTestOnboarding(page);
  if (await page.locator('#libraryHome').isVisible()) {
    await page.locator('#libraryHome #enterWorkspace').click();
    await page.locator('#libraryHome').waitFor({ state: 'hidden' });
  }
}
export async function revealTestTools(page) {
  await dismissTestOnboarding(page);
  await enterTestWorkspace(page);
  const tools = page.locator('#workspaceUtilities');
  if (!await tools.evaluate(e => e.open)) await tools.locator(':scope > summary').click();
}
export async function dismissTestOnboarding(page) {
  await page.waitForFunction(() => document.documentElement.dataset.onboardingPending === 'false' || document.getElementById('onboardingPanel')?.open);
  if (await page.locator('#onboardingPanel').evaluate(e => e.open)) await page.locator('#onboardingLater').click();
}
export async function openTestArchive(page) {
  await dismissTestOnboarding(page);
  if (await page.locator('#libraryHome').isVisible()) return;
  await revealTestTools(page); await page.locator('#enterLibrary').click();
}
