// SCOR Lab Simulator - UI
(function () {
'use strict';
const { flow, packetTracer, clone, newLab, ftdDeploy } = Sim;
const KEY = 'scor-sim-v' + Sim.VERSION;
let L = null, sel = 'Client', tabs = {}, lastAnim = null, sessions = {}, terms = {}, hist = {};
const $ = s => document.querySelector(s);
function showErr(msg) { const b = $('#errbar'); if (!b) return; b.innerHTML = ''; b.append(h('b', {}, 'Something went wrong: '), String(msg), ' ', h('button', { onclick: () => { b.style.display = 'none'; } }, 'Dismiss'), h('button', { onclick: () => hardReset() }, 'Reset lab (fixes most problems)')); b.style.display = 'block'; }
function safe(f) { return function () { try { const r = f.apply(this, arguments); if (r && r.catch) r.catch(showErr); return r; } catch (e) { showErr(e.message); } }; }
function hardReset() { try { for (const k of Object.keys(localStorage)) if (/^scor-sim/.test(k)) localStorage.removeItem(k); } catch (e) { } location.reload(); }
window.addEventListener('error', e => showErr(e.message)); window.addEventListener('unhandledrejection', e => showErr(e.reason && e.reason.message || e.reason));
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) { if (k === 'class') e.className = attrs[k]; else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]); else if (k === 'html') e.innerHTML = attrs[k]; else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]); }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const svgNS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, ...kids) { const e = document.createElementNS(svgNS, tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); for (const c of kids) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c)); return e; }

function valid(x) { try { return x && x.ver === Sim.VERSION && x.dev && x.dev.FMC1 && x.dev.ISE1 && x.dev.ESA1 && x.dev.WSA1 && x.dev.FTD1 && x.dev.FTD1.draft && x.ise && x.esa && x.wsa; } catch (e) { return false; } }
function load() { try { for (const k of Object.keys(localStorage)) if (/^scor-sim-v/.test(k) && k !== KEY) localStorage.removeItem(k); const j = localStorage.getItem(KEY); if (j) { const x = JSON.parse(j); if (valid(x)) { L = x; return; } } } catch (e) { } L = newLab(); }
function save() { try { localStorage.setItem(KEY, JSON.stringify(L)); } catch (e) {} }

