// Manual smoke check for the robot harness.
//   node tests/harness/smoke.mjs
import { PlaytestTable } from './harness.js';

const table = await PlaytestTable.open();
try {
  const alice = await table.seat('Alice');
  await alice.goto('index.html');
  await alice.page.waitForTimeout(2500);

  const title = await alice.page.title();
  const bodyVisible = await alice.page.evaluate(() => document.body.style.opacity);
  const bootFailed = await alice.page.evaluate(() =>
    !!document.body.textContent.match(/Connection issue|Failed to load/i));

  console.log('page title      :', title);
  console.log('body opacity    :', bodyVisible || '(unset)');
  console.log('boot error shown:', bootFailed);
  console.log('open channels   :', await alice.openChannelCount());
  console.log('console errors  :', alice.consoleErrors.length);
  for (const e of alice.consoleErrors.slice(0, 8)) console.log('   !', e.slice(0, 160));

  const visibleText = await alice.page.evaluate(() =>
    (document.body.innerText || '').trim().split('\n').filter(Boolean).slice(0, 8));
  console.log('visible text    :', visibleText);
} finally {
  await table.close();
}
