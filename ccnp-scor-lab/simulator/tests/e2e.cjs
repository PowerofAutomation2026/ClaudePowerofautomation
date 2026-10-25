// End-to-end test for the SCOR Lab Simulator. Run: node tests/e2e.cjs   (needs: npm i playwright)
const { chromium } = require('playwright'); const path = require('path');
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html'); const SHOTS = process.env.SHOTS || '';
let pass = 0, fail = 0; const errs = [];
const T = (n, ok, extra) => { if (ok) pass++; else { fail++; console.log('  FAIL:', n, extra || ''); } };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  const W = () => p.locator('.win').last(), ts = async () => (await p.$$eval('.task', e => e.map(x => x.className.includes('ok') ? 1 : 0)));
  const names = { Outside: 'Outside-Desktop', R2: 'R2', FW1: 'FW1-ASA', R1: 'R1', SW1: 'SW1', Client: 'Client (inside PC)', DMZ: 'DMZ-Server', FTD1: 'FTD1', FTDClient: 'FTD-Client', 'DMZ-SW': 'DMZ-SW', ESA1: 'ESA1', 'MGMT-SW': 'MGMT-SW', FMC1: 'FMC1', ISE1: 'ISE1', WSA1: 'WSA1', UMB: 'Cisco Umbrella (cloud)', SEP: 'Secure Endpoint (cloud)', AWS: 'AWS Cloud', AZURE: 'Azure Cloud', GCP: 'GCP Cloud' };
  const node = k => p.locator(`g.node:has-text("${names[k]}")`).first();
  const closeAll = async () => { for (let i = 0; i < 25; i++) { const c = await p.$$('.win .wx:not(.wm)'); if (!c.length) break; await c[0].click(); } };
  const gui = async k => { await node(k).click(); await p.locator('#abar button', { hasText: 'Open GUI' }).click(); };
  const rc = async (k, item) => { await node(k).click({ button: 'right' }); await p.locator('.mi', { hasText: item }).first().click(); };
  const menu = async t => { const l = W().locator(`.pmenu button:text-is("${t}")`); if (await l.count()) await l.first().click(); };
  const page = async t => { const w = W(), a = w.locator(`.ptabs:not(.inner) button:text-is("${t}")`); if (await a.count()) await a.first().click(); else await w.locator(`.tnode:text-is("${t}")`).first().click(); };
  const btn = async (t, n = 0) => W().locator(`button:text-is("${t}")`).nth(n).click();
  const fill = async (ph, v, n = 0) => W().locator(`input[placeholder="${ph}"]`).nth(n).fill(v);
  const tick = async (loc) => loc.evaluate(e => e.click());

  console.log('0. stale save / fresh start');
  await p.goto(URL); await p.evaluate(() => { localStorage.setItem('scor-sim-v1', JSON.stringify({ ver: 3, dev: { FTD1: {} }, links: [] })); localStorage.setItem('scor-sim-v4', '{"ver":4,"dev":{}}'); localStorage.setItem('scor-sim-v5', '{"ver":5,"dev":{}}'); });
  await p.reload(); await p.click('button:has-text("Start lab")');
  T('lab loads with all devices', await p.locator('g.node').count() >= 15);
  T('old saves removed', await p.evaluate(() => Object.keys(localStorage).filter(k => /^scor-sim-v/.test(k)).length) === 1);

  console.log('1. every device: menu, action bar, GUI, terminal, power');
  for (const k of Object.keys(names)) {
    await node(k).click({ button: 'right' }); const items = await p.$$eval('#ctx .mi', e => e.map(x => x.textContent)); T(k + ' menu', items.length >= 3, items.join('|')); await p.mouse.click(5, 5);
    const gi = items.find(i => /Open GUI/.test(i)); if (gi) { await rc(k, gi); T(k + ' GUI opens', await W().locator('.prod').count() === 1); await closeAll(); }
    const ti = items.find(i => /Terminal/.test(i)); if (ti) { await rc(k, ti); T(k + ' terminal', await W().locator('.tin').count() === 1); await closeAll(); }
    await rc(k, 'Power off'); T(k + ' power off (menu)', (await node(k).getAttribute('opacity')) === '0.3'); await rc(k, 'Power on'); T(k + ' power on (menu)', (await node(k).getAttribute('opacity')) === '1');
    await node(k).click(); await p.locator('#abar button', { hasText: 'Power off' }).click(); T(k + ' power off (bar)', (await node(k).getAttribute('opacity')) === '0.3'); await node(k).click(); await p.locator('#abar button', { hasText: 'Power on' }).click(); T(k + ' power on (bar)', (await node(k).getAttribute('opacity')) === '1');
  }

  console.log('2. GUI sweep (every page, every button)');
  let pages = 0;
  for (const k of ['FW1', 'R1', 'R2', 'SW1', 'DMZ-SW', 'MGMT-SW', 'FTD1', 'FMC1', 'ISE1', 'ESA1', 'WSA1', 'UMB', 'SEP', 'AWS', 'AZURE', 'GCP']) {
    await gui(k); const w = W(), mains = await w.locator('.pmenu button').count();
    for (let mi = 0; mi < Math.max(mains, 1); mi++) {
      if (mains) await w.locator('.pmenu button').nth(mi).click(); const nN = await w.locator('.tnode').count(), tN = await w.locator('.ptabs:not(.inner) button').count();
      for (let ti = 0; ti < Math.max(nN || tN, 1); ti++) {
        if (nN) await w.locator('.tnode').nth(ti).click(); else if (tN) await w.locator('.ptabs:not(.inner) button').nth(ti).click(); pages++;
        T(k + ' page renders', await w.locator('.pcontent').count() === 1 && (await w.locator('.pcontent').innerText()).length > 5);
        const bn = await w.locator('.pcontent button.pb').count(); for (let bi = 0; bi < bn; bi++) { const bs = w.locator('.pcontent button.pb'); if (bi >= await bs.count()) break; const t = await bs.nth(bi).innerText(); if (/Delete|Clear|Deploy|Remove|Recover|Plug/.test(t)) continue; await bs.nth(bi).click({ timeout: 2000 }).catch(() => { }); }
      }
      if (mi === 0 && SHOTS) await p.screenshot({ path: path.join(SHOTS, k + '-main.png') });
    }
    await closeAll();
  }
  console.log('   pages swept:', pages);

  console.log('3. reset, then lab tasks through the GUIs');
  p.on('dialog', d => d.accept()); await p.click('#reset'); await p.waitForTimeout(500); if (await p.$('button:has-text("Start lab")')) await p.click('button:has-text("Start lab")');
  const t0 = await ts(); T('fresh lab: only the 2 baseline tasks done', t0.reduce((a, b) => a + b, 0) === 2, t0.join(''));
  // CLI inside a GUI
  await gui('R1'); await page('Command Line Interface'); await W().locator('.cliin').fill('show version'); await W().locator('.cliin').press('Enter'); T('GUI CLI page runs commands', /Version 15\.9/.test(await W().locator('.cli').innerText())); await closeAll();
  // T9 + T16 + T20: SW1
  await gui('SW1'); await menu('Configuration'); await page('AAA / 802.1X (RADIUS)'); await fill('shared secret', 'cisco123'); await tick(W().locator('label:has-text("aaa new-model") input')); await tick(W().locator('label:has-text("dot1x system-auth-control") input')); await btn('Apply');
  await page('Switch Ports'); await tick(W().locator('tr:has(td:text-is("Gi0/2")) td:nth-child(7) input')); await W().locator('tr:has(td:text-is("Gi0/2")) button:text-is("Apply")').click();
  await closeAll();
  await gui('ISE1'); await menu('Administration'); await page('Network Devices'); await fill('RADIUS shared secret', 'cisco123'); await btn('Submit'); await closeAll();
  await node('Client').click(); await p.locator('#abar button', { hasText: '802.1X login' }).click(); await W().locator('button:has-text("Log on (802.1X)")').click(); await closeAll();
  let s9 = await ts(); T('task 9 (802.1X)', s9[8] === 1, s9.join(''));
  await gui('SW1'); await menu('Configuration'); await page('Switch Ports');
  await page('Port Security'); await tick(W().locator('tr:has(td:text-is("Gi0/2")) td:nth-child(3) input')); await W().locator('tr:has(td:text-is("Gi0/2")) button:text-is("Apply")').click();
  await page('VLANs'); await fill('VLAN id', '20'); await fill('name', 'USERS2'); await btn('Add'); await page('Switch Ports');
  for (const pt of ['Gi0/1', 'Gi0/2']) { await W().locator(`tr:has(td:text-is("${pt}")) td:nth-child(4) select`).selectOption('20'); await W().locator(`tr:has(td:text-is("${pt}")) button:text-is("Apply")`).click(); }
  await closeAll();
  await node('Client').click(); await p.locator('#abar button', { hasText: '802.1X login' }).click(); await W().locator('button:has-text("Log on (802.1X)")').click(); await closeAll();
  let s = await ts(); T('task 16 (port-security)', s[15] === 1); T('task 20 (VLAN 20)', s[19] === 1);
  // T10
  await gui('ISE1'); await menu('Policy'); await page('Policy Sets (Default)'); await W().locator('tr:has(td:text-is("Contractors")) select').selectOption('Contractor-Web'); await closeAll(); T('task 10 (dACL)', (await ts())[9] === 1);
  // T3 T4 T11 via ASDM
  await gui('FW1'); await menu('Configuration'); await page('Firewall > NAT Rules');
  await fill('real host', '172.16.1.10'); await fill('mapped IP', '203.0.113.10'); await W().locator('.ppanel:has-text("Add Static NAT") button:text-is("Add")').click();
  await fill('real host', '172.16.1.20'); await fill('mapped IP', '203.0.113.20'); await W().locator('.ppanel:has-text("Add Static NAT") button:text-is("Add")').click();
  await page('Firewall > Access Rules');
  const rule = async (dst, port) => { await W().locator('.ppanel:has-text("Add Access Rule") .pval input').last().fill(dst); await W().locator('.ppanel:has-text("Add Access Rule") input[placeholder="port"]').fill(port); await W().locator('.ppanel:has-text("Add Access Rule") select:has(option[value="(no change)"])').selectOption('outside'); await btn('Add Rule'); };
  await rule('172.16.1.10', '80'); await rule('172.16.1.20', '25'); await closeAll();
  s = await ts(); T('task 3 (publish web)', s[2] === 1, s.join('')); T('task 4 (least privilege)', s[3] === 1); T('task 11 (publish smtp)', s[10] === 1);
  // T5 router ACL
  await gui('R1'); await menu('Configuration'); await page('Access Lists (ACL)'); await fill('ACL name', 'BLOCK-WEB'); await fill('destination', '172.16.1.10'); await fill('port', '80');
  let sA = await W().locator('.pcontent .prow select').all(); await sA[0].selectOption('deny'); await sA[sA.length - 2].selectOption('Gi0/2'); await btn('Add');
  await fill('ACL name', 'BLOCK-WEB'); sA = await W().locator('.pcontent .prow select').all(); await sA[0].selectOption('permit'); await sA[1].selectOption('ip'); await sA[2].selectOption('any'); await sA[3].selectOption('any'); await fill('port', ''); await btn('Add'); await closeAll();
  s = await ts(); T('task 5 (router ACL)', s[4] === 1, s.join(''));
  // FMC tasks: stage everything, verify nothing active until deploy, then deploy
  await gui('FMC1'); await menu('Policies'); await page('Access Control');
  const addRule = async (name, action, srcZ, dstZ, tabsFn, pos) => { await btn('+ Add Rule'); await W().locator('.pdlg input').first().fill(name); const ps = W().locator('.pdlg .prow select'); await ps.nth(0).selectOption(action); if (pos) await ps.nth(1).selectOption(pos);
    await W().locator('.pdlg .ptabs button:text-is("Zones")').click(); for (const z of srcZ) await tick(W().locator('.pdlg .pmulti').nth(0).locator(`label:has-text("${z}") input`)); for (const z of dstZ) await tick(W().locator('.pdlg .pmulti').nth(1).locator(`label:has-text("${z}") input`)); if (tabsFn) await tabsFn(); await W().locator('.pdlg button:text-is("Save")').click(); };
  await addRule('Block-SSH', 'block', ['IN'], ['OUT'], async () => { await W().locator('.pdlg .ptabs button:text-is("Ports")').click(); await tick(W().locator('.pdlg .pmulti label:has-text("SSH") input')); }, 'top');
  await addRule('Allow-Web-In', 'allow', ['OUT'], ['IN'], async () => { await W().locator('.pdlg .ptabs button:text-is("Networks")').click(); await tick(W().locator('.pdlg .pmulti').nth(1).locator('label:has-text("obj:Web-Server") input')); await W().locator('.pdlg .ptabs button:text-is("Ports")').click(); await tick(W().locator('.pdlg .pmulti label:has-text("HTTP") input').first()); }, 'bottom');
  await addRule('No-Social', 'block', ['IN'], ['OUT'], async () => { await W().locator('.pdlg .ptabs button:text-is("URLs")').click(); await tick(W().locator('.pdlg .pmulti label:has-text("Social Networking") input')); }, 'top');
  await W().locator('tr:has(td:text-is("Allow-IN-OUT")) button:text-is("Edit")').click(); await W().locator('.pdlg .ptabs button:text-is("Inspection")').click(); const insp = W().locator('.pdlg .pdlgbody select'); await insp.nth(0).selectOption('Balanced Security and Connectivity'); await insp.nth(1).selectOption('Block Malware'); await W().locator('.pdlg button:text-is("Save")').click();
  s = await ts(); T('FMC edits are staged (tasks 6,7,8,17,18 not active before Deploy)', [5, 6, 7, 16, 17].every(i => s[i] === 0), s.join(''));
  await W().locator('.deploybtn').click(); T('Deploy page lists pending changes', /Pending/.test(await W().locator('.pcontent').innerText())); await btn('Deploy'); await closeAll();
  s = await ts(); T('task 6 (FTD block ssh)', s[5] === 1, s.join('')); T('task 7 (publish ftd-client web)', s[6] === 1); T('task 8 (IPS)', s[7] === 1); T('task 17 (URL category)', s[16] === 1); T('task 18 (file policy)', s[17] === 1);
  // ESA
  await gui('ESA1'); await menu('Mail Policies'); await page('Incoming Content Filters'); await btn('Add'); await page('Incoming Mail Policies'); await W().locator('select:has(option[value="tag"])').selectOption('reject'); await btn('Submit'); await page('Sender Verification (DMARC)'); await tick(W().locator('.pcontent input[type=checkbox]').first());
  s = await ts(); T('ESA edits staged (not active before commit)', s[11] === 0 && s[12] === 0 && s[18] === 0, s.join('')); await W().locator('.commitbtn').click(); await btn('Commit Changes'); await closeAll();
  s = await ts(); T('task 12 (ESA drop exe)', s[11] === 1, s.join('')); T('task 13 (ESA SPF reject)', s[12] === 1); T('task 19 (DMARC)', s[18] === 1);
  // WSA
  await gui('WSA1'); await menu('Web Security Manager'); await page('Access Policies'); await W().locator('tr:has(td:text-is("Social Networking")) select').first().selectOption('block'); await menu('Security Services'); await page('HTTPS Proxy'); await tick(W().locator('.pcontent input[type=checkbox]').first());
  T('WSA edits staged', (await ts())[13] === 0); await W().locator('.commitbtn').click(); await btn('Commit Changes'); await closeAll();
  s = await ts(); T('task 14 (WSA block social)', s[13] === 1, s.join('')); T('task 15 (WSA https decrypt)', s[14] === 1);

  console.log('3b. Cisco Umbrella / Secure Endpoint / pxGrid / public clouds');
  const term = async (k, cmd) => { if (process.env.TRACE) console.log('  term', k, cmd); await rc(k, 'Open Terminal'); await W().locator('.tin').fill(cmd); await W().locator('.tin').press('Enter'); const o = await W().locator('.term').innerText(); await closeAll(); return o; };
  // T21 Umbrella
  await gui('UMB'); await page('Core Identities > Networks'); await fill('public (egress) IP', '203.0.113.1'); await btn('Save'); await page('Management > DNS Policies'); await tick(W().locator('tr:has(td:text-is("Gambling")) input')); await closeAll();
  const o21 = await term('Client', 'resolvectl dns 208.67.222.222'); T('resolvectl sets Umbrella', /Umbrella/.test(o21), o21.slice(-120));
  const ns = await term('Client', 'nslookup www.casino-royal.com'); T('nslookup shows Umbrella block page', /BLOCK PAGE/.test(ns), ns.slice(-200));
  s = await ts(); T('task 21 (Umbrella)', s[20] === 1, s.join(''));
  // T22 force DNS via R1 ACL
  await gui('R1'); await page('Access Lists (ACL)');
  const aclRow = async (act, pr, dt, dv, port, ifc) => { await fill('ACL name', 'DNS-FORCE'); const sl = await W().locator('.pcontent .prow select').all(); await sl[0].selectOption(act); await sl[1].selectOption(pr); await sl[2].selectOption('any'); await sl[3].selectOption(dt); if (dv) await fill('destination', dv); await fill('port', port); if (ifc) { await sl[sl.length - 2].selectOption(ifc); await sl[sl.length - 1].selectOption('out'); } await btn('Add'); };
  await aclRow('permit', 'udp', 'host', '208.67.222.222', '53'); await aclRow('deny', 'udp', 'any', '', '53'); await aclRow('permit', 'ip', 'any', '', '', 'Gi0/1'); await closeAll();
  s = await ts(); T('task 22 (force DNS to Umbrella)', s[21] === 1, s.join(''));
  // T23 Secure Endpoint
  await gui('SEP'); await menu('Management'); await page('Computers'); await W().locator('tr:has(td:text-is("Client")) button:text-is("Install connector")').click(); await W().locator('tr:has(td:text-is("Client")) select').selectOption('Protect');
  s = await ts(); T('task 23 (Secure Endpoint Protect)', s[22] === 1, s.join(''));
  await closeAll();
  const dl = await term('Client', 'curl http://downloads.example.org/eicar.com'); T('curl shows endpoint quarantine', /Quarantined/.test(dl), dl.slice(-200));
  // T24 pxGrid + ANC
  await gui('ISE1'); await menu('Administration'); await page('pxGrid Services'); await tick(W().locator('.pcontent input[type=checkbox]').first()); await closeAll();
  await gui('SEP'); await menu('Accounts'); await page('Integrations (ISE / Umbrella)'); await tick(W().locator('.pcontent input[type=checkbox]').first()); await closeAll();
  await gui('ISE1'); await menu('Administration'); await page('pxGrid Services'); await W().locator('tr:has(td:text-is("SecureEndpoint")) button:text-is("Approve")').click(); await closeAll();
  s = await ts(); T('task 24 (pxGrid + ANC)', s[23] === 1, s.join(''));
  // T25 WSA + ISE identity
  await gui('WSA1'); await menu('Network'); await page('Identification Services (ISE)'); await tick(W().locator('.pcontent input[type=checkbox]').first()); await closeAll();
  await gui('ISE1'); await menu('Administration'); await page('pxGrid Services'); await W().locator('tr:has(td:text-is("WSA")) button:text-is("Approve")').click(); await closeAll();
  await gui('WSA1'); await menu('Web Security Manager'); await page('Access Policies'); await fill('policy name', 'Contractors-Web'); await W().locator('select:has(option[value="Contractors"])').selectOption('Contractors'); await btn('Add policy');
  await W().locator('tr:has(td:text-is("Streaming Media")) select').selectOption('block'); await W().locator('.commitbtn').click(); await btn('Commit Changes'); await closeAll();
  s = await ts(); T('task 25 (WSA + ISE identity)', s[24] === 1, s.join(''));
  // T26 AWS
  await gui('AWS'); await page('EC2 Instances'); await W().locator('button:text-is("Create")').click(); await page('Security Groups'); await btn('Add rule'); await closeAll();
  s = await ts(); T('task 26 (AWS instance, http only)', s[25] === 1, s.join(''));
  // T27 Azure
  await gui('AZURE'); await page('Virtual machines'); await W().locator('button:text-is("Create")').click(); await page('Network security groups'); await fill('port from', '22'); await fill('to', '22'); await fill('source / destination CIDR', '203.0.113.1/32'); await btn('Add rule'); await closeAll();
  s = await ts(); T('task 27 (Azure NSG, lab egress only)', s[26] === 1, s.join(''));
  // T28 GCP + Umbrella
  await gui('GCP'); await page('Compute Engine VM instances'); await W().locator('button:text-is("Create")').click(); await W().locator('tbody tr select:has(option[value="208.67.222.222"])').selectOption('208.67.222.222'); await closeAll();
  const gip = await p.evaluate(() => App.L.cloud.gcp.vms[0].publicIp);
  await gui('UMB'); await page('Core Identities > Networks'); await fill('network name', 'GCP-VM'); await fill('public (egress) IP', gip); await btn('Save'); await closeAll();
  s = await ts(); T('task 28 (GCP + Umbrella)', s[27] === 1, s.join(''));
  // T29 cloud endpoint
  await gui('SEP'); await menu('Management'); await page('Computers'); await W().locator('tr:has(td:text-is("AWS / web1")) button:text-is("Install connector")').click(); await W().locator('tr:has(td:text-is("AWS / web1")) select').selectOption('Protect'); await closeAll();
  s = await ts(); T('task 29 (cloud VM endpoint protection)', s[28] === 1, s.join(''));
  // cloud VM console
  await gui('AWS'); await page('Connect to VM (console)'); await W().locator('.cliin').fill('curl http://downloads.example.org/eicar.com'); await W().locator('.cliin').press('Enter'); T('cloud VM console runs curl + endpoint verdict', /Quarantined/.test(await W().locator('.ppre').innerText())); await closeAll();
  console.log('   tasks:', s.join(''));
  T('ALL ' + s.length + ' lab tasks complete via the GUIs', s.every(x => x === 1), s.join(''));


  console.log('3c. live containment: compromised PC is quarantined by ISE, then released');
  await gui('SEP'); await menu('Management'); await page('Computers'); await W().locator('tr:has(td:text-is("Client")) select').selectOption('Audit'); await closeAll();
  const dl2 = await term('Client', 'curl http://downloads.example.org/eicar.com'); T('Audit mode: malware executes', /Detected/.test(dl2), dl2.slice(-160));
  let st = await p.evaluate(() => ({ port: App.L.dev.SW1.ifs['Gi0/2'].state, ok: Sim.flow(App.L, 'Client', { proto: 'icmp', dst: '198.51.100.10' }).ok, ag: App.L.sep.agents.Client.state }));
  T('ISE quarantined the compromised Client (port + no network)', st.port === 'quarantine' && !st.ok && st.ag === 'compromised', JSON.stringify(st));
  await gui('ISE1'); await menu('Operations'); await page('Adaptive Network Control'); T('ANC page lists the endpoint', /Client/.test(await W().locator('.pcontent').innerText())); await W().locator('button:text-is("Clear (release)")').click(); await closeAll();
  await node('Client').click(); await p.locator('#abar button', { hasText: '802.1X login' }).click(); await W().locator('button:has-text("Log on (802.1X)")').click(); await closeAll();
  st = await p.evaluate(() => ({ port: App.L.dev.SW1.ifs['Gi0/2'].state })); T('after release + re-authentication the port is authorized again', st.port === 'authorized', JSON.stringify(st));
  await gui('SEP'); await menu('Dashboard'); await page('Inbox'); T('Secure Endpoint inbox lists the compromised PC', /Client/.test(await W().locator('.pcontent').innerText())); await closeAll();
  console.log('4. built-in self-test');
  await p.click('#selftest'); await p.waitForSelector('.stlist'); const title = await p.locator('.mbox h2').innerText(); T('self-test passes on this browser', /all \d+ checks passed/.test(title), title);
  T('no uncaught page errors', errs.length === 0, errs.slice(0, 4).join(' || '));
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST CRASH:', e.message.split('\n')[0], '\n', (e.stack.split('\n').find(l => /e2e.cjs/.test(l)) || '')); process.exit(2); });