// ---------- tasks ----------
const S_ = Sim;
const sandbox = fn => fn(clone(L));
const ok = (l, s, p) => flow(l, s, p).ok;
const TASKS = [
  { id: 1, t: 'Baseline: inside PC reaches the DMZ web server', hint: 'Client > Browser http://172.16.1.10 (inside has higher security-level than dmz, so it is allowed by default).', check: l => ok(l, 'Client', { proto: 'tcp', dst: '172.16.1.10', dport: 80 }), ans: '(already works)' },
  { id: 2, t: 'Baseline: inside PC reaches the outside network (dynamic PAT)', hint: 'Client > ping 198.51.100.10 ; then on FW1-ASA console: show xlate / show conn.', check: l => ok(l, 'Client', { proto: 'icmp', dst: '198.51.100.10' }), ans: '(already works)' },
  { id: 3, t: 'ASA: publish the DMZ web server - Outside can browse http://203.0.113.10', hint: 'Needs BOTH a static NAT (172.16.1.10 -> 203.0.113.10, dmz,outside) AND an access-list on the outside interface permitting tcp/80 to the REAL address. Use ASDM Packet Tracer (outside, tcp, 198.51.100.10 -> 203.0.113.10:80) to see what is missing.',
    check: l => ok(l, 'Outside', { proto: 'tcp', dst: '203.0.113.10', dport: 80 }),
    ans: 'object network DMZ-WEB\n host 172.16.1.10\n nat (dmz,outside) static 203.0.113.10\naccess-list OUT-IN extended permit tcp any object DMZ-WEB eq 80\naccess-group OUT-IN in interface outside' },
  { id: 4, t: 'ASA: least privilege - SSH to the published server must be blocked', hint: 'Only tcp/80 should be reachable from outside. Test: Outside > Terminal > nmap -Pn 203.0.113.10', dep: 3,
    check: l => ok(l, 'Outside', { proto: 'tcp', dst: '203.0.113.10', dport: 80 }) && !ok(l, 'Outside', { proto: 'tcp', dst: '203.0.113.10', dport: 22 }), ans: '(task 3 already does this - implicit deny)' },
  { id: 5, t: 'R1 ACL: block Client from the DMZ web (tcp/80) but still allow ping and Internet', hint: 'Extended ACL on R1 Gi0/2 inbound: deny tcp any host 172.16.1.10 eq 80 then permit ip any any.',
    check: l => !ok(l, 'Client', { proto: 'tcp', dst: '172.16.1.10', dport: 80 }) && ok(l, 'Client', { proto: 'icmp', dst: '172.16.1.10' }) && ok(l, 'Client', { proto: 'icmp', dst: '198.51.100.10' }),
    ans: 'R1: ip access-list extended BLOCK-WEB\n deny tcp any host 172.16.1.10 eq 80\n permit ip any any\ninterface Gi0/2\n ip access-group BLOCK-WEB in' },
  { id: 9, t: 'ISE: enable 802.1X on SW1 port Gi0/2 and let Client authenticate as alice', hint: 'Needs BOTH sides: (SW1 CLI) aaa new-model, dot1x system-auth-control, radius server ISE / address ipv4 192.168.100.14 / key <secret>, interface gi0/2 / authentication port-control auto  AND (ISE GUI) Network Devices: add SW1 (192.168.100.23) with the SAME secret. Then Client > Network login (802.1X): alice / Cisco123!. If it fails, the ISE Live Logs and the error tell you which side is wrong.',
    check: l => { const sw = l.dev.SW1; if (sw.ifs['Gi0/2'].auth !== 'auto') return false; const r = Sim.iseAuth(l, { nas: 'SW1', port: 'Gi0/2', method: 'dot1x', user: 'alice', pass: 'Cisco123!', mac: 'x' }); return r.ok && ok(l, 'Client', { proto: 'icmp', dst: '172.16.1.10' }); },
    ans: 'SW1:\n aaa new-model\n aaa authentication dot1x default group radius\n dot1x system-auth-control\n radius server ISE\n  address ipv4 192.168.100.14 auth-port 1812 acct-port 1813\n  key cisco123\n interface gi0/2\n  authentication port-control auto\n  dot1x pae authenticator\nISE GUI > Network Devices > add SW1 192.168.100.23 secret cisco123' },
  { id: 10, t: 'ISE: contractors (carl) may only browse the web (tcp/80); employees keep full access', hint: 'ISE GUI > Policy: change the "Contractors" authorization rule profile from PermitAccess to Contractor-Web (it carries a downloadable ACL). Then log in as carl on the Client: web works, ping does not. Log off and log in as alice: everything works.', dep: 9,
    check: l => { const a1 = Sim.iseAuth(l, { nas: 'SW1', port: 'Gi0/2', method: 'dot1x', user: 'alice', pass: 'Cisco123!', mac: 'x' }); const full = ok(l, 'Client', { proto: 'icmp', dst: '172.16.1.10' }); const a2 = Sim.iseAuth(l, { nas: 'SW1', port: 'Gi0/2', method: 'dot1x', user: 'carl', pass: 'Cisco123!', mac: 'x' }); return a1.ok && full && a2.ok && ok(l, 'Client', { proto: 'tcp', dst: '172.16.1.10', dport: 80 }) && !ok(l, 'Client', { proto: 'icmp', dst: '172.16.1.10' }); }, ans: 'ISE GUI > Policy > Authorization: rule Contractors -> profile Contractor-Web' },
  { id: 11, t: 'ESA: publish SMTP - Outside can deliver mail to alice@lab.local via 203.0.113.20', hint: 'ESA1 lives in the DMZ at 172.16.1.20. Same recipe as the web server: static NAT (172.16.1.20 -> 203.0.113.20) plus an outside ACL permitting tcp/25 to the REAL address. Test on Outside-Desktop: swaks --to alice@lab.local --from bob@partner.com --server 203.0.113.20 --body hi',
    check: l => Sim.esaSend(l, 'Outside', { from: 'bob@partner.com', to: 'alice@lab.local', subject: 'hello', body: 'hi', attach: [], server: '203.0.113.20' }).ok,
    ans: 'object network ESA1\n host 172.16.1.20\n nat (dmz,outside) static 203.0.113.20\naccess-list OUT-IN extended permit tcp any object ESA1 eq 25\naccess-group OUT-IN in interface outside' },
  { id: 12, t: 'ESA: drop executable attachments (.exe) but still deliver PDFs', hint: 'ESA GUI > Mail Policies > Content filters: attachment-ext = exe -> drop. Test from Outside with swaks --attach invoice.exe vs invoice.pdf.', dep: 11,
    check: l => !Sim.esaSend(l, 'Outside', { from: 'bob@partner.com', to: 'alice@lab.local', subject: 's', body: 'b', attach: ['invoice.exe'], server: '203.0.113.20' }).ok && Sim.esaSend(l, 'Outside', { from: 'bob@partner.com', to: 'alice@lab.local', subject: 's', body: 'b', attach: ['invoice.pdf'], server: '203.0.113.20' }).ok, ans: 'ESA GUI > Mail Policies > add content filter: NoExe, attachment-ext, exe, drop' },
  { id: 13, t: 'ESA: reject spoofed mail (SPF fail) while legitimate partner mail passes', hint: 'ESA GUI > Mail Policies: SPF action = reject. partner.com authorises 198.51.100.10 (Outside); example.org does not - so mail "from" ceo@example.org sent by Outside must be rejected.', dep: 11,
    check: l => Sim.esaSend(l, 'Outside', { from: 'bob@partner.com', to: 'alice@lab.local', subject: 'a', body: 'b', attach: [], server: '203.0.113.20' }).ok && !Sim.esaSend(l, 'Outside', { from: 'ceo@example.org', to: 'alice@lab.local', subject: 'a', body: 'b', attach: [], server: '203.0.113.20' }).ok, ans: 'ESA GUI > Mail Policies > SPF fail action: reject' },
  { id: 14, t: 'WSA: block Social Networking for users of the web proxy (Client uses 172.16.1.30:3128)', hint: 'Right-click Client > Open Desktop: set Proxy to 172.16.1.30:3128 and browse http://www.facebook.com (works). Then WSA GUI > Access Policies: Social Networking = block. facebook is blocked, www.cisco.com still works.',
    check: l => !S_.webGet(l, 'Client', { url: 'http://www.facebook.com', proxy: '172.16.1.30:3128' }).ok && S_.webGet(l, 'Client', { url: 'http://www.cisco.com', proxy: '172.16.1.30:3128' }).ok, ans: 'WSA GUI > Access Policies > Social Networking: block' },
  { id: 15, t: 'WSA: stop malware hidden inside HTTPS - enable HTTPS decryption', hint: 'https://downloads.example.org/eicar.com passes the proxy today because the WSA cannot see inside the encrypted tunnel. WSA GUI > Security Services: turn on HTTPS decryption (keep anti-malware on). Normal pages must still work.',
    check: l => { const x = S_.webGet(l, 'Client', { url: 'https://downloads.example.org/eicar.com', proxy: '172.16.1.30:3128' }); return !x.ok && x.kind === 'malware' && S_.webGet(l, 'Client', { url: 'https://downloads.example.org/readme.txt', proxy: '172.16.1.30:3128' }).ok; }, ans: 'WSA GUI > Security Services: HTTPS decryption ON, Anti-malware ON' },
  { id: 6, t: 'FTD: block SSH (tcp/22) from FTD-Client to Outside but keep web + ping working', hint: 'FMC1 > GUI (or FTD1 > Open GUI) > Access Policy: add a BLOCK rule IN->OUT tcp/22 and move it ABOVE Allow-IN-OUT (rules match top-down), then Deploy. Test from FTD-Client terminal: nmap -Pn 198.51.100.10',
    check: l => ok(l, 'FTDClient', { proto: 'icmp', dst: '198.51.100.10' }) && ok(l, 'FTDClient', { proto: 'tcp', dst: '198.51.100.10', dport: 80 }) && !ok(l, 'FTDClient', { proto: 'tcp', dst: '198.51.100.10', dport: 22 }), ans: 'FMC GUI > Access Policy > add rule: name Block-SSH, IN -> OUT, tcp, port 22, action block, position top > Deploy' },
  { id: 7, t: 'FTD: publish FTD-Client web (tcp/80) to Outside, but not SSH', hint: 'Add an ALLOW rule OUT->IN, destination network 10.2.1.10, tcp port 80, then Deploy. Test from Outside-Desktop browser: http://10.2.1.10', 
    check: l => ok(l, 'Outside', { proto: 'tcp', dst: '10.2.1.10', dport: 80 }) && !ok(l, 'Outside', { proto: 'tcp', dst: '10.2.1.10', dport: 22 }), ans: 'FMC GUI > Access Policy > add rule: Allow-Web-In, OUT -> IN, dst net 10.2.1.10, tcp 80, allow > Deploy' },
  { id: 8, t: 'FTD IPS: block a malicious web request (sqlmap) while normal browsing still works', hint: 'Tick the "IPS" box on the Allow-IN-OUT rule and Deploy. Test: FTD-Client terminal: curl -A sqlmap http://198.51.100.10 (blocked) vs curl http://198.51.100.10 (ok).',
    check: l => ok(l, 'FTDClient', { proto: 'tcp', dst: '198.51.100.10', dport: 80 }) && !ok(l, 'FTDClient', { proto: 'tcp', dst: '198.51.100.10', dport: 80, sig: 'sqlmap' }), ans: 'FMC GUI > Access Policy > tick IPS on Allow-IN-OUT > Deploy' },
];
TASKS.sort((p, q) => p.id - q.id);
let status = {};
function runChecks() {
  status = {}; L.ach = L.ach || {};
  for (const t of TASKS) { let r = false; try { r = t.dep && !status[t.dep] ? false : sandbox(t.check); } catch (e) { r = false; } if (r) L.ach[t.id] = true; status[t.id] = !!L.ach[t.id]; }   // milestones stay checked once achieved
  renderTasks();
}
function renderTasks() {
  const box = $('#tasks'); box.innerHTML = '';
  const done = TASKS.filter(t => status[t.id]).length;
  $('#prog').style.width = done / TASKS.length * 100 + '%'; $('#progt').textContent = done + ' / ' + TASKS.length + ' complete';
  for (const t of TASKS) {
    const d = h('details', { class: 'task ' + (status[t.id] ? 'ok' : '') }, h('summary', {}, h('span', { class: 'chk' }, status[t.id] ? '✔' : '○'), ' ' + t.id + '. ' + t.t),
      h('p', {}, h('b', {}, 'Hint: '), t.hint), h('details', { class: 'ans' }, h('summary', {}, 'Show answer'), h('pre', {}, t.ans)));
    box.append(d);
  }
}

