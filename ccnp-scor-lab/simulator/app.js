// SCOR Lab Simulator - UI
(function () {
'use strict';
const { flow, packetTracer, clone, newLab, ftdDeploy } = Sim;
const KEY = 'scor-sim-v1';
let L = null, sel = 'Client', tabs = {}, lastAnim = null, sessions = {}, terms = {}, hist = {};
const $ = s => document.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) { if (k === 'class') e.className = attrs[k]; else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]); else if (k === 'html') e.innerHTML = attrs[k]; else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]); }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const svgNS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, ...kids) { const e = document.createElementNS(svgNS, tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); for (const c of kids) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c)); return e; }

function load() { try { const j = localStorage.getItem(KEY); if (j) { L = JSON.parse(j); if (L.ver === 3) return; } } catch (e) {} L = newLab(); }
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
function drawTopo() {
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
    g.addEventListener('click', () => { sel = n; drawTopo(); });
    g.addEventListener('dblclick', () => openWin(n, d.type === 'host' ? 'browser' : 'term'));
    g.addEventListener('contextmenu', ev => { ev.preventDefault(); sel = n; drawTopo(); showMenu(n, ev.clientX, ev.clientY); });
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
  const item = (t, f, dis) => m.append(h('div', { class: 'mi' + (dis ? ' dis' : ''), onclick: () => { m.style.display = 'none'; if (!dis) f(); } }, t));
  m.append(h('div', { class: 'mh' }, d.label + (on ? '' : '  (powered off)')));
  if (d.role) { item('Open GUI (' + guiKind(d) + ')', () => openWin(n, 'gui'), !on); item('Open Terminal / CLI', () => openWin(n, 'term'), !on); }
  else if (d.type === 'host') { item('Open Desktop (browser)', () => openWin(n, 'browser'), !on); item('Open Terminal', () => openWin(n, 'term'), !on); item('Open Mail client', () => openWin(n, 'mail'), !on); if (Sim.portOf(L, n)) item('Network login (802.1X)', () => openWin(n, 'nac'), !on); }
  else if (d.type === 'switch') { item('Open Terminal / Console', () => openWin(n, 'term'), !on); item('Open GUI (Switch manager)', () => openWin(n, 'gui'), !on); item('Port / 802.1X status', () => openWin(n, 'info'), !on); }
  else { item('Open Terminal / Console', () => openWin(n, 'term'), !on); if (guiKind(d)) item('Open GUI (' + guiKind(d) + (d.type === 'ftd' ? ', managed by FMC1' : '') + ')', () => openWin(n, 'gui'), !on); else item('Device info', () => openWin(n, 'info'), !on); }
  m.append(h('div', { class: 'ms' })); item(on ? 'Power off' : 'Power on', () => setPower(n, !on));
  m.style.left = Math.min(x, innerWidth - 230) + 'px'; m.style.top = Math.min(y, innerHeight - 190) + 'px'; m.style.display = 'block';
}
document.addEventListener('click', () => { const m = $('#ctx'); if (m) m.style.display = 'none'; });
function setPower(n, on) {
  const d = L.dev[n]; d.on = on;
  if (!on) { for (const k of Object.keys(wins)) if (wins[k].dn === n) closeWin(k); if (d.conns) { d.conns.length = 0; d.xlates.length = 0; } }
  commit(); notice(d.label + (on ? ' powered on.' : ' powered off.'));
}
function closeWin(k) { const w = wins[k]; if (!w) return; w.el.remove(); delete wins[k]; $('#deskhint').style.display = Object.keys(wins).length ? 'none' : 'block'; }
function front(w) { w.el.style.zIndex = ++zTop; }
function fillWin(w) {
  const d = L.dev[w.dn]; w.body.innerHTML = '';
  if (w.kind === 'term') w.body.append(terminal(d));
  else if (w.kind === 'browser') w.body.append(browser(d));
  else if (w.kind === 'gui') w.body.append(d.type === 'asa' ? asdm(d) : d.type === 'router' ? routerGui(d) : d.type === 'switch' ? switchGui(d) : d.role === 'ise' ? iseGui(d) : d.role === 'esa' ? esaGui(d) : d.role === 'wsa' ? wsaGui(d) : fmc(L.dev.FTD1));
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
  const el = h('div', { class: 'win', style: 'left:' + (14 + (cnt % 6) * 30) + 'px;top:' + (14 + (cnt % 6) * 30) + 'px' }, h('div', { class: 'wbar' }, h('span', {}, title), h('button', { class: 'wx', onclick: () => closeWin(k) }, '✕')), body);
  const w = wins[k] = { el, body, dn: n, kind }; fillWin(w); $('#desk').append(el); $('#deskhint').style.display = 'none'; front(w);
  el.addEventListener('mousedown', () => front(w));
  const bar = el.firstChild; let ox, oy, dragging = false;
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
function sub(names, key, render) {
  const k = 'sub:' + key; tabs[k] = names.includes(tabs[k]) ? tabs[k] : names[0];
  return h('div', {}, h('div', { class: 'subnav' }, names.map(n => h('button', { class: tabs[k] === n ? 'on' : '', onclick: () => { tabs[k] = n; renderPanel(); } }, n))), h('div', { class: 'subbody' }, render(tabs[k])));
}
const sel_ = (opts, v) => h('select', {}, opts.map(o => h('option', { value: o, selected: o === v }, o)));
const inp_ = (v, ph, w) => h('input', { value: v || '', placeholder: ph || '', style: w ? 'width:' + w : '' });
function tbl(head, rows) { return h('table', { class: 'tbl' }, h('tr', {}, head.map(x => h('th', {}, x))), rows); }
function notice(msg, bad) { const n = $('#toast'); n.textContent = msg; n.className = 'show ' + (bad ? 'bad' : ''); setTimeout(() => n.className = '', 3500); }
function apply(d, lines) { const err = Cli.runLines(L, d, lines); if (err.length) notice(err.join(' | '), true); else notice('Applied.'); commit(); }

// ---------- ASDM-like ----------
function asdm(d) {
  const nameifs = Object.values(d.ifs).map(x => x.nameif);
  return sub(['Home', 'Interfaces', 'Access Rules', 'NAT Rules', 'Routing', 'Packet Tracer', 'Monitoring', 'Tools', 'Config'], 'asdm', t => {
    if (t === 'Tools') return toolsPane(d);
    if (t === 'Config') return h('pre', { class: 'cfgpre' }, cliOut(d, 'show running-config'));
    if (t === 'Home') return h('div', {}, h('h3', {}, 'Device Dashboard - ' + d.hostname), tbl(['Interface', 'Name', 'IP / mask', 'Security', 'Status'], Object.values(d.ifs).map(x => h('tr', {}, h('td', {}, x.name), h('td', {}, x.nameif), h('td', {}, x.ip + '/' + x.len), h('td', {}, x.sec), h('td', { class: x.up ? 'up' : 'dn' }, x.up ? '● up' : '● down')))), h('p', {}, 'Connections: ' + d.conns.length + '   |   NAT rules: ' + d.nats.length + '   |   ACLs: ' + Object.keys(d.acls).length));
    if (t === 'Interfaces') { const f = { n: sel_(Object.keys(d.ifs)), nm: inp_('', 'nameif', '80px'), ip: inp_('', 'IP', '110px'), m: inp_('255.255.255.0', 'mask', '110px'), sec: inp_('', 'sec', '45px') };
      return h('div', {}, tbl(['Interface', 'Name', 'IP', 'Mask', 'Level'], Object.values(d.ifs).map(x => h('tr', {}, h('td', {}, x.name), h('td', {}, x.nameif), h('td', {}, x.ip), h('td', {}, Cli.exec ? Sim.lenToMask(x.len) : ''), h('td', {}, x.sec)))), h('h4', {}, 'Edit interface'), h('div', { class: 'frm' }, f.n, f.nm, f.ip, f.m, f.sec, h('button', { onclick: () => apply(d, ['interface ' + f.n.value, f.nm.value ? 'nameif ' + f.nm.value : '', f.sec.value ? 'security-level ' + f.sec.value : '', f.ip.value ? 'ip address ' + f.ip.value + ' ' + f.m.value : ''].filter(Boolean)) }, 'Apply'))); }
    if (t === 'Access Rules') { const f = { acl: inp_('OUT-IN', 'ACL name', '90px'), act: sel_(['permit', 'deny']), pr: sel_(['tcp', 'udp', 'icmp', 'ip']), st: sel_(['any', 'host', 'network']), sv: inp_('', 'src ip/obj', '110px'), dt: sel_(['host', 'any', 'object', 'network']), dv: inp_('172.16.1.10', 'dst ip/obj', '110px'), op: inp_('80', 'port', '55px'), ifc: sel_(['(none)'].concat(nameifs), 'outside') };
      const addr = (t, v) => t === 'any' ? 'any' : t === 'host' ? 'host ' + v : t === 'object' ? 'object ' + v : v.replace('/', ' ').replace(/\/(\d+)/, ''); 
      const rows = []; for (const [n, es] of Object.entries(d.acls)) es.forEach((e, i) => rows.push(h('tr', {}, h('td', {}, n), h('td', {}, i + 1), h('td', { class: e.action === 'permit' ? 'up' : 'dn' }, e.action), h('td', {}, Sim.aclText(e, 'asa').replace(/^(permit|deny) /, '')), h('td', {}, e.hits || 0), h('td', {}, h('button', { class: 'x', onclick: () => apply(d, ['no access-list ' + n + ' extended ' + Sim.aclText(e, 'asa')]) }, '✕')))));
      return h('div', {}, tbl(['ACL', '#', 'Action', 'Rule', 'Hits', ''], rows), h('p', { class: 'dim' }, 'ACLs match the REAL (un-NATed) destination address. Applied inbound on an interface; no ACL = security-level default.'), h('h4', {}, 'Add rule'),
        h('div', { class: 'frm' }, f.acl, f.act, f.pr, 'src', f.st, f.sv, 'dst', f.dt, f.dv, 'port', f.op, 'apply on', f.ifc, h('button', { onclick: () => { let sv_ = f.st.value === 'network' ? f.sv.value.split('/') : [f.sv.value]; const src = f.st.value === 'any' ? 'any' : f.st.value === 'host' ? 'host ' + f.sv.value : sv_[0] + ' ' + Sim.lenToMask(+sv_[1] || 24); const dd = f.dt.value === 'network' ? f.dv.value.split('/') : [f.dv.value]; const dst = f.dt.value === 'any' ? 'any' : f.dt.value === 'host' ? 'host ' + f.dv.value : f.dt.value === 'object' ? 'object ' + f.dv.value : dd[0] + ' ' + Sim.lenToMask(+dd[1] || 24);
          const port = (f.pr.value === 'tcp' || f.pr.value === 'udp') && f.op.value ? ' eq ' + f.op.value : ''; const ln = ['access-list ' + f.acl.value + ' extended ' + f.act.value + ' ' + f.pr.value + ' ' + src + ' ' + dst + port]; if (f.ifc.value !== '(none)') ln.push('access-group ' + f.acl.value + ' in interface ' + f.ifc.value); apply(d, ln); } }, 'Add')));
    }
    if (t === 'NAT Rules') { const s = { ip: inp_('172.16.1.10', 'real host', '110px'), ri: sel_(nameifs, 'dmz'), mi: sel_(nameifs, 'outside'), mp: inp_('203.0.113.10', 'mapped IP', '110px') }; const p = { net: inp_('10.1.0.0/16', 'network/len', '120px'), ri: sel_(nameifs, 'inside'), mi: sel_(nameifs, 'outside') };
      return h('div', {}, tbl(['#', 'Type', 'Object', 'Real if', 'Mapped if', 'Mapped', ''], d.nats.map((n, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, n.kind), h('td', {}, n.obj), h('td', {}, n.realIf), h('td', {}, n.mappedIf), h('td', {}, n.mapped), h('td', {}, h('button', { class: 'x', onclick: () => apply(d, ['no object network ' + n.obj]) }, '✕'))))),
        h('h4', {}, 'Add static NAT (publish a server)'), h('div', { class: 'frm' }, 'real', s.ip, s.ri, '→ mapped', s.mp, s.mi, h('button', { onclick: () => apply(d, ['object network OBJ-' + s.ip.value, 'host ' + s.ip.value, 'nat (' + s.ri.value + ',' + s.mi.value + ') static ' + s.mp.value]) }, 'Add')),
        h('h4', {}, 'Add dynamic PAT (interface)'), h('div', { class: 'frm' }, p.net, p.ri, '→', p.mi, h('button', { onclick: () => { const [n, l] = p.net.value.split('/'); apply(d, ['object network NET-' + n, 'subnet ' + n + ' ' + Sim.lenToMask(+l || 24), 'nat (' + p.ri.value + ',' + p.mi.value + ') dynamic interface']); } }, 'Add'))); }
    if (t === 'Routing') { const f = { i: sel_(nameifs, 'outside'), n: inp_('0.0.0.0/0', 'network/len', '120px'), g: inp_('', 'gateway', '110px') };
      return h('div', {}, tbl(['Network', 'Gateway', 'Interface', ''], d.routes.map(r => h('tr', {}, h('td', {}, r.net + '/' + r.len), h('td', {}, r.nh), h('td', {}, r.nameif), h('td', {}, h('button', { class: 'x', onclick: () => apply(d, ['no route ' + r.nameif + ' ' + r.net + ' ' + Sim.lenToMask(r.len) + ' ' + r.nh]) }, '✕'))))), h('h4', {}, 'Add static route'), h('div', { class: 'frm' }, f.i, f.n, 'via', f.g, h('button', { onclick: () => { const [n, l] = f.n.value.split('/'); apply(d, ['route ' + f.i.value + ' ' + n + ' ' + Sim.lenToMask(+l || 0) + ' ' + f.g.value]); } }, 'Add'))); }
    if (t === 'Packet Tracer') { const f = { i: sel_(nameifs, 'outside'), p: sel_(['tcp', 'udp', 'icmp']), s: inp_('198.51.100.10', 'src ip', '110px'), sp: inp_('1234', 'sport', '55px'), d: inp_('203.0.113.10', 'dst ip', '110px'), dp: inp_('80', 'dport', '55px') }; const res = h('div', {});
      return h('div', {}, h('div', { class: 'frm' }, 'ingress', f.i, f.p, f.s, f.sp, '→', f.d, f.dp, h('button', { onclick: () => { const r = packetTracer(L, d.name, f.i.value, { proto: f.p.value, src: f.s.value, sport: +f.sp.value, dst: f.d.value, dport: +f.dp.value }); res.innerHTML = ''; r.trace.forEach((x, i) => res.append(h('div', { class: 'ph ' + x.kind }, h('b', {}, 'Phase ' + (i + 1) + ': '), x.t)));
        const bad = r.o.st === 'drop' || r.o.st === 'noroute'; res.append(h('div', { class: 'phr ' + (bad ? 'dn' : 'up') }, bad ? '✖ Result: DROP - ' + r.o.why : '✔ Result: ALLOW')); } }, 'Start')), res); }
    if (t === 'Monitoring') return h('div', {}, h('button', { onclick: () => renderPanel() }, '⟳ Refresh'), h('button', { onclick: () => { d.conns.length = 0; d.xlates.length = 0; commit(); } }, 'Clear conns'), h('h4', {}, 'Connections (' + d.conns.length + ')'), tbl(['Proto', 'Initiator', 'Responder', 'In', 'Out', 'Hits'], d.conns.slice(-12).map(c => h('tr', {}, h('td', {}, c.proto), h('td', {}, c.in.src + ':' + c.in.sport), h('td', {}, c.in.dst + ':' + c.in.dport), h('td', {}, d.ifs[c.in.if].nameif), h('td', {}, d.ifs[c.out.if].nameif), h('td', {}, c.hits)))));
    return null;
  });
}

