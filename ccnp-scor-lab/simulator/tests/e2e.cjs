// End-to-end test for the SCOR Lab Simulator. Run: node tests/e2e.js   (needs: npm i playwright)
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html'); const SHOTS = process.env.SHOTS || '';
let pass = 0, fail = 0; const errs = [];
const T = (n, ok, extra) => { if (ok) pass++; else { fail++; console.log('  FAIL:', n, extra || ''); } };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const W = () => p.locator('.win').last(), tasksState = async () => (await p.$$eval('.task', e => e.map(x => x.className.includes('ok') ? 1 : 0)));
  const names = { Outside: 'Outside-Desktop', R2: 'R2', FW1: 'FW1-ASA', R1: 'R1', SW1: 'SW1', Client: 'Client (inside PC)', DMZ: 'DMZ-Server', FTD1: 'FTD1', FTDClient: 'FTD-Client', 'DMZ-SW': 'DMZ-SW', ESA1: 'ESA1', 'MGMT-SW': 'MGMT-SW', FMC1: 'FMC1', ISE1: 'ISE1', WSA1: 'WSA1' };
  const node = k => p.locator(`g.node:has-text("${names[k]}")`).first();
  const rc = async (k, item) => { await node(k).click({ button: 'right' }); await p.locator('.mi', { hasText: item }).first().click(); };
  const closeAll = async () => { for (let i = 0; i < 20; i++) { const c = await p.$$('.win .wx:not(.wm)'); if (!c.length) break; await c[0].click(); } };
  const W_unused = 0;

  // ---- 0. stale saved lab from an old version must not break anything ----
  console.log('0. stale save / fresh start');
  await p.goto(URL); await p.evaluate(() => { localStorage.setItem('scor-sim-v1', JSON.stringify({ ver: 3, dev: { FTD1: {} }, links: [] })); localStorage.setItem('scor-sim-v4', '{"ver":4,"dev":{}}'); });
  await p.reload(); await p.click('button:has-text("Start lab")');
  T('start screen + lab loads', await p.locator('g.node').count() >= 15, 'nodes=' + await p.locator('g.node').count());
  T('old saves removed', await p.evaluate(() => Object.keys(localStorage).filter(k => /^scor-sim-v/.test(k)).length) === 1);

  // ---- 1. every device: right-click menu, action bar, windows, power ----
  console.log('1. every device menu / power');
  for (const k of Object.keys(names)) {
    await node(k).click({ button: 'right' }); const items = await p.$$eval('#ctx .mi', e => e.map(x => x.textContent)); T(k + ' right-click menu has items', items.length >= 3, items.join('|'));
    await p.keyboard.press('Escape'); await p.mouse.click(5, 5);
    // GUI / terminal via menu
    const guiItem = items.find(i => /Open GUI/.test(i)); if (guiItem) { await node(k).click({ button: 'right' }); await p.locator('.mi', { hasText: guiItem }).first().click(); T(k + ' GUI window opens with a product UI', await W().locator('.prod').count() === 1); await closeAll(); }
    const termItem = items.find(i => /Terminal/.test(i)); if (termItem) { await node(k).click({ button: 'right' }); await p.locator('.mi', { hasText: termItem }).first().click(); T(k + ' terminal opens', await W().locator('.tin').count() === 1); await closeAll(); }
    // power via right-click
    await node(k).click({ button: 'right' }); await p.locator('.mi', { hasText: 'Power off' }).click(); T(k + ' power off (menu)', (await node(k).getAttribute('opacity')) === '0.3');
    await node(k).click({ button: 'right' }); await p.locator('.mi', { hasText: 'Power on' }).click(); T(k + ' power on (menu)', (await node(k).getAttribute('opacity')) === '1');
    // power via action bar
    await node(k).click(); await p.locator('#abar button', { hasText: 'Power off' }).click(); T(k + ' power off (action bar)', (await node(k).getAttribute('opacity')) === '0.3');
    await node(k).click(); await p.locator('#abar button', { hasText: 'Power on' }).click(); T(k + ' power on (action bar)', (await node(k).getAttribute('opacity')) === '1');
  }
  await p.locator('#abar button', { hasText: 'Power' }).count();

  // ---- 2. sweep every GUI: every menu/tab/tree node + every button ----
  console.log('2. GUI sweep');
  for (const k of ['FW1', 'R1', 'R2', 'SW1', 'DMZ-SW', 'FTD1', 'FMC1', 'ISE1', 'ESA1', 'WSA1']) {
    await rc(k, 'Open GUI'); const w = W(); const shot = async s => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, k + '-' + s + '.png') }); };
    const mains = await w.locator('.pmenu button').count(); const loops = Math.max(mains, 1);
    for (let mi = 0; mi < loops; mi++) {
      if (mains) await w.locator('.pmenu button').nth(mi).click();
      const nodesN = await w.locator('.tnode').count(), tabsN = await w.locator('.ptabs:not(.inner) button').count(), n = nodesN || tabsN;
      for (let ti = 0; ti < Math.max(n, 1); ti++) {
        if (nodesN) await w.locator('.tnode').nth(ti).click(); else if (tabsN) await w.locator('.ptabs:not(.inner) button').nth(ti).click();
        T(k + ' page renders', await w.locator('.pcontent').count() === 1 && (await w.locator('.pcontent').innerText()).length > 5);
        const bn = await w.locator('.pcontent button.pb').count(); for (let bi = 0; bi < bn; bi++) { const btns = w.locator('.pcontent button.pb'); if (bi >= await btns.count()) break; const t = await btns.nth(bi).innerText(); if (/Delete|Clear/.test(t)) continue; await btns.nth(bi).click({ timeout: 2000 }).catch(() => { }); }
      }
      if (mi === 0) await shot('main');
    }
    await closeAll();
  }

  // ---- 3. reset, then complete every lab task through the GUIs ----
  console.log('3. lab tasks via GUIs');
  await p.click('#reset'); p.once('dialog', d => d.accept()); await p.click('#reset').catch(() => { }); await p.waitForTimeout(300);
  if (await p.$('button:has-text("Start lab")')) await p.click('button:has-text("Start lab")');
  const tabs = async (t) => { const w = W(); const a = w.locator(`.ptabs button:text-is("${t}")`); if (await a.count()) await a.first().click(); else await w.locator(`.tnode:text-is("${t}")`).first().click(); };
  const menu = async (t) => W().locator(`.pmenu button:text-is("${t}")`).click();
  const btn = async (t, n = 0) => W().locator(`button:text-is("${t}")`).nth(n).click();
  // T9 SW1 + ISE + Client login
  await rc('SW1', 'Open GUI'); await W().locator('.tnode:text-is("802.1X / RADIUS")').click(); await W().locator('input[placeholder="shared secret"]').fill('cisco123');
  await W().locator('label:has-text("aaa new-model") input').evaluate(e => e.click()); await W().locator('label:has-text("dot1x system-auth-control") input').evaluate(e => e.click()); await btn('Apply');
  await W().locator('.tnode:text-is("Switch Ports")').click(); await W().locator('.prow select').first().selectOption('Gi0/2'); await W().locator('label:has-text("802.1X") input').evaluate(e => e.click()); await btn('Apply'); await closeAll();
  await rc('ISE1', 'Open GUI'); await menu('Administration'); await tabs('Network Devices'); await W().locator('input[placeholder="shared secret"]').fill('cisco123'); await btn('Submit'); await closeAll();
  await rc('Client', '802.1X'); await W().locator('button:has-text("Log on (802.1X)")').click(); await closeAll();
  T('task 9 (802.1X)', (await tasksState())[8] === 1, JSON.stringify(await tasksState()));
  // T10 contractors
  await rc('ISE1', 'Open GUI'); await menu('Policy'); await tabs('Authorization'); const sels = await W().locator('.pcontent table select').all(); await sels[1].selectOption('Contractor-Web'); await closeAll();
  T('task 10 (dACL)', (await tasksState())[9] === 1);
  // T3/T4 + T11 via ASDM
  await rc('FW1', 'Open GUI'); await menu('Configuration'); await W().locator('.tnode:text-is("Firewall > NAT Rules")').click();
  await W().locator('input[placeholder="real host"]').fill('172.16.1.10'); await W().locator('input[placeholder="mapped IP"]').fill('203.0.113.10'); await btn('Add', 0);
  await W().locator('input[placeholder="real host"]').fill('172.16.1.20'); await W().locator('input[placeholder="mapped IP"]').fill('203.0.113.20'); await btn('Add', 0);
  await W().locator('.tnode:text-is("Firewall > Access Rules")').click(); await W().locator('input[placeholder="destination"]').fill('172.16.1.10'); await W().locator('input[placeholder="port"]').fill('80'); await btn('Add', 0);
  await W().locator('input[placeholder="destination"]').fill('172.16.1.20'); await W().locator('input[placeholder="port"]').fill('25'); await btn('Add', 0); await closeAll();
  const ts = await tasksState(); T('task 3 (publish web)', ts[2] === 1, JSON.stringify(ts)); T('task 4 (least privilege)', ts[3] === 1); T('task 11 (publish smtp)', ts[10] === 1);
  // T5 router ACL
  await rc('R1', 'Open GUI'); await W().locator('.tnode:text-is("Access Lists (ACL)")').click(); await W().locator('input[placeholder="ACL name"]').fill('BLOCK-WEB'); await W().locator('input[placeholder="destination"]').fill('172.16.1.10'); await W().locator('input[placeholder="port"]').fill('80');
  let selsA = await W().locator('.pcontent .prow select').all(); await selsA[0].selectOption('deny'); await selsA[selsA.length - 2].selectOption('Gi0/2'); await btn('Add');
  await W().locator('input[placeholder="ACL name"]').fill('BLOCK-WEB'); selsA = await W().locator('.pcontent .prow select').all(); await selsA[0].selectOption('permit'); await selsA[1].selectOption('ip'); await selsA[2].selectOption('any'); await selsA[3].selectOption('any'); await W().locator('input[placeholder="port"]').fill(''); await btn('Add'); await closeAll();
  T('task 5 (router ACL)', (await tasksState())[4] === 1, JSON.stringify(await tasksState()));
  // T6/T7/T8 via FMC with Deploy
  await rc('FTD1', 'Open GUI'); await menu('Policies'); await W().locator('input[placeholder="name"]').fill('Block-SSH'); await W().locator('input[placeholder="port"]').fill('22');
  const fs_ = await W().locator('.pcontent .prow select').all(); const nf=fs_.length; await fs_[nf-3].selectOption('tcp'); await fs_[nf-2].selectOption('block'); await fs_[nf-1].selectOption('top'); await btn('Add Rule');
  await W().locator('.pcontent table input[type=checkbox]').nth(1).evaluate(e => e.click());
  await W().locator('input[placeholder="name"]').fill('Allow-Web-In'); await W().locator('input[placeholder="src zone"]').fill('OUT'); await W().locator('input[placeholder="dst zone"]').fill('IN'); await W().locator('input[placeholder="dst network"]').fill('10.2.1.10'); await W().locator('input[placeholder="port"]').fill('80');
  const fs2 = await W().locator('.pcontent .prow select').all(); const n2=fs2.length; await fs2[n2-3].selectOption('tcp'); await fs2[n2-2].selectOption('allow'); await fs2[n2-1].selectOption('bottom'); await btn('Add Rule');
  T('FMC pending before deploy (task 6 not yet)', (await tasksState())[5] === 0); await W().locator('.deploybtn').click(); await btn('Deploy'); await closeAll();
  const t3 = await tasksState(); T('task 6 (FTD block ssh)', t3[5] === 1, JSON.stringify(t3)); T('task 7 (publish ftd-client web)', t3[6] === 1); T('task 8 (IPS)', t3[7] === 1);
  // T12/T13 ESA with Commit
  await rc('ESA1', 'Open GUI'); await menu('Mail Policies'); await tabs('Incoming Content Filters'); await btn('Add'); await tabs('Incoming Mail Policies'); await W().locator('.pcontent select').nth(1).selectOption('reject'); await btn('Submit');
  T('ESA edits are staged (not active before commit)', (await tasksState())[11] === 0 && (await tasksState())[12] === 0); await W().locator('.commitbtn').click(); await btn('Commit Changes'); await closeAll();
  const t4 = await tasksState(); T('task 12 (ESA drop exe)', t4[11] === 1, JSON.stringify(t4)); T('task 13 (ESA SPF reject)', t4[12] === 1);
  // T14/T15 WSA with Commit
  await rc('WSA1', 'Open GUI'); await menu('Web Security Manager'); await tabs('Access Policies'); await W().locator('.pcontent table select').first().selectOption('block'); await menu('Security Services'); await tabs('HTTPS Proxy'); await W().locator('.pcontent input[type=checkbox]').first().evaluate(e => e.click());
  T('WSA edits are staged', (await tasksState())[13] === 0); await W().locator('.commitbtn').click(); await btn('Commit Changes'); await closeAll();
  const t5 = await tasksState(); T('task 14 (WSA block social)', t5[13] === 1, JSON.stringify(t5)); T('task 15 (WSA https decrypt)', t5[14] === 1);
  console.log('   tasks:', (await tasksState()).join(''));

  // ---- 4. built-in self-test button ----
  console.log('4. built-in self-test');
  await p.click('#selftest'); await p.waitForSelector('.stlist'); const title = await p.locator('.mbox h2').innerText(); T('self-test passes on this browser', /all \d+ checks passed/.test(title), title);
  T('no uncaught page errors', errs.length === 0, errs.slice(0, 4).join(' || '));
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASH:', e.message.split('\n')[0], '\n', (e.stack.split('\n').find(l => /e2e.cjs/.test(l)) || '')); process.exit(2); });