// ---------- commit ----------
function commit() { save(); runChecks(); drawTopo(); renderPanel(true); }

// ---------- topology ----------
function icon(type, c) {
  const g = sv('g', { transform: 'translate(55,6)', stroke: c, fill: 'none', 'stroke-width': 2, 'stroke-linecap': 'round' });
  if (type === 'host') { g.append(sv('rect', { x: -11, y: 0, width: 22, height: 14, rx: 2 }), sv('line', { x1: 0, y1: 14, x2: 0, y2: 19 }), sv('line', { x1: -6, y1: 19, x2: 6, y2: 19 })); }
  else if (type === 'router') { g.append(sv('circle', { cx: 0, cy: 10, r: 10 }), sv('path', { d: 'M-6 10h12M3 6l3 4-3 4M-3 6l-3 4 3 4' })); }
  else if (type === 'switch') { g.append(sv('rect', { x: -13, y: 2, width: 26, height: 16, rx: 3 }), sv('path', { d: 'M-8 8h14M3 5l3 3-3 3M8 14H-6M-3 11l-3 3 3 3' })); }
  else if (type === 'fmc' || type === 'ise' || type === 'esa' || type === 'wsa') { g.append(sv('rect', { x: -12, y: 0, width: 24, height: 7, rx: 2 }), sv('rect', { x: -12, y: 10, width: 24, height: 7, rx: 2 }), sv('circle', { cx: -7, cy: 3.5, r: 1 }), sv('circle', { cx: -7, cy: 13.5, r: 1 }), sv('text', { x: 4, y: 7, fill: c, stroke: 'none', 'font-size': 7, 'text-anchor': 'middle' }, type === 'fmc' ? 'FMC' : type === 'ise' ? 'ISE' : type === 'wsa' ? 'WSA' : 'ESA')); }
  else { g.append(sv('rect', { x: -12, y: 1, width: 24, height: 18, rx: 2 }), sv('path', { d: 'M-12 7h24M-12 13h24M-3 1v6M5 7v6M-3 13v6' })); }
  return g;
}
const COL = { host: '#3b82f6', router: '#22d3ee', switch: '#a78bfa', asa: '#f97316', ftd: '#ef4444', fmc: '#f43f5e', ise: '#10b981', esa: '#eab308', wsa: '#38bdf8' };
const tyOf = d => d.role || d.type;
function center(d) { return [d.x + 55, d.y + 28]; }
function actionBar() {
  const bar = $('#abar'); if (!bar) return; bar.innerHTML = ''; const d = L.dev[sel]; if (!d) return; const on = d.on !== false;
  bar.append(h('b', {}, d.label + ':'));
  const B = (t, f, cls) => bar.append(h('button', { class: cls || '', onclick: safe(f) }, t));
  if (d.role) { B('Open GUI (' + guiKind(d) + ')', () => openWin(sel, 'gui'), 'pri'); B('Terminal', () => openWin(sel, 'term')); }
  else if (d.type === 'host') { B('Desktop (browser)', () => openWin(sel, 'browser'), 'pri'); B('Terminal', () => openWin(sel, 'term')); B('Mail', () => openWin(sel, 'mail')); if (Sim.portOf(L, sel)) B('802.1X login', () => openWin(sel, 'nac')); }
  else { B('Terminal', () => openWin(sel, 'term'), 'pri'); B('Open GUI (' + guiKind(d) + (d.type === 'ftd' ? ' - FMC1' : '') + ')', () => openWin(sel, 'gui')); }
  B(on ? '⏻ Power off' : '⏻ Power on', () => setPower(sel, !on), on ? 'off' : 'onb');
  bar.append(h('span', { class: 'dim' }, ' (or right-click / double-click the device)'));
}
function drawTopo() {
  actionBar();
  const svg = $('#topo'); svg.innerHTML = '';
  for (const [a, b] of L.links) {
    const [da, ia] = a.split(':'), [db, ib] = b.split(':'); const A = center(L.dev[da]), B = center(L.dev[db]);
    svg.append(sv('line', { x1: A[0], y1: A[1], x2: B[0], y2: B[1], class: 'lnk' }));
    const lab = (P, Q, n) => svg.append(sv('text', { x: P[0] + (Q[0] - P[0]) * 0.27, y: P[1] + (Q[1] - P[1]) * 0.27 - 4, class: 'lbl' }, n));
    if (L.dev[da].type !== 'switch') lab(A, B, ia); if (L.dev[db].type !== 'switch') lab(B, A, ib);
  }
  const nets = [['192.168.100.0/24 (mgmt)', 700, 330], ['172.16.1.0/24 (DMZ)', 478, 215], ['203.0.113.0/24', 345, 100], ['10.1.1.0/24', 560, 100], ['192.0.2.0/24', 262, 205], ['198.51.100.0/24', 160, 100], ['10.1.10.0/24', 800, 100], ['10.2.1.0/24', 275, 395]];
  for (const [t, x, y] of nets) svg.append(sv('text', { x, y, class: 'net' }, t));
  svg.append(sv('g', { id: 'anim' }));
  for (const n in L.dev) {
    const d = L.dev[n], c = COL[tyOf(d)];
    const g = sv('g', { class: 'node' + (sel === n ? ' sel' : ''), transform: 'translate(' + d.x + ',' + d.y + ')', opacity: d.on === false ? 0.3 : 1 });
    g.append(sv('rect', { width: 110, height: 56, rx: 12, fill: '#0f172a', stroke: c, 'stroke-width': sel === n ? 3 : 1.5 }));
    g.append(icon(tyOf(d), c));
    g.append(sv('text', { x: 55, y: 46, class: 'nm', 'text-anchor': 'middle' }, d.label));
    if (d.type === 'ftd' && d.dirty) g.append(sv('circle', { cx: 104, cy: 6, r: 5, fill: '#facc15' }));
    g.addEventListener('click', safe(() => { sel = n; drawTopo(); }));
    g.addEventListener('dblclick', safe(() => openWin(n, d.type === 'host' ? 'browser' : 'term')));
    g.addEventListener('contextmenu', safe(ev => { ev.preventDefault(); sel = n; drawTopo(); showMenu(n, ev.clientX, ev.clientY); }));
    svg.append(g);
  }
}
function animate(r) {
  const g = $('#anim'); if (!g || !r.path || r.path.length < 2) return; g.innerHTML = '';
  const pts = r.path.map(n => center(L.dev[n])); const col = r.ok ? '#22c55e' : '#ef4444';
  const dot = sv('circle', { r: 7, fill: col, filter: 'drop-shadow(0 0 6px ' + col + ')' }); g.append(dot);
  let i = 0, t0 = null; const seg = 380;
  function step(ts) { if (t0 === null) t0 = ts; const e = ts - t0, k = Math.floor(e / seg); if (k >= pts.length - 1) { dot.remove(); if (!r.ok && r.at && L.dev[r.at]) { const P = center(L.dev[r.at]); const x = sv('text', { x: P[0], y: P[1] - 34, 'text-anchor': 'middle', class: 'xmark' }, '✖ ' + (r.kind === 'closed' ? 'refused' : 'dropped')); g.append(x); setTimeout(() => x.remove(), 2500); } return; }
    const f = (e - k * seg) / seg, A = pts[k], B = pts[k + 1]; dot.setAttribute('cx', A[0] + (B[0] - A[0]) * f); dot.setAttribute('cy', A[1] + (B[1] - A[1]) * f); requestAnimationFrame(step); }
  requestAnimationFrame(step);
}
Sim.hook = r => { lastAnim = r; };