// ---------- FMC-like (FTD) ----------
function fmcOverview(d) {
  const ev = d.events, al = ev.filter(e => e.action === 'Allow').length, bl = ev.length - al; const srcs = {}; ev.filter(e => e.action === 'Block').forEach(e => srcs[e.src] = (srcs[e.src] || 0) + 1);
  return h('div', {}, h('h3', {}, 'Firepower Management Center (FMC1) - Overview'), tbl(['Device', 'Mgmt IP', 'Model', 'Health', 'Access policy', 'Deployment'], [h('tr', {}, h('td', {}, 'FTD1'), h('td', {}, '192.168.100.12'), h('td', {}, 'Secure Firewall Threat Defense (virtual)'), h('td', { class: 'up' }, '● Healthy'), h('td', {}, 'Initial_Access_Policy (' + d.policy.rules.length + ' rules)'), h('td', { class: d.dirty ? 'warn' : 'up' }, d.dirty ? 'Pending changes' : 'Up to date'))]),
    h('div', { class: 'tiles' }, [['Allowed', al], ['Blocked', bl], ['Connections', d.conns.length], ['Rules', d.policy.rules.length]].map(([k, v]) => h('div', { class: 'tile' }, h('b', {}, v), h('span', {}, k)))),
    h('h4', {}, 'Top blocked sources'), tbl(['Source IP', 'Blocks'], Object.entries(srcs).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v)))), h('p', { class: 'dim' }, 'Configure under Interfaces / Routing / NAT / Access Policy, then press Deploy (top right). Events shows every allow/block decision.'));
}
function fmc(d) {
  const dr = d.draft, zones = ['any'].concat([...new Set(Object.values(dr.ifs).map(x => x.zone).filter(Boolean))]);
  const dirty = () => { d.dirty = true; save(); drawTopo(); renderPanel(); };
  return h('div', {}, h('div', { class: 'deploy' }, d.dirty ? h('span', { class: 'warn' }, '● Pending changes - not active until deployed') : h('span', { class: 'up' }, '✔ Policy deployed'), h('button', { class: 'primary', disabled: !d.dirty, onclick: () => { ftdDeploy(d); notice('Deployment to FTD1 complete.'); commit(); } }, 'Deploy')),
    sub(['Overview', 'Interfaces', 'Routing', 'NAT', 'Access Policy', 'Events'], 'fmc', t => {
      if (t === 'Overview') return fmcOverview(d);
      if (t === 'Interfaces') return h('div', {}, tbl(['Interface', 'Name', 'Security zone', 'IPv4 / len', 'Enabled', ''], Object.values(dr.ifs).map(x => { const z = inp_(x.zone, 'zone', '70px'), ip = inp_(x.ip, 'x.x.x.x', '110px'), ln = inp_(x.len, 'len', '40px'), en = h('input', { type: 'checkbox', checked: x.up });
        return h('tr', {}, h('td', {}, x.name), h('td', {}, x.nameif), h('td', {}, z), h('td', {}, ip, '/', ln), h('td', {}, en), h('td', {}, h('button', { onclick: () => { x.zone = z.value.trim(); x.ip = ip.value.trim() || null; x.len = +ln.value || 24; x.up = en.checked; dirty(); } }, 'Save'))); })), h('p', { class: 'dim' }, 'Pre-configured: Gi0/0 zone OUT 192.0.2.1/24 (to R2), Gi0/1 zone IN 10.2.1.1/24 (to FTD-Client). Edit, then press Deploy.'));
      if (t === 'Routing') { const f = { n: inp_('0.0.0.0/0', 'network/len', '120px'), g: inp_('192.0.2.2', 'gateway', '110px') };
        return h('div', {}, tbl(['Network', 'Gateway', ''], dr.routes.map((r, i) => h('tr', {}, h('td', {}, r.net + '/' + r.len), h('td', {}, r.nh), h('td', {}, h('button', { class: 'x', onclick: () => { dr.routes.splice(i, 1); dirty(); } }, '✕'))))), h('h4', {}, 'Add static route'), h('div', { class: 'frm' }, f.n, 'via', f.g, h('button', { onclick: () => { const [n, l] = f.n.value.split('/'); dr.routes.push({ net: n, len: +l || 0, nh: f.g.value }); dirty(); } }, 'Add'))); }
      if (t === 'NAT') { const f = { s: inp_('IN', 'src zone', '70px'), d: inp_('OUT', 'dst zone', '70px') };
        return h('div', {}, tbl(['Type', 'Source zone', 'Destination zone', ''], dr.nat.map((n, i) => h('tr', {}, h('td', {}, 'Dynamic PAT (interface)'), h('td', {}, n.srcZone), h('td', {}, n.dstZone), h('td', {}, h('button', { class: 'x', onclick: () => { dr.nat.splice(i, 1); dirty(); } }, '✕'))))), h('h4', {}, 'Add PAT rule'), h('div', { class: 'frm' }, f.s, '→', f.d, h('button', { onclick: () => { dr.nat.push({ srcZone: f.s.value.trim(), dstZone: f.d.value.trim() }); dirty(); } }, 'Add'))); }
      if (t === 'Access Policy') { const f = { n: inp_('Allow-IN-OUT', 'name', '110px'), s: inp_('IN', 'src zone', '60px'), d: inp_('OUT', 'dst zone', '60px'), sn: inp_('any', 'src net', '100px'), dn: inp_('any', 'dst net', '100px'), p: sel_(['any', 'tcp', 'udp', 'icmp']), pt: inp_('', 'port', '55px'), a: sel_(['allow', 'block']), ips: h('input', { type: 'checkbox' }), pos: sel_(['top', 'bottom']) };
        const defSel = sel_(['block', 'allow'], dr.policy.defaultAction); defSel.addEventListener('change', () => { dr.policy.defaultAction = defSel.value; dirty(); });
        return h('div', {}, tbl(['#', 'Name', 'Src zone', 'Dst zone', 'Src net', 'Dst net', 'Proto/Port', 'Action', 'IPS', 'Hits', ''], dr.policy.rules.map((r, i) => { const ips = h('input', { type: 'checkbox', checked: r.ips }); ips.addEventListener('change', () => { r.ips = ips.checked; dirty(); });
            return h('tr', {}, h('td', {}, i + 1), h('td', {}, r.name), h('td', {}, r.srcZone), h('td', {}, r.dstZone), h('td', {}, r.srcNet), h('td', {}, r.dstNet), h('td', {}, r.proto + (r.dport ? '/' + r.dport : '')), h('td', { class: r.action === 'allow' ? 'up' : 'dn' }, r.action), h('td', {}, ips), h('td', {}, r.hits || 0), h('td', {}, h('button', { title: 'move up', disabled: i === 0, onclick: () => { const [x] = dr.policy.rules.splice(i, 1); dr.policy.rules.splice(i - 1, 0, x); dirty(); } }, '↑'), h('button', { class: 'x', onclick: () => { dr.policy.rules.splice(i, 1); dirty(); } }, '✕'))); })),
          h('p', {}, 'Default action: ', defSel, h('span', { class: 'dim' }, '  (Block All Traffic = anything not explicitly allowed is dropped)')),
          h('h4', {}, 'Add access control rule'), h('div', { class: 'frm' }, f.n, f.s, '→', f.d, f.sn, f.dn, f.p, f.pt, f.a, h('label', {}, f.ips, ' IPS'), 'position', f.pos, h('button', { onclick: () => { dr.policy.rules[f.pos.value === 'top' ? 'unshift' : 'push']({ name: f.n.value, srcZone: f.s.value.trim() || 'any', dstZone: f.d.value.trim() || 'any', srcNet: f.sn.value || 'any', dstNet: f.dn.value || 'any', proto: f.p.value, dport: f.pt.value ? +f.pt.value : null, action: f.a.value, ips: f.ips.checked }); dirty(); } }, 'Add'))); }
      if (t === 'Events') return h('div', {}, h('button', { onclick: () => renderPanel() }, '⟳ Refresh'), tbl(['Action', 'Src', 'Dst', 'Proto', 'Port', 'Rule', 'Reason'], d.events.slice(0, 25).map(e => h('tr', {}, h('td', { class: e.action === 'Allow' ? 'up' : 'dn' }, e.action), h('td', {}, e.src), h('td', {}, e.dst), h('td', {}, e.proto), h('td', {}, e.dport), h('td', {}, e.rule), h('td', {}, e.why)))));
      return null; }));
}