// ---------- floating windows + context menu ----------
let wins = {}, zTop = 10, brs = {};
function guiKind(d) { return d.type === 'asa' ? 'ASDM' : d.type === 'ftd' || d.role === 'fmc' ? 'FMC' : d.role === 'ise' ? 'ISE' : d.role === 'esa' ? 'ESA' : d.role === 'wsa' ? 'WSA' : d.type === 'router' ? 'Router' : d.type === 'switch' ? 'Switch' : null; }
function showMenu(n, x, y) {
  const d = L.dev[n], m = $('#ctx'); m.innerHTML = ''; const on = d.on !== false;
  const item = (t, f, dis) => m.append(h('div', { class: 'mi' + (dis ? ' dis' : ''), onclick: safe(() => { m.style.display = 'none'; if (!dis) f(); }) }, t));
  m.append(h('div', { class: 'mh' }, d.label + (on ? '' : '  (powered off)')));
  if (d.role) { item('Open GUI (' + guiKind(d) + ')', () => openWin(n, 'gui'), !on); item('Open Terminal / CLI', () => openWin(n, 'term'), !on); }
  else if (d.type === 'host') { item('Open Desktop (browser)', () => openWin(n, 'browser'), !on); item('Open Terminal', () => openWin(n, 'term'), !on); item('Open Mail client', () => openWin(n, 'mail'), !on); if (Sim.portOf(L, n)) item('Network login (802.1X)', () => openWin(n, 'nac'), !on); }
  else if (d.type === 'switch') { item('Open Terminal / Console', () => openWin(n, 'term'), !on); item('Open GUI (Switch manager)', () => openWin(n, 'gui'), !on); item('Port / 802.1X status', () => openWin(n, 'info'), !on); }
  else { item('Open Terminal / Console', () => openWin(n, 'term'), !on); if (guiKind(d)) item('Open GUI (' + guiKind(d) + (d.type === 'ftd' ? ', managed by FMC1' : '') + ')', () => openWin(n, 'gui'), !on); else item('Device info', () => openWin(n, 'info'), !on); }
  m.append(h('div', { class: 'ms' })); item(on ? 'Power off' : 'Power on', () => setPower(n, !on));
  m.style.left = Math.min(x, innerWidth - 230) + 'px'; m.style.top = Math.min(y, innerHeight - 190) + 'px'; m.style.display = 'block';
}
document.addEventListener('mousedown', ev => { const m = $('#ctx'); if (m && m.style.display === 'block' && !m.contains(ev.target)) m.style.display = 'none'; });
function setPower(n, on) {
  const d = L.dev[n]; d.on = on;
  if (!on) { for (const k of Object.keys(wins)) if (wins[k].dn === n) closeWin(k); if (d.conns) { d.conns.length = 0; d.xlates.length = 0; } }
  commit(); notice(d.label + (on ? ' powered on.' : ' powered off.'));
}
function closeWin(k) { const w = wins[k]; if (!w) return; w.el.remove(); delete wins[k]; $('#deskhint').style.display = Object.keys(wins).length ? 'none' : 'block'; renderWtabs(); }
function renderWtabs() { const t = $('#wtabs'); if (!t) return; t.innerHTML = ''; for (const k of Object.keys(wins)) { const w = wins[k]; t.append(h('button', { class: 'wtab' + (w.el.style.display === 'none' ? ' min' : ''), title: 'show / bring to front', onclick: safe(() => { w.el.style.display = ''; front(w); renderWtabs(); }) }, w.title.replace(' - ', ': '))); } }
function front(w) { w.el.style.zIndex = ++zTop; if (w.el.style.display === 'none') w.el.style.display = ''; }
function fillWin(w) {
  const d = L.dev[w.dn]; w.body.innerHTML = '';
  if (w.kind === 'term') w.body.append(terminal(d));
  else if (w.kind === 'browser') w.body.append(browser(d));
  else if (w.kind === 'gui') w.body.append(d.type === 'asa' ? GUI.asdm(d) : d.type === 'router' ? GUI.iosRouter(d) : d.type === 'switch' ? GUI.iosSwitch(d) : d.role === 'ise' ? GUI.ise(d) : d.role === 'esa' ? GUI.esa(d) : d.role === 'wsa' ? GUI.wsa(d) : GUI.fmc(L.dev.FTD1));
  else if (w.kind === 'mail') w.body.append(mailApp(d));
  else if (w.kind === 'nac') w.body.append(nacApp(d));
  else w.body.append(infoView(d));
}
function openWin(n, kind) {
  if (kind === 'gui' && L.dev[n].type === 'ftd') n = 'FMC1';
  const d = L.dev[n]; if (d.on === false) { notice(d.label + ' is powered off - right-click > Power on', true); return; }
  const k = n + ':' + kind; if (wins[k]) { front(wins[k]); return; }
  const title = d.label + ' - ' + ({ term: 'Terminal', browser: 'Desktop', gui: guiKind(d) + ' GUI', info: 'Info', mail: 'Mail client', nac: 'Network login (802.1X)' })[kind];
  const body = h('div', { class: 'wbody' }); const cnt = Object.keys(wins).length;
  const el = h('div', { class: 'win', style: 'left:' + (14 + (cnt % 6) * 30) + 'px;top:' + (14 + (cnt % 6) * 30) + 'px' }, h('div', { class: 'wbar' }, h('span', {}, title), h('span', {}, h('button', { class: 'wx wm', title: 'minimize (reopen from the taskbar at the top)', onclick: () => { el.style.display = 'none'; renderWtabs(); } }, '—'), h('button', { class: 'wx wm', title: 'full screen / restore', onclick: () => { el.classList.toggle('fs'); front(wins[k]); } }, '▢'), h('button', { class: 'wx', title: 'close', onclick: () => closeWin(k) }, '✕'))), body);
  const w = wins[k] = { el, body, dn: n, kind, title }; if (['gui', 'mail', 'nac'].includes(kind)) el.classList.add('fs'); fillWin(w); $('#desk').append(el); $('#deskhint').style.display = 'none'; front(w); renderWtabs();
  el.addEventListener('mousedown', () => front(w));
  const bar = el.firstChild; let ox, oy, dragging = false;
  bar.addEventListener('dblclick', ev => { if (ev.target.tagName !== 'BUTTON') el.classList.toggle('fs'); });
  bar.addEventListener('mousedown', ev => { if (ev.target.tagName === 'BUTTON') return; dragging = true; ox = ev.clientX - el.offsetLeft; oy = ev.clientY - el.offsetTop; ev.preventDefault(); });
  document.addEventListener('mousemove', ev => { if (dragging) { el.style.left = Math.max(0, ev.clientX - ox) + 'px'; el.style.top = Math.max(0, ev.clientY - oy) + 'px'; } });
  document.addEventListener('mouseup', () => dragging = false);
  setTimeout(() => { if (kind === 'term' && terms[n]) terms[n]._inp.focus(); }, 0);
}
function refreshWins() { for (const k in wins) if (['gui', 'info', 'nac'].includes(wins[k].kind)) fillWin(wins[k]); }
function renderPanel() { refreshWins(); }
// ---------- start screen ----------
const PRESETS = { 'Web security (WSA)': ['FW1', 'R1', 'R2', 'SW1', 'Client', 'Outside', 'WSA1', 'DMZ'], 'Email security (ESA)': ['FW1', 'R1', 'R2', 'SW1', 'Client', 'Outside', 'ESA1', 'DMZ'], 'Network access (ISE 802.1X)': ['R1', 'SW1', 'Client', 'ISE1', 'FW1', 'DMZ', 'R2', 'Outside'], 'FTD + FMC': ['R2', 'Outside', 'FTD1', 'FTDClient', 'FMC1'], 'Everything': null, 'Firewall lab (ASA)': ['FW1', 'R1', 'R2', 'SW1', 'Client', 'DMZ', 'Outside'], 'FTD lab': ['R2', 'Outside', 'FTD1', 'FTDClient'], 'Routers + ACLs': ['R1', 'R2', 'SW1', 'Client', 'Outside', 'FW1', 'DMZ'] };
function startScreen() {
  const m = $('#modal'); m.innerHTML = ''; m.style.display = 'flex';
  const boxes = {}; const list = h('div', { class: 'dlist' });
  for (const n in L.dev) { const cb = h('input', { type: 'checkbox' }); cb.checked = L.dev[n].on !== false; boxes[n] = cb; list.append(h('label', {}, cb, ' ' + L.dev[n].label, h('small', {}, ' ' + L.dev[n].type))); }
  const preset = (names) => { for (const n in boxes) boxes[n].checked = !names || names.includes(n) || L.dev[n].type === 'switch'; };
  m.append(h('div', { class: 'mbox' }, h('h2', {}, 'SCOR Lab Simulator'), h('p', { class: 'dim' }, 'Choose the devices to power on, then press Start. Later: right-click any device on the map to open its Terminal or GUI, or to power it on/off.'),
    h('div', { class: 'presets' }, Object.keys(PRESETS).map(k => h('button', { onclick: () => preset(PRESETS[k]) }, k))), list,
    h('div', { style: 'text-align:right;margin-top:12px' }, h('button', { class: 'primary', onclick: () => { for (const n in boxes) L.dev[n].on = boxes[n].checked; for (const k of Object.keys(wins)) closeWin(k); m.style.display = 'none'; commit(); notice('Lab started. Right-click a device for Terminal / GUI.'); } }, 'Start lab  ▶'))));
}
function terminal(d) {
  if (!terms[d.name]) {
    const out = h('div', { class: 'tout' }); const s = Cli.newSession(d); sessions[d.name] = s; hist[d.name] = { l: [], i: 0 };
    const banner = d.type === 'host' ? 'Ubuntu 22.04 LTS (simulated) - type "help" for commands. Click a quick command below.' : d.type === 'ftd' ? 'Cisco Secure Firewall Threat Defense (simulated) - policy lives in the FMC GUI. Type ? for CLI help.' : d.label + ' (simulated CLI)\nType ? for help (works after any word), press Tab to complete, abbreviations work (sh ip int br).\nClick a quick command below to insert it.';
    out.append(h('div', {}, banner));
    const inp = h('input', { class: 'tin', spellcheck: 'false', autocomplete: 'off' }); const pr = h('span', { class: 'pr' }, Cli.prompt(d, s));
    const chips = h('div', { class: 'chips' });
    const row = h('div', { class: 'trow' }, pr, inp);
    const renderChips = () => { chips.innerHTML = ''; chips.append(h('span', { class: 'dim' }, 'Quick commands: ')); Cli.suggest(d, s).forEach(c => chips.append(h('button', { onclick: () => { inp.value = c.endsWith('?') ? '' : c; if (c === '?') { echo('?'); } inp.focus(); } }, c))); };
    const echo = (line) => { out.append(h('div', {}, h('span', { class: 'pr' }, Cli.prompt(d, s)), line)); };
    inp.addEventListener('keydown', ev => {
      const H = hist[d.name];
      if (ev.key === '?' && d.type !== 'host') { ev.preventDefault(); echo(inp.value + '?'); out.append(h('pre', { class: 'res' }, Cli.help(L, d, s, inp.value))); out.scrollTop = out.scrollHeight; return; }
      if (ev.key === 'Tab') { ev.preventDefault(); const r = Cli.complete(L, d, s, inp.value); if (r.line !== undefined) inp.value = r.line; if (r.options && r.options.length > 1) { echo(inp.value); out.append(h('pre', { class: 'res' }, r.options.join('   '))); out.scrollTop = out.scrollHeight; } return; }
      if (ev.key === 'Enter') { const line = inp.value; echo(line); inp.value = ''; if (line.trim()) { H.l.push(line); H.i = H.l.length; }
        if (line.trim() === 'clear' && d.type === 'host') out.innerHTML = ''; else { lastAnim = null; const res = Cli.exec(L, d, s, line); if (res) out.append(h('pre', { class: 'res' + (/^\s*\^|^(%|ERROR)/m.test(res) ? ' bad' : '') }, res)); }
        pr.textContent = Cli.prompt(d, s); out.scrollTop = out.scrollHeight; renderChips(); save(); runChecks(); if (lastAnim) animate(lastAnim); refreshLive(); refreshWins(); }
      else if (ev.key === 'ArrowUp') { if (H.i > 0) inp.value = H.l[--H.i]; ev.preventDefault(); }
      else if (ev.key === 'ArrowDown') { inp.value = H.i < H.l.length - 1 ? H.l[++H.i] : ''; if (H.i >= H.l.length - 1) H.i = H.l.length; ev.preventDefault(); }
    });
    renderChips();
    const w = h('div', { class: 'term', onclick: () => inp.focus() }, chips, out, row); terms[d.name] = w; w._inp = inp;
  }
  setTimeout(() => terms[d.name]._inp.focus(), 0); return terms[d.name];
}
function refreshLive() { drawTopo(); }
function browser(d) {
  if (brs[d.name]) return brs[d.name];
  const url = h('input', { class: 'url', value: 'http://172.16.1.10', spellcheck: 'false' }), proxy = h('input', { class: 'px', placeholder: 'proxy ip:port (e.g. 172.16.1.30:3128)', value: '', spellcheck: 'false' }); const page = h('div', { class: 'page' }, 'Pick a bookmark below or type an address, then press Go. Hostnames (www.facebook.com) work too; set a Proxy to browse through the WSA.');
  const go = () => { lastAnim = null; const v = url.value.trim(); const full = /^https?:\/\//.test(v) ? v : 'http://' + v; const isIpU = /^https?:\/\/[\d.]+(:\d+)?(\/.*)?$/.test(full); page.innerHTML = '';
    let r; if (isIpU && !proxy.value.trim()) { const u = /^https?:\/\/([\d.]+)(?::(\d+))?/.exec(full); const port = u[2] ? +u[2] : /^https/.test(full) ? 443 : 80; const f = flow(L, d.name, { proto: 'tcp', dst: u[1], dport: port }); r = { ok: f.ok, kind: f.kind, page: f.page, why: f.why, net: f, steps: [], status: f.ok ? 200 : 0 }; }
    else r = Sim.webGet(L, d.name, { url: full, proxy: proxy.value.trim() || null });
    if (r.net && r.net.path) lastAnim = r.net;
    if (r.ok) page.append(h('h2', {}, r.page || 'OK'), h('p', {}, '✔ HTTP 200 OK' + (r.via ? ' via ' + r.via : '') + (r.cat ? ' - category: ' + r.cat : '')));
    else if (r.kind === 'blocked' || r.kind === 'malware') page.append(h('h2', { class: 'bad' }, '⛔ Access Denied'), h('p', {}, r.why), h('p', { class: 'dim' }, 'This block page was served by the Secure Web Appliance.'));
    else page.append(h('h2', { class: 'bad' }, "This site can't be reached"), h('p', {}, r.status === 503 ? 'Proxy error 503: ' + r.why : r.kind === 'closed' ? 'Connection refused (nothing listening on that port).' : r.kind === 'dns' ? r.why : r.kind === 'unreach' || r.kind === 'prohibited' || r.kind === 'proxy' ? 'No route to host. ' + (r.why || '') : 'Connection timed out - something dropped the packet (firewall / ACL / missing NAT?).'), h('p', { class: 'dim' }, r.kind === 'dns' ? '' : r.why || ''));
    if (r.steps && r.steps.length) page.append(h('div', { class: 'steps' }, r.steps.map(s => h('div', { class: 'ph ' + (s.k === 'drop' ? 'drop' : s.k === 'ok' ? 'ok' : '') }, s.t))));
    save(); runChecks(); if (lastAnim) animate(lastAnim); drawTopo(); refreshWins(); };
  url.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  const bm = [['DMZ web', 'http://172.16.1.10'], ['Published DMZ', 'http://203.0.113.10'], ['Outside web', 'http://198.51.100.10'], ['FTD-Client web', 'http://10.2.1.10'], ['facebook', 'http://www.facebook.com'], ['cisco', 'http://www.cisco.com'], ['casino', 'http://www.casino-royal.com'], ['youtube', 'http://www.youtube.com'], ['HTTPS malware file', 'https://downloads.example.org/eicar.com'], ['HTTPS normal file', 'https://downloads.example.org/readme.txt']];
  const el = h('div', { class: 'browser' }, h('div', { class: 'bar' }, h('span', {}, '◀ ▶ ⟳'), url, h('button', { onclick: go }, 'Go')), h('div', { class: 'bar2' }, h('span', {}, 'Proxy:'), proxy, h('button', { onclick: () => { proxy.value = '172.16.1.30:3128'; } }, 'use WSA'), h('button', { onclick: () => { proxy.value = ''; } }, 'none')), h('div', { class: 'bms' }, bm.map(x => h('button', { onclick: () => { url.value = x[1]; go(); } }, x[0]))), page);
  brs[d.name] = el; return el;
}
function infoView(d) {
  if (d.type === 'switch') { const rows = Object.values(d.ifs).filter(x => !x.svi).map(x => h('tr', {}, h('td', {}, x.name), h('td', {}, (Sim.portOf && true) ? (x.auth === 'auto' ? '802.1X auto' : 'open') : ''), h('td', { class: x.state === 'authorized' ? 'up' : x.auth === 'auto' ? 'dn' : '' }, x.auth === 'auto' ? (x.state || 'unauth') : '-'), h('td', {}, x.user || ''), h('td', {}, x.profile || '')));
    return h('div', {}, h('h3', {}, d.label + ' - ports'), tbl(['Port', 'Access mode', '802.1X state', 'User', 'ISE profile'], rows), h('p', { class: 'dim' }, 'Layer-2 switch. Use its terminal: show vlan brief, show mac address-table, show authentication sessions. 802.1X: set the port to "authentication port-control auto".'), d.name === 'SW1' ? h('p', { class: 'dim' }, 'RADIUS: ' + (d.radius ? (d.radius.ip || '-') + ' key ' + (d.radius.key ? '****' : '-') : 'not configured') + ' | aaa new-model: ' + (d.aaa ? 'yes' : 'no') + ' | dot1x system-auth-control: ' + (d.dot1xGlobal ? 'yes' : 'no')) : null); }
  const rows = Object.values(d.ifs).map(x => h('tr', {}, h('td', {}, x.name), h('td', {}, x.nameif || ''), h('td', {}, x.ip ? x.ip + '/' + x.len : '-'), h('td', {}, x.up ? 'up' : 'down')));
  return h('div', {}, h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, 'Interface'), h('th', {}, 'Name'), h('th', {}, 'IP'), h('th', {}, 'State')), rows),
    d.routes.length ? h('p', {}, 'Routes: ' + d.routes.map(r => r.net + '/' + r.len + ' via ' + r.nh).join('; ')) : null, d.type === 'switch' ? h('p', { class: 'dim' }, 'Layer-2 switch: forwards frames transparently between R1 and the Client.') : null);
}

// ---------- GUI helpers ----------
const sel_ = (opts, v) => h('select', {}, opts.map(o => h('option', { value: o, selected: o === v }, o)));
const inp_ = (v, ph, w) => h('input', { value: v || '', placeholder: ph || '', style: w ? 'width:' + w : '' });
function tbl(head, rows) { return h('table', { class: 'tbl' }, h('tr', {}, head.map(x => h('th', {}, x))), rows); }
function notice(msg, bad) { const n = $('#toast'); n.textContent = msg; n.className = 'show ' + (bad ? 'bad' : ''); setTimeout(() => n.className = '', 3500); }
function apply(d, lines) { const err = Cli.runLines(L, d, lines); if (err.length) notice(err.join(' | '), true); else notice('Applied.'); commit(); }

// ---------- ASDM-like ----------

// ---------- FMC-like (FTD) ----------

function cliOut(d, cmd) { const s = Cli.newSession(d); s.mode = 'priv'; return Cli.exec(L, d, s, cmd); }
// ---- 802.1X login + mail client ----
let nacMsg = {};
function nacApp(d) {
  const p = Sim.portOf(L, d.name); if (!p) return h('p', {}, 'This PC is not connected to a managed switch port.');
  const mac = Cli.macOf(d.name, 'eth0'), u = inp_('alice', 'username', '150px'), pw = h('input', { type: 'password', value: 'Cisco123!', style: 'width:150px' });
  const go = (method) => { const r = Sim.iseAuth(L, { nas: p.sw.name, port: p.name, method, user: u.value, pass: pw.value, mac }); nacMsg[d.name] = { ok: r.ok, t: r.why }; commit(); notice(r.ok ? 'Network access granted.' : 'Authentication failed.', !r.ok); };
  const m = nacMsg[d.name], st = p.port.state;
  return h('div', {}, h('h3', {}, 'Network login - ' + d.label), h('p', {}, 'Connected to ' + p.sw.name + ' ' + p.name + '   |   Endpoint MAC ' + mac), h('p', {}, 'Port mode: ', p.port.auth === 'auto' ? h('b', {}, '802.1X enforced (port-control auto)') : h('b', { class: 'dim' }, 'open - no 802.1X (configure "authentication port-control auto" on the switch)'), '   |   State: ', h('b', { class: st === 'authorized' ? 'up' : 'dn' }, p.port.auth === 'auto' ? (st || 'unauthorized') : 'authorized (open)'), p.port.profile ? ' (' + p.port.profile + ')' : ''),
    h('div', { class: 'frm' }, 'User', u, 'Password', pw, h('button', { class: 'primary', onclick: () => go('dot1x') }, 'Log on (802.1X)'), h('button', { onclick: () => go('mab') }, 'Use MAC address (MAB)'), h('button', { onclick: () => { Sim.iseLogoff(L, d.name); nacMsg[d.name] = { ok: false, t: 'Logged off' }; commit(); } }, 'Log off')),
    m ? h('div', { class: 'ph ' + (m.ok ? 'ok' : 'drop') }, (m.ok ? '✔ ' : '✖ ') + m.t) : null, h('p', { class: 'dim' }, 'Demo users: alice (Employees), carl (Contractors) - password Cisco123!. For MAB, add this PC\'s MAC under ISE > Identities > Endpoints.'));
}
function mailForm(getHost, defaults) {
  const f = { from: inp_(defaults.from || 'bob@partner.com', 'from', '160px'), to: inp_('alice@lab.local', 'to', '160px'), sub: inp_('Quarterly report', 'subject', '180px'), body: h('textarea', { rows: 3, style: 'width:98%' }, 'Hello Alice, please see attached.'), att: sel_(['(none)', 'report.pdf', 'invoice.exe', 'eicar.com', 'macros.docm']), srv: inp_(defaults.server || '203.0.113.20', 'ESA IP', '120px') };
  const out = h('div', {});
  const send = () => { lastAnim = null; const r = Sim.esaSend(L, getHost(), { from: f.from.value, to: f.to.value, subject: f.sub.value, body: f.body.value, attach: f.att.value === '(none)' ? [] : [f.att.value], server: f.srv.value }); out.innerHTML = '';
    r.steps.forEach(s => out.append(h('div', { class: 'ph ' + (s.k === 'drop' ? 'drop' : s.k === 'warn' ? '' : 'ok') }, s.t))); out.append(h('div', { class: 'phr ' + (r.ok ? 'up' : 'dn') }, (r.ok ? '✔ ' : '✖ ') + 'Result: ' + (r.disp || '').toUpperCase() + (r.why ? ' - ' + r.why : '')));
    if (r.net && r.net.path) lastAnim = { ok: r.ok, path: r.net.path, at: r.net.at, kind: r.net.kind }; save(); runChecks(); drawTopo(); refreshWins(); if (lastAnim) animate(lastAnim); };
  return h('div', {}, h('div', { class: 'frm' }, 'From', f.from, 'To', f.to, 'Server', f.srv), h('div', { class: 'frm' }, 'Subject', f.sub, 'Attachment', f.att), f.body, h('div', { class: 'frm' }, h('button', { class: 'primary', onclick: send }, 'Send email')), out);
}
function mailApp(d) { return h('div', {}, h('h3', {}, 'Mail client - ' + d.label), h('p', { class: 'dim' }, 'Sends a real SMTP session through the network to the ESA. From Outside use the published address (203.0.113.20); from inside use 172.16.1.20.'), mailForm(() => d.name, { server: d.name === 'Outside' ? '203.0.113.20' : '172.16.1.20', from: 'bob@partner.com' })); }
// ---- ISE GUI ----
// ---- ESA GUI ----
// ---------- bridge for gui.js ----------
window.App = { get L() { return L; }, commit: safe(commit), notice, apply: safe(apply), cliOut, refreshWins, mailForm, setAnim: v => { lastAnim = v; },
  afterTool: () => { save(); runChecks(); if (lastAnim) animate(lastAnim); drawTopo(); }, afterTool2: null };