function cliOut(d, cmd) { const s = Cli.newSession(d); s.mode = 'priv'; return Cli.exec(L, d, s, cmd); }
function toolsPane(d) {
  const t = inp_('10.1.1.1', 'target ip', '130px'), out = h('pre', { class: 'cfgpre' }, 'Run ping / traceroute from this device.');
  const run = c => { lastAnim = null; out.textContent = cliOut(d, c + ' ' + t.value); save(); runChecks(); if (lastAnim) animate(lastAnim); drawTopo(); };
  return h('div', {}, h('div', { class: 'frm' }, 'Target', t, h('button', { onclick: () => run('ping') }, 'Ping'), h('button', { onclick: () => run('traceroute') }, 'Traceroute')), out);
}
const wild = len => Sim.n2ip((~Sim.ip2n(Sim.lenToMask(len))) >>> 0);
function iosAddr(type, v) { if (type === 'any') return 'any'; if (type === 'host') return 'host ' + v; const [n, l] = v.split('/'); return n + ' ' + wild(+l || 24); }
function routerGui(d) {
  const acls = Object.keys(d.acls), ifs = Object.keys(d.ifs);
  return sub(['Dashboard', 'Interfaces', 'Routing', 'ACLs', 'Tools', 'Running config'], 'rtr' + d.name, t => {
    if (t === 'Dashboard') return h('div', {}, h('h3', {}, d.hostname + ' - Router web manager (simulated)'), tbl(['Interface', 'IP / mask', 'Status', 'ACL in', 'ACL out'], Object.values(d.ifs).map(x => h('tr', {}, h('td', {}, x.name), h('td', {}, x.ip ? x.ip + '/' + x.len : '-'), h('td', { class: x.up ? 'up' : 'dn' }, x.up ? '● up' : '● down'), h('td', {}, x.aclIn || '-'), h('td', {}, x.aclOut || '-')))), h('p', {}, 'Static routes: ' + d.routes.length + '   |   ACLs: ' + acls.length));
    if (t === 'Interfaces') { const f = { n: sel_(ifs), ip: inp_('', 'IP address', '120px'), m: inp_('255.255.255.0', 'mask', '120px'), en: h('input', { type: 'checkbox', checked: true }), ai: sel_(['(none)'].concat(acls)), ao: sel_(['(none)'].concat(acls)) };
      return h('div', {}, tbl(['Interface', 'IP / mask', 'State'], Object.values(d.ifs).map(x => h('tr', {}, h('td', {}, x.name), h('td', {}, x.ip ? x.ip + '/' + x.len : '-'), h('td', {}, x.up ? 'up' : 'down')))), h('h4', {}, 'Edit interface'), h('div', { class: 'frm' }, f.n, f.ip, f.m, h('label', {}, f.en, ' enabled'), 'ACL in', f.ai, 'ACL out', f.ao, h('button', { onclick: () => { const x = d.ifs[f.n.value]; const ln = ['interface ' + x.name]; if (f.ip.value) ln.push('ip address ' + f.ip.value + ' ' + f.m.value); ln.push(f.en.checked ? 'no shutdown' : 'shutdown');
        if (x.aclIn && f.ai.value === '(none)') ln.push('no ip access-group ' + x.aclIn + ' in'); else if (f.ai.value !== '(none)') ln.push('ip access-group ' + f.ai.value + ' in'); if (x.aclOut && f.ao.value === '(none)') ln.push('no ip access-group ' + x.aclOut + ' out'); else if (f.ao.value !== '(none)') ln.push('ip access-group ' + f.ao.value + ' out'); apply(d, ln); } }, 'Apply'))); }
    if (t === 'Routing') { const f = { n: inp_('0.0.0.0/0', 'network/len', '120px'), g: inp_('', 'next hop', '110px') };
      return h('div', {}, tbl(['Type', 'Network', 'Next hop / interface', ''], Object.values(d.ifs).filter(x => x.up && x.ip).map(x => h('tr', {}, h('td', {}, 'connected'), h('td', {}, Sim.n2ip((Sim.ip2n(x.ip) & Sim.ip2n(Sim.lenToMask(x.len))) >>> 0) + '/' + x.len), h('td', {}, x.name), h('td', {}))).concat(d.routes.map(r => h('tr', {}, h('td', {}, 'static'), h('td', {}, r.net + '/' + r.len), h('td', {}, r.nh), h('td', {}, h('button', { class: 'x', onclick: () => apply(d, ['no ip route ' + r.net + ' ' + Sim.lenToMask(r.len) + ' ' + r.nh]) }, '✕')))))), h('h4', {}, 'Add static route'), h('div', { class: 'frm' }, f.n, 'via', f.g, h('button', { onclick: () => { const [n, l] = f.n.value.split('/'); apply(d, ['ip route ' + n + ' ' + Sim.lenToMask(+l || 0) + ' ' + f.g.value]); } }, 'Add'))); }
    if (t === 'ACLs') { const f = { acl: inp_(acls[0] || 'BLOCK', 'ACL name', '100px'), act: sel_(['permit', 'deny']), pr: sel_(['tcp', 'udp', 'icmp', 'ip']), st: sel_(['any', 'host', 'network']), sv: inp_('', 'src', '100px'), dt: sel_(['host', 'any', 'network']), dv: inp_('172.16.1.10', 'dst', '100px'), op: inp_('80', 'port', '50px'), ifc: sel_(['(none)'].concat(ifs)), dir: sel_(['in', 'out']) };
      const rows = []; for (const [n, es] of Object.entries(d.acls)) es.forEach((e, i) => rows.push(h('tr', {}, h('td', {}, n), h('td', {}, (i + 1) * 10), h('td', { class: e.action === 'permit' ? 'up' : 'dn' }, e.action), h('td', {}, Sim.aclText(e, 'ios').replace(/^(permit|deny) /, '')), h('td', {}, e.hits || 0), h('td', {}, h('button', { class: 'x', onclick: () => apply(d, ['ip access-list extended ' + n, 'no ' + Sim.aclText(e, 'ios')]) }, '✕')))));
      return h('div', {}, tbl(['ACL', 'Seq', 'Action', 'Rule', 'Hits', ''], rows), h('p', { class: 'dim' }, 'Rules are checked top-down; end with permit ip any any or everything else is denied (implicit deny).'), h('h4', {}, 'Add rule'), h('div', { class: 'frm' }, f.acl, f.act, f.pr, 'src', f.st, f.sv, 'dst', f.dt, f.dv, 'port', f.op, 'apply to', f.ifc, f.dir, h('button', { onclick: () => { const port = (f.pr.value === 'tcp' || f.pr.value === 'udp') && f.op.value ? ' eq ' + f.op.value : ''; const ln = ['ip access-list extended ' + f.acl.value, f.act.value + ' ' + f.pr.value + ' ' + iosAddr(f.st.value, f.sv.value) + ' ' + iosAddr(f.dt.value, f.dv.value) + port]; if (f.ifc.value !== '(none)') ln.push('interface ' + f.ifc.value, 'ip access-group ' + f.acl.value + ' ' + f.dir.value); apply(d, ln); } }, 'Add')));
    }
    if (t === 'Tools') return toolsPane(d);
    return h('pre', { class: 'cfgpre' }, cliOut(d, 'show running-config'));
  });
}
function switchGui(d) {
  const ports = Object.keys(d.ifs).filter(k => !d.ifs[k].svi), vl = Object.keys(d.vlans);
  return sub(['Dashboard', 'Ports', 'VLANs', '802.1X / NAC', 'MAC table', 'Running config', 'Tools'], 'sw' + d.name, t => {
    if (t === 'Dashboard') return h('div', {}, h('h3', {}, d.hostname + ' - Switch manager (simulated)'), tbl(['Port', 'Status', 'Mode', 'VLAN', '802.1X'], ports.map(k => { const x = d.ifs[k], c = !!Sim.segment(L, d.name, k).eps.length; return h('tr', {}, h('td', {}, k), h('td', { class: !x.up ? 'dn' : c ? 'up' : '' }, !x.up ? 'disabled' : c ? 'connected' : 'notconnect'), h('td', {}, x.mode), h('td', {}, x.vlan), h('td', {}, x.auth === 'auto' ? (x.state || 'unauth') : 'open')); })), h('p', {}, 'VLANs: ' + vl.length));
    if (t === 'Ports') { const f = { p: sel_(ports), m: sel_(['access', 'trunk']), v: sel_(vl), en: h('input', { type: 'checkbox', checked: true }), dx: h('input', { type: 'checkbox' }) };
      return h('div', {}, tbl(['Port', 'Mode', 'VLAN', 'Admin', '802.1X'], ports.map(k => { const x = d.ifs[k]; return h('tr', {}, h('td', {}, k), h('td', {}, x.mode), h('td', {}, x.vlan), h('td', { class: x.up ? 'up' : 'dn' }, x.up ? 'up' : 'shutdown'), h('td', {}, x.auth === 'auto' ? 'port-control auto' : 'open')); })), h('h4', {}, 'Edit port'), h('div', { class: 'frm' }, f.p, f.m, 'VLAN', f.v, h('label', {}, f.en, ' enabled'), h('label', {}, f.dx, ' 802.1X (port-control auto)'), h('button', { onclick: () => apply(d, ['interface ' + f.p.value, 'switchport mode ' + f.m.value].concat(f.m.value === 'access' ? ['switchport access vlan ' + f.v.value] : [], [f.en.checked ? 'no shutdown' : 'shutdown', f.dx.checked ? 'authentication port-control auto' : 'no authentication port-control auto'])) }, 'Apply'))); }
    if (t === 'VLANs') { const f = { id: inp_('20', 'id', '55px'), n: inp_('SERVERS', 'name', '120px') };
      return h('div', {}, tbl(['VLAN', 'Name', 'Ports', ''], vl.map(v => h('tr', {}, h('td', {}, v), h('td', {}, d.vlans[v]), h('td', {}, ports.filter(k => String(d.ifs[k].vlan) === String(v) && d.ifs[k].mode === 'access').join(', ')), h('td', {}, +v === 1 ? '' : h('button', { class: 'x', onclick: () => apply(d, ['no vlan ' + v]) }, '✕'))))), h('h4', {}, 'Add VLAN'), h('div', { class: 'frm' }, f.id, f.n, h('button', { onclick: () => apply(d, ['vlan ' + f.id.value, 'name ' + f.n.value]) }, 'Add'))); }
    if (t === '802.1X / NAC') { const f = { aaa: h('input', { type: 'checkbox', checked: !!d.aaa }), dx: h('input', { type: 'checkbox', checked: !!d.dot1xGlobal }), ip: inp_(d.radius && d.radius.ip || '192.168.100.14', 'RADIUS server IP', '130px'), key: inp_(d.radius && d.radius.key || '', 'shared secret', '120px') };
      return h('div', {}, h('h4', {}, 'Global 802.1X / RADIUS settings'), h('div', { class: 'frm' }, h('label', {}, f.aaa, ' aaa new-model'), h('label', {}, f.dx, ' dot1x system-auth-control'), 'RADIUS', f.ip, 'secret', f.key, h('button', { onclick: () => apply(d, [f.aaa.checked ? 'aaa new-model' : 'no aaa new-model', 'aaa authentication dot1x default group radius', f.dx.checked ? 'dot1x system-auth-control' : 'no dot1x system-auth-control', 'radius server ISE', 'address ipv4 ' + f.ip.value + ' auth-port 1812 acct-port 1813', 'key ' + f.key.value]) }, 'Apply')),
        h('p', { class: 'dim' }, 'Per-port 802.1X is set under Ports (port-control auto). The shared secret must match ISE > Network Devices.'), tbl(['Port', 'State', 'User', 'Profile'], ports.filter(k => d.ifs[k].auth === 'auto').map(k => h('tr', {}, h('td', {}, k), h('td', { class: d.ifs[k].state === 'authorized' ? 'up' : 'dn' }, d.ifs[k].state || 'unauth'), h('td', {}, d.ifs[k].user || ''), h('td', {}, d.ifs[k].profile || ''))))); }
    if (t === 'MAC table') return h('pre', { class: 'cfgpre' }, cliOut(d, 'show mac address-table'));
    if (t === 'Tools') return h('pre', { class: 'cfgpre' }, 'Use the Terminal for ping/traceroute on a Layer-2 switch (it has no routed interfaces).');
    return h('pre', { class: 'cfgpre' }, cliOut(d, 'show running-config'));
  });
}
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
function iseGui(d) {
  const I = L.ise, grp = ['Employees', 'Contractors', 'Printers', 'Unknown'], profs = Object.keys(I.profiles);
  return sub(['Live Logs', 'Network Devices', 'Identities', 'Policy', 'Profiles'], 'ise', t => {
    if (t === 'Live Logs') return h('div', {}, h('h3', {}, 'Operations > RADIUS > Live Logs'), h('button', { onclick: () => refreshWins() }, '⟳ Refresh'), tbl(['Time', 'Status', 'Identity', 'Endpoint MAC', 'Network device', 'Method', 'Profile', 'Details'], I.logs.slice(0, 20).map(e => h('tr', {}, h('td', {}, e.t), h('td', { class: e.result === 'Pass' ? 'up' : 'dn' }, e.result === 'Pass' ? '● Pass' : '✖ Fail'), h('td', {}, e.user), h('td', {}, e.mac), h('td', {}, e.nas), h('td', {}, e.method), h('td', {}, e.profile), h('td', {}, e.why)))), I.logs.length ? null : h('p', { class: 'dim' }, 'No authentications yet. Log on from a PC: right-click Client > Network login (802.1X).'));
    if (t === 'Network Devices') { const f = { n: inp_('SW1', 'name', '90px'), ip: inp_('192.168.100.23', 'IP', '120px'), s: inp_('', 'shared secret', '120px') };
      return h('div', {}, h('h3', {}, 'Administration > Network Resources > Network Devices'), tbl(['Name', 'IP', 'Shared secret', ''], I.devices.map((x, i) => h('tr', {}, h('td', {}, x.name), h('td', {}, x.ip), h('td', {}, '••••••'), h('td', {}, h('button', { class: 'x', onclick: () => { I.devices.splice(i, 1); commit(); } }, '✕'))))), h('h4', {}, 'Add network device'), h('div', { class: 'frm' }, f.n, f.ip, f.s, h('button', { onclick: () => { I.devices.push({ name: f.n.value, ip: f.ip.value, secret: f.s.value }); commit(); } }, 'Submit')), h('p', { class: 'dim' }, 'The switch must be listed here, with the SAME shared secret as "key" under its radius server.')); }
    if (t === 'Identities') { const u = { n: inp_('', 'username', '100px'), p: inp_('Cisco123!', 'password', '100px'), g: sel_(['Employees', 'Contractors']) }, en = { m: inp_(Cli.macOf('Client', 'eth0'), 'MAC', '130px'), g: sel_(['Printers', 'Unknown']) };
      return h('div', {}, h('h3', {}, 'Administration > Identity Management > Users'), tbl(['Username', 'Group', ''], I.users.map((x, i) => h('tr', {}, h('td', {}, x.name), h('td', {}, x.group), h('td', {}, h('button', { class: 'x', onclick: () => { I.users.splice(i, 1); commit(); } }, '✕'))))), h('div', { class: 'frm' }, u.n, u.p, u.g, h('button', { onclick: () => { if (u.n.value) { I.users.push({ name: u.n.value, pass: u.p.value, group: u.g.value }); commit(); } } }, 'Add user')),
        h('h3', {}, 'Endpoints (for MAB)'), tbl(['MAC', 'Endpoint group', ''], I.endpoints.map((x, i) => h('tr', {}, h('td', {}, x.mac), h('td', {}, x.group), h('td', {}, h('button', { class: 'x', onclick: () => { I.endpoints.splice(i, 1); commit(); } }, '✕'))))), h('div', { class: 'frm' }, en.m, en.g, h('button', { onclick: () => { I.endpoints.push({ mac: en.m.value, group: en.g.value }); commit(); } }, 'Add endpoint')), h('p', { class: 'dim' }, 'Prefilled MAC = the Client PC. Add it to the Printers group; the rule Printers-MAB then permits it via MAB.')); }
    if (t === 'Policy') { const f = { n: inp_('Rule1', 'name', '90px'), g: sel_(['any'].concat(grp)), m: sel_(['any', 'dot1x', 'mab']), p: sel_(profs) };
      const d1 = h('input', { type: 'checkbox', checked: I.allowDot1x }), m1 = h('input', { type: 'checkbox', checked: I.allowMab }); d1.addEventListener('change', () => { I.allowDot1x = d1.checked; commit(); }); m1.addEventListener('change', () => { I.allowMab = m1.checked; commit(); });
      return h('div', {}, h('h3', {}, 'Policy > Authentication (Allowed Protocols)'), h('div', { class: 'frm' }, h('label', {}, d1, ' 802.1X (PEAP/EAP)'), h('label', {}, m1, ' MAC Authentication Bypass')), h('h3', {}, 'Policy > Authorization (first match wins)'),
        tbl(['#', 'Rule', 'Identity group', 'Method', 'Result profile', ''], I.authz.map((r, i) => { const ps = sel_(profs, r.profile); ps.addEventListener('change', () => { r.profile = ps.value; commit(); }); return h('tr', {}, h('td', {}, i + 1), h('td', {}, r.name), h('td', {}, r.group), h('td', {}, r.method), h('td', {}, ps), h('td', {}, h('button', { disabled: i === 0, onclick: () => { const [x] = I.authz.splice(i, 1); I.authz.splice(i - 1, 0, x); commit(); } }, '↑'), h('button', { class: 'x', onclick: () => { I.authz.splice(i, 1); commit(); } }, '✕'))); })),
        h('p', { class: 'dim' }, 'Default rule (no match): DenyAccess.'), h('h4', {}, 'Add rule'), h('div', { class: 'frm' }, f.n, f.g, f.m, f.p, h('button', { onclick: () => { I.authz.unshift({ name: f.n.value, group: f.g.value, method: f.m.value, profile: f.p.value }); commit(); } }, 'Add (top)'))); }
    const f = { n: inp_('', 'name', '110px'), a: sel_(['accept', 'reject']), v: inp_('10', 'VLAN', '50px'), d: h('textarea', { rows: 3, placeholder: 'permit tcp any any eq 80', style: 'width:98%' }) };
    return h('div', {}, h('h3', {}, 'Policy > Policy Elements > Authorization Profiles'), tbl(['Profile', 'Access', 'VLAN', 'Downloadable ACL', ''], Object.entries(I.profiles).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: v.access === 'accept' ? 'up' : 'dn' }, v.access), h('td', {}, v.vlan || ''), h('td', {}, h('pre', { class: 'mini' }, v.dacl || '-')), h('td', {}, ['PermitAccess', 'DenyAccess'].includes(k) ? '' : h('button', { class: 'x', onclick: () => { delete I.profiles[k]; commit(); } }, '✕'))))), h('h4', {}, 'Add profile'), h('div', { class: 'frm' }, f.n, f.a, f.v), f.d, h('div', { class: 'frm' }, h('button', { onclick: () => { if (f.n.value) { I.profiles[f.n.value] = { access: f.a.value, vlan: +f.v.value || 1, dacl: f.d.value }; commit(); } } }, 'Save profile')), h('p', { class: 'dim' }, 'A dACL is pushed to the switch port: e.g. "permit tcp any any eq 80" (anything else is implicitly denied).'));
  });
}
// ---- ESA GUI ----
function esaGui(d) {
  const E = L.esa;
  return sub(['Dashboard', 'Mail Policies', 'HAT / Senders', 'Domains & DNS', 'Message Tracking', 'Quarantine', 'Test mail'], 'esa', t => {
    if (t === 'Dashboard') return h('div', {}, h('h3', {}, 'Email Security Appliance - System Overview'), h('div', { class: 'tiles' }, [['Accepted', E.counters.accepted], ['Spam caught', E.counters.spam], ['Viruses', E.counters.virus], ['Blocked (HAT/SPF)', E.counters.blocked], ['DLP hits', E.counters.dlp]].map(([k, v]) => h('div', { class: 'tile' }, h('b', {}, v), h('span', {}, k)))),
      h('h4', {}, 'Mailboxes'), tbl(['User', 'Messages', 'Latest'], Object.entries(E.mailboxes).map(([u, ms]) => h('tr', {}, h('td', {}, u + '@lab.local'), h('td', {}, ms.length), h('td', {}, ms[0] ? ms[0].subject + ' (from ' + ms[0].from + ')' : '')))));
    if (t === 'Mail Policies') { const as = h('input', { type: 'checkbox', checked: E.antispam.on }), th = inp_(E.antispam.threshold, 'score', '55px'), aa = sel_(['quarantine', 'drop'], E.antispam.action), av = h('input', { type: 'checkbox', checked: E.antivirus }), dl = h('input', { type: 'checkbox', checked: E.dlp }), sp = sel_(['tag', 'quarantine', 'reject'], E.spfAction);
      const f = { n: inp_('NoExe', 'name', '90px'), c: sel_(['attachment-ext', 'subject-contains', 'body-contains']), v: inp_('exe', 'value', '90px'), a: sel_(['drop', 'quarantine', 'tag']) };
      return h('div', {}, h('h3', {}, 'Mail Policies > Incoming Mail Policy (Default)'), h('div', { class: 'frm' }, h('label', {}, as, ' Anti-Spam'), 'threshold', th, 'action', aa), h('div', { class: 'frm' }, h('label', {}, av, ' Anti-Virus'), h('label', {}, dl, ' Data Loss Prevention (SSN)'), 'SPF fail action', sp),
        h('div', { class: 'frm' }, h('button', { class: 'primary', onclick: () => { E.antispam = { on: as.checked, threshold: +th.value || 50, action: aa.value }; E.antivirus = av.checked; E.dlp = dl.checked; E.spfAction = sp.value; commit(); notice('Policy committed.'); } }, 'Submit & Commit')),
        h('h4', {}, 'Incoming Content Filters'), tbl(['Name', 'Condition', 'Value', 'Action', ''], E.filters.map((x, i) => h('tr', {}, h('td', {}, x.name), h('td', {}, x.cond), h('td', {}, x.value), h('td', {}, x.action), h('td', {}, h('button', { class: 'x', onclick: () => { E.filters.splice(i, 1); commit(); } }, '✕'))))), h('div', { class: 'frm' }, f.n, f.c, f.v, f.a, h('button', { onclick: () => { E.filters.push({ name: f.n.value, cond: f.c.value, value: f.v.value, action: f.a.value }); commit(); } }, 'Add filter'))); }
    if (t === 'HAT / Senders') { const f = { g: sel_(E.hat.map(x => x.name)), ip: inp_('198.51.100.10', 'IP or CIDR', '140px') };
      return h('div', {}, h('h3', {}, 'Mail Policies > HAT Overview (Host Access Table)'), tbl(['Sender group', 'Policy', 'Sender IPs'], E.hat.map(g => h('tr', {}, h('td', {}, g.name), h('td', { class: g.policy === 'block' ? 'dn' : 'up' }, g.policy === 'block' ? 'REJECT' : 'ACCEPT (trusted)'), h('td', {}, g.ips.map((ip, i) => h('span', { class: 'chip' }, ip, h('button', { class: 'x', onclick: () => { g.ips.splice(i, 1); commit(); } }, '✕'))))))), h('div', { class: 'frm' }, f.g, f.ip, h('button', { onclick: () => { E.hat.find(x => x.name === f.g.value).ips.push(f.ip.value); commit(); } }, 'Add sender')), h('p', { class: 'dim' }, 'Put 198.51.100.10 in BLOCKLIST and the connection is refused before any content scanning.')); }
    if (t === 'Domains & DNS') { const f = { d: inp_('', 'domain', '120px') }, g = { d: inp_('example.net', 'domain', '120px'), ips: inp_('198.51.100.10', 'SPF-authorised IPs (comma)', '200px') };
      return h('div', {}, h('h3', {}, 'Recipient Access Table - accepted domains'), tbl(['Domain', ''], E.domains.map((x, i) => h('tr', {}, h('td', {}, x), h('td', {}, h('button', { class: 'x', onclick: () => { E.domains.splice(i, 1); commit(); } }, '✕'))))), h('div', { class: 'frm' }, f.d, h('button', { onclick: () => { if (f.d.value) { E.domains.push(f.d.value); commit(); } } }, 'Add domain')),
        h('h3', {}, 'Simulated Internet DNS - SPF records'), tbl(['Sender domain', 'SPF: authorised sending IPs', ''], Object.entries(E.dns).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v.spf.join(', ')), h('td', {}, h('button', { class: 'x', onclick: () => { delete E.dns[k]; commit(); } }, '✕'))))), h('div', { class: 'frm' }, g.d, g.ips, h('button', { onclick: () => { E.dns[g.d.value] = { spf: g.ips.value.split(',').map(x => x.trim()).filter(Boolean) }; commit(); } }, 'Add / replace record'))); }
    if (t === 'Message Tracking') return h('div', {}, h('h3', {}, 'Monitor > Message Tracking'), h('button', { onclick: () => refreshWins() }, '⟳ Refresh'), tbl(['Time', 'MID', 'From', 'To', 'Subject', 'Attach', 'Sender IP', 'Result', 'Reason'], E.tracking.slice(0, 25).map(m => h('tr', {}, h('td', {}, m.t), h('td', {}, m.mid), h('td', {}, m.from), h('td', {}, m.to), h('td', {}, m.subject), h('td', {}, m.attach), h('td', {}, m.src), h('td', { class: /delivered/.test(m.disp) ? 'up' : 'dn' }, m.disp), h('td', {}, m.why)))));
    if (t === 'Quarantine') return h('div', {}, h('h3', {}, 'Monitor > Quarantines'), tbl(['From', 'To', 'Subject', ''], E.quarantine.map((m, i) => h('tr', {}, h('td', {}, m.from), h('td', {}, m.to), h('td', {}, m.subject), h('td', {}, h('button', { onclick: () => { const u = m.to.split('@')[0]; (E.mailboxes[u] = E.mailboxes[u] || []).unshift({ from: m.from, subject: m.subject, t: 'released' }); E.quarantine.splice(i, 1); commit(); } }, 'Release'), h('button', { class: 'x', onclick: () => { E.quarantine.splice(i, 1); commit(); } }, '✕'))))), E.quarantine.length ? null : h('p', { class: 'dim' }, 'Quarantine is empty.'));
    const hosts = Object.keys(L.dev).filter(k => L.dev[k].type === 'host' && !L.dev[k].role), hs = sel_(hosts, 'Outside');
    return h('div', {}, h('h3', {}, 'Test mail flow'), h('div', { class: 'frm' }, 'Send from PC', hs), mailForm(() => hs.value, { server: '203.0.113.20' }), h('p', { class: 'dim' }, 'From Outside-Desktop use 203.0.113.20 (published). From inside PCs use 172.16.1.20.'));
  });
}
function wsaGui(d) {
  const W = L.wsa;
  return sub(['Dashboard', 'Access Policies', 'Security Services', 'Reporting', 'Test request'], 'wsa', t => {
    if (t === 'Dashboard') return h('div', {}, h('h3', {}, 'Secure Web Appliance - System Overview'), h('div', { class: 'tiles' }, [['Requests', W.counters.total], ['Allowed', W.counters.allowed], ['Blocked', W.counters.blocked], ['Malware stopped', W.counters.malware]].map(([k, v]) => h('div', { class: 'tile' }, h('b', {}, v), h('span', {}, k)))), h('p', { class: 'dim' }, 'Explicit proxy listening on 172.16.1.30:3128. Point a browser at it (Client > Desktop > Proxy), or use: curl -x 172.16.1.30:3128 http://www.cisco.com'));
    if (t === 'Access Policies') { const f = { l: sel_(['Allow list', 'Block list']), d: inp_('www.example.com', 'domain', '170px') };
      return h('div', {}, h('h3', {}, 'Web Security Manager > Access Policies > Global Policy: URL Filtering'), tbl(['URL category', 'Action'], Object.keys(W.policy).map(c => { const s = sel_(['allow', 'monitor', 'block'], W.policy[c]); s.addEventListener('change', () => { W.policy[c] = s.value; commit(); notice('Policy updated for ' + c + ': ' + s.value); }); return h('tr', {}, h('td', {}, c), h('td', {}, s)); })),
        h('h4', {}, 'Custom URL lists'), h('p', {}, 'Allow: ', W.allowlist.length ? W.allowlist.map((x, i) => h('span', { class: 'chip' }, x, h('button', { class: 'x', onclick: () => { W.allowlist.splice(i, 1); commit(); } }, '✕'))) : '-', '   Block: ', W.blocklist.length ? W.blocklist.map((x, i) => h('span', { class: 'chip' }, x, h('button', { class: 'x', onclick: () => { W.blocklist.splice(i, 1); commit(); } }, '✕'))) : '-'),
        h('div', { class: 'frm' }, f.l, f.d, h('button', { onclick: () => { (f.l.value === 'Allow list' ? W.allowlist : W.blocklist).push(f.d.value); commit(); } }, 'Add')), h('p', { class: 'dim' }, 'Custom lists override the category action.')); }
    if (t === 'Security Services') { const av = h('input', { type: 'checkbox', checked: W.av }), dc = h('input', { type: 'checkbox', checked: W.decrypt });
      return h('div', {}, h('h3', {}, 'Security Services'), h('div', { class: 'frm' }, h('label', {}, av, ' Anti-Malware scanning')), h('div', { class: 'frm' }, h('label', {}, dc, ' HTTPS Proxy - decrypt and inspect HTTPS traffic')), h('div', { class: 'frm' }, h('button', { class: 'primary', onclick: () => { W.av = av.checked; W.decrypt = dc.checked; commit(); notice('Security services committed.'); } }, 'Submit & Commit')), h('p', { class: 'dim' }, 'Without HTTPS decryption the WSA only sees the destination host name of an HTTPS request - it can filter by category but cannot scan the download for malware.')); }
    if (t === 'Reporting') return h('div', {}, h('h3', {}, 'Reporting > Access log'), h('button', { onclick: () => refreshWins() }, '⟳ Refresh'), tbl(['Time', 'Client', 'URL', 'Category', 'Action', 'Reason'], W.log.slice(0, 25).map(m => h('tr', {}, h('td', {}, m.t), h('td', {}, m.client), h('td', {}, m.url), h('td', {}, m.cat), h('td', { class: m.act === 'Blocked' ? 'dn' : 'up' }, m.act), h('td', {}, m.why)))));
    const hosts = Object.keys(L.dev).filter(k => L.dev[k].type === 'host' && !L.dev[k].role), hs = sel_(hosts, 'Client'), u = inp_('http://www.facebook.com', 'URL', '240px'), out = h('div', {});
    return h('div', {}, h('h3', {}, 'Test a web request through this proxy'), h('div', { class: 'frm' }, 'From', hs, u, h('button', { class: 'primary', onclick: () => { lastAnim = null; const r = Sim.webGet(L, hs.value, { url: u.value, proxy: '172.16.1.30:3128' }); out.innerHTML = ''; (r.steps || []).forEach(s => out.append(h('div', { class: 'ph ' + (s.k === 'drop' ? 'drop' : s.k === 'ok' ? 'ok' : '') }, s.t))); if (!r.steps || !r.steps.length) out.append(h('div', { class: 'ph drop' }, r.why)); out.append(h('div', { class: 'phr ' + (r.ok ? 'up' : 'dn') }, r.ok ? '✔ 200 OK - ' + r.page : '✖ ' + (r.why || r.kind))); if (r.net && r.net.path) lastAnim = r.net; save(); runChecks(); drawTopo(); if (lastAnim) animate(lastAnim); } }, 'Send request')), out);
  });
}
// ---------- boot ----------
function boot() {
  load(); drawTopo(); runChecks(); startScreen();
  $('#reset').addEventListener('click', () => { if (confirm('Reset the whole lab to its starting state?')) { try { localStorage.removeItem(KEY); } catch (e) {} terms = {}; sessions = {}; brs = {}; for (const k of Object.keys(wins)) closeWin(k); L = newLab(); commit(); startScreen(); } });
  $('#devs').addEventListener('click', startScreen);
}
window.addEventListener('DOMContentLoaded', boot);
})();