window.App.afterTool = function (net) { if (net && net.path) lastAnim = net; save(); runChecks(); drawTopo(); refreshWins(); if (lastAnim) animate(lastAnim); };
// ---------- self-test ----------
function selfTest() {
  const results = []; const T = (n, f) => { try { const r = f(); results.push([n, r !== false, r === false ? 'returned false' : '']); } catch (e) { results.push([n, false, e.message]); } };
  const snap = JSON.stringify(L), keep = Object.keys(wins);
  for (const k of Object.keys(wins)) closeWin(k);
  const devs = Object.keys(L.dev);
  for (const n of devs) { const d = L.dev[n];
    T(n + ': right-click menu', () => { showMenu(n, 100, 100); const ok = $('#ctx').children.length >= 3; $('#ctx').style.display = 'none'; return ok; });
    if (d.type !== 'switch' || true) T(n + ': terminal opens + command', () => { openWin(n, 'term'); const w = wins[n + ':term']; if (!w) return false; const s = sessions[n] || (sessions[n] = Cli.newSession(d)); const out = Cli.exec(L, d, s, d.type === 'host' ? 'ip addr' : d.role ? 'help' : d.type === 'ftd' ? 'show version' : 'show version'); closeWin(n + ':term'); return !!out; });
    if (guiKind(d)) T(n + ': GUI opens', () => { openWin(n, 'gui'); const k = (d.type === 'ftd' ? 'FMC1' : n) + ':gui'; const w = wins[k]; const ok = !!w && w.body.querySelector('.prod'); closeWin(k); return !!ok; });
    T(n + ': power off / on', () => { setPower(n, false); const off = L.dev[n].on === false; setPower(n, true); return off && L.dev[n].on !== false; }); }
  T('engine: packet simulation runs', () => typeof Sim.flow(clone(L), 'Client', { proto: 'icmp', dst: '198.51.100.10' }).ok === 'boolean');
  T('engine: web proxy simulation runs', () => typeof Sim.webGet(clone(L), 'Client', { url: 'http://www.cisco.com', proxy: '172.16.1.30:3128' }).ok === 'boolean');
  T('engine: mail simulation runs', () => typeof Sim.esaSend(clone(L), 'Outside', { from: 'a@partner.com', to: 'b@lab.local', subject: 's', body: 'b', attach: [], server: '203.0.113.20' }).ok === 'boolean');
  try { L = JSON.parse(snap); } catch (e) { } for (const k of Object.keys(wins)) closeWin(k); save(); runChecks(); drawTopo();
  const m = $('#modal'); m.innerHTML = ''; m.style.display = 'flex'; const bad = results.filter(r => !r[1]);
  m.append(h('div', { class: 'mbox' }, h('h2', {}, 'Self-test: ' + (bad.length ? bad.length + ' problem(s)' : 'all ' + results.length + ' checks passed')), h('p', { class: 'dim' }, 'Right-click menus, terminals, GUIs and power on/off were exercised for every device on THIS browser.'),
    h('div', { class: 'stlist' }, results.map(r => h('div', { class: r[1] ? 'up' : 'dn' }, (r[1] ? '✔ ' : '✖ ') + r[0] + (r[2] ? ' - ' + r[2] : '')))), h('div', { style: 'text-align:right;margin-top:10px' }, h('button', { class: 'primary', onclick: () => { m.style.display = 'none'; } }, 'Close'))));
  return results;
}
window.App.selfTest = selfTest;
// ---------- boot ----------
function boot() {
  load(); drawTopo(); runChecks(); startScreen();
  $('#reset').addEventListener('click', () => { if (confirm('Reset the whole lab to its starting state?')) { try { localStorage.removeItem(KEY); } catch (e) {} terms = {}; sessions = {}; brs = {}; for (const k of Object.keys(wins)) closeWin(k); L = newLab(); commit(); startScreen(); } });
  $('#devs').addEventListener('click', safe(startScreen)); $('#selftest').addEventListener('click', safe(selfTest));
}
window.addEventListener('DOMContentLoaded', boot);
})();
