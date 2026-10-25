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

function load() { try { const j = localStorage.getItem(KEY); if (j) { L = JSON.parse(j); if (L.dev.FTD1 && L.dev.FTD1.draft) return; } } catch (e) {} L = newLab(); }
function save() { try { localStorage.setItem(KEY, JSON.stringify(L)); } catch (e) {} }

// ---------- tasks ----------
const sandbox = fn => fn(clone(L));
const ok = (l, s, p) => flow(l, s, p).ok;
const TASKS = [
  { id: 1, t: 'Baseline: inside PC reaches the DMZ web server', hint: 'Client > curl http://172.16.1.10 (inside has higher security-level than dmz, so it is allowed by default).', check: l => ok(l, 'Client', { proto: 'tcp', dst: '172.16.1.10', dport: 80 }), ans: '(already works)' },
  { id: 2, t: 'Baseline: inside PC reaches the outside network (dynamic PAT)', hint: 'Client > ping 198.51.100.10 ; then on FW1: show xlate / show conn.', check: l => ok(l, 'Client', { proto: 'icmp', dst: '198.51.100.10' }), ans: '(already works)' },
  { id: 3, t: 'Publish the DMZ web server: Outside can browse http://203.0.113.10', hint: 'Needs BOTH a static NAT (172.16.1.10 -> 203.0.113.10, dmz,outside) AND an access-list on the outside interface permitting tcp/80 to the REAL address. Use packet-tracer on FW1 to see which is missing.',
    check: l => ok(l, 'Outside', { proto: 'tcp', dst: '203.0.113.10', dport: 80 }),
    ans: 'object network DMZ-WEB\n host 172.16.1.10\n nat (dmz,outside) static 203.0.113.10\naccess-list OUT-IN extended permit tcp any object DMZ-WEB eq 80\naccess-group OUT-IN in interface outside' },
  { id: 4, t: 'Least privilege: SSH to the published server must be blocked', hint: 'Only tcp/80 should be reachable from outside. Test with: Outside > nmap -Pn 203.0.113.10', dep: 3,
    check: l => ok(l, 'Outside', { proto: 'tcp', dst: '203.0.113.10', dport: 80 }) && !ok(l, 'Outside', { proto: 'tcp', dst: '203.0.113.10', dport: 22 }), ans: '(task 3 already does this - implicit deny)' },
  { id: 5, t: 'R1 ACL: block Client from DMZ web (tcp/80) but still allow ping and Internet', hint: 'Extended ACL on R1 Gi0/2 inbound: deny tcp any host 172.16.1.10 eq 80 then permit ip any any.',
    check: l => !ok(l, 'Client', { proto: 'tcp', dst: '172.16.1.10', dport: 80 }) && ok(l, 'Client', { proto: 'icmp', dst: '172.16.1.10' }) && ok(l, 'Client', { proto: 'icmp', dst: '198.51.100.10' }),
    ans: 'R1: ip access-list extended BLOCK-WEB\n deny tcp any host 172.16.1.10 eq 80\n permit ip any any\ninterface Gi0/2\n ip access-group BLOCK-WEB in' },
  { id: 6, t: 'FTD (in FMC): bring up interfaces, route, PAT + allow rule so FTD-Client reaches Outside', hint: 'FMC GUI > Devices: Gi0/0 zone OUT 192.0.2.1/24, Gi0/1 zone IN 10.2.1.1/24 | Routing: 0.0.0.0/0 via 192.0.2.2 | NAT: PAT IN->OUT | Access Policy: allow IN->OUT | then DEPLOY.',
    check: l => ok(l, 'FTDClient', { proto: 'icmp', dst: '198.51.100.10' }), ans: 'GUI only (FMC tab on FTD1)' },
  { id: 7, t: 'FTD: Outside must NOT be able to reach FTD-Client', hint: 'Default action "Block all traffic" does this - make sure you did not add an OUT->IN allow rule.', dep: 6,
    check: l => ok(l, 'FTDClient', { proto: 'icmp', dst: '198.51.100.10' }) && !ok(l, 'Outside', { proto: 'icmp', dst: '10.2.1.10' }), ans: '(default block)' },
  { id: 8, t: 'FTD IPS: block a malicious web request (sqlmap) while normal browsing still works', hint: 'Edit your allow rule: enable "Intrusion Prevention". Test: FTD-Client > curl -A sqlmap http://198.51.100.10 (blocked) vs curl http://198.51.100.10 (ok). Deploy!', dep: 6,
    check: l => ok(l, 'FTDClient', { proto: 'tcp', dst: '198.51.100.10', dport: 80 }) && !ok(l, 'FTDClient', { proto: 'tcp', dst: '198.51.100.10', dport: 80, sig: 'sqlmap' }), ans: 'GUI only (enable IPS on the rule, Deploy)' },
];
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
      h('p', {}, '💡 ', t.hint), h('details', { class: 'ans' }, h('summary', {}, 'Show answer'), h('pre', {}, t.ans)));
    box.append(d);
  }
}

// ---------- commit ----------
function commit() { save(); runChecks(); drawTopo(); renderPanel(true); }

// ---------- topology ----------
const ICON = { host: '🖥', router: '🔀', switch: '▤', asa: '🛡', ftd: '🛡' };
const COL = { host: '#3b82f6', router: '#22d3ee', switch: '#a78bfa', asa: '#f97316', ftd: '#ef4444' };
function center(d) { return [d.x + 55, d.y + 28]; }
function drawTopo() {
  const svg = $('#topo'); svg.innerHTML = '';
  for (const [a, b] of L.links) {
    const [da, ia] = a.split(':'), [db, ib] = b.split(':'); const A = center(L.dev[da]), B = center(L.dev[db]);
    svg.append(sv('line', { x1: A[0], y1: A[1], x2: B[0], y2: B[1], class: 'lnk' }));
    const lab = (P, Q, n) => svg.append(sv('text', { x: P[0] + (Q[0] - P[0]) * 0.27, y: P[1] + (Q[1] - P[1]) * 0.27 - 4, class: 'lbl' }, n));
    if (L.dev[da].type !== 'switch') lab(A, B, ia); if (L.dev[db].type !== 'switch') lab(B, A, ib);
  }
  const nets = [['203.0.113.0/24', 345, 100], ['10.1.1.0/24', 560, 100], ['172.16.1.0/24', 470, 205], ['192.0.2.0/24', 262, 205], ['198.51.100.0/24', 160, 100], ['10.1.10.0/24', 800, 100], ['10.2.1.0/24', 275, 395]];
  for (const [t, x, y] of nets) svg.append(sv('text', { x, y, class: 'net' }, t));
  svg.append(sv('g', { id: 'anim' }));
  for (const n in L.dev) {
    const d = L.dev[n], c = COL[d.type];
    const g = sv('g', { class: 'node' + (sel === n ? ' sel' : ''), transform: 'translate(' + d.x + ',' + d.y + ')' });
    g.append(sv('rect', { width: 110, height: 56, rx: 12, fill: '#0f172a', stroke: c, 'stroke-width': sel === n ? 3 : 1.5 }));
    g.append(sv('text', { x: 55, y: 26, class: 'ico', 'text-anchor': 'middle' }, ICON[d.type]));
    g.append(sv('text', { x: 55, y: 46, class: 'nm', 'text-anchor': 'middle' }, d.label));
    if (d.type === 'ftd' && d.dirty) g.append(sv('circle', { cx: 104, cy: 6, r: 5, fill: '#facc15' }));
    g.addEventListener('click', () => { sel = n; drawTopo(); renderPanel(); });
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

// ---------- right panel ----------
function renderPanel(keepTab) {
  const d = L.dev[sel], p = $('#panel'); p.innerHTML = '';
  const names = d.type === 'host' ? ['Browser', 'Terminal'] : d.type === 'switch' ? ['Info'] : d.type === 'ftd' ? ['FMC (GUI)', 'CLI'] : d.type === 'asa' ? ['ASDM (GUI)', 'Console'] : ['Console', 'Device info'];
  if (!names.includes(tabs[sel])) tabs[sel] = names[0];
  p.append(h('div', { class: 'dhead' }, h('b', {}, d.label), h('span', { class: 'tag', style: 'background:' + COL[d.type] }, d.type === 'asa' ? 'ASA firewall' : d.type === 'ftd' ? 'Secure Firewall (FTD)' : d.type)));
  p.append(h('div', { class: 'tabs' }, names.map(n => h('button', { class: tabs[sel] === n ? 'on' : '', onclick: () => { tabs[sel] = n; renderPanel(); } }, n))));
  const body = h('div', { class: 'body' }); p.append(body);
  const t = tabs[sel];
  if (t === 'Console' || t === 'Terminal' || t === 'CLI') body.append(terminal(d));
  else if (t === 'Browser') body.append(browser(d));
  else if (t === 'ASDM (GUI)') body.append(asdm(d));
  else if (t === 'FMC (GUI)') body.append(fmc(d));
  else body.append(infoView(d));
}
function terminal(d) {
  if (!terms[d.name]) {
    const out = h('div', { class: 'tout' }); const s = Cli.newSession(d); sessions[d.name] = s; hist[d.name] = { l: [], i: 0 };
    const banner = d.type === 'host' ? 'Ubuntu 22.04 LTS - type "help" for commands.' : d.type === 'ftd' ? 'Cisco Firepower Threat Defense (simulated) - policy is managed from FMC.' : d.label + ' (simulated CLI) - type "enable", then "conf t". "?" lists commands.';
    out.append(h('div', {}, banner));
    const inp = h('input', { class: 'tin', spellcheck: 'false', autocomplete: 'off' }); const pr = h('span', { class: 'pr' }, Cli.prompt(d, s));
    const row = h('div', { class: 'trow' }, pr, inp);
    inp.addEventListener('keydown', ev => {
      const H = hist[d.name];
      if (ev.key === 'Enter') { const line = inp.value; const p0 = Cli.prompt(d, s); out.append(h('div', {}, h('span', { class: 'pr' }, p0), line)); inp.value = ''; if (line.trim()) { H.l.push(line); H.i = H.l.length; }
        if (line.trim() === 'clear') out.innerHTML = ''; else { lastAnim = null; const res = Cli.exec(L, d, s, line); if (res) out.append(h('pre', { class: 'res' }, res)); }
        pr.textContent = Cli.prompt(d, s); out.scrollTop = out.scrollHeight; save(); runChecks(); if (lastAnim) animate(lastAnim); refreshLive(); }
      else if (ev.key === 'ArrowUp') { if (H.i > 0) inp.value = H.l[--H.i]; ev.preventDefault(); }
      else if (ev.key === 'ArrowDown') { inp.value = H.i < H.l.length - 1 ? H.l[++H.i] : ''; if (H.i >= H.l.length - 1) H.i = H.l.length; ev.preventDefault(); }
    });
    const w = h('div', { class: 'term', onclick: () => inp.focus() }, out, row); terms[d.name] = w; w._inp = inp;
  }
  setTimeout(() => terms[d.name]._inp.focus(), 0); return terms[d.name];
}
function refreshLive() { drawTopo(); }
function browser(d) {
  const url = h('input', { class: 'url', value: 'http://172.16.1.10', spellcheck: 'false' }); const page = h('div', { class: 'page' }, 'Enter an address and press Go.');
  const go = () => { lastAnim = null; const u = /^(?:https?:\/\/)?([\d.]+)(?::(\d+))?/.exec(url.value.trim()); if (!u) { page.textContent = 'Use an IP address, e.g. http://203.0.113.10'; return; }
    const port = u[2] ? +u[2] : /^https/.test(url.value) ? 443 : 80; const r = flow(L, d.name, { proto: 'tcp', dst: u[1], dport: port });
    page.innerHTML = ''; if (r.ok) page.append(h('h2', {}, r.page || 'OK'), h('p', {}, '✔ HTTP 200 OK from ' + u[1] + ':' + port)); else page.append(h('h2', { class: 'bad' }, "This site can't be reached"), h('p', {}, r.kind === 'closed' ? 'Connection refused.' : r.kind === 'unreach' || r.kind === 'prohibited' ? 'No route to host / host prohibited.' : 'Connection timed out (something dropped the packet).'), h('p', { class: 'dim' }, r.why || ''));
    save(); runChecks(); if (lastAnim) animate(lastAnim); drawTopo(); };
  url.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  return h('div', { class: 'browser' }, h('div', { class: 'bar' }, h('span', {}, '◀ ▶ ⟳'), url, h('button', { onclick: go }, 'Go')), page);
}
function infoView(d) {
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
  return sub(['Home', 'Interfaces', 'Access Rules', 'NAT Rules', 'Routing', 'Packet Tracer', 'Monitoring'], 'asdm', t => {
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
function fmc(d) {
  const dr = d.draft, zones = ['any'].concat([...new Set(Object.values(dr.ifs).map(x => x.zone).filter(Boolean))]);
  const dirty = () => { d.dirty = true; save(); drawTopo(); renderPanel(); };
  return h('div', {}, h('div', { class: 'deploy' }, d.dirty ? h('span', { class: 'warn' }, '● Pending changes - not active until deployed') : h('span', { class: 'up' }, '✔ Policy deployed'), h('button', { class: 'primary', disabled: !d.dirty, onclick: () => { ftdDeploy(d); notice('Deployment to FTD1 complete.'); commit(); } }, 'Deploy')),
    sub(['Interfaces', 'Routing', 'NAT', 'Access Policy', 'Events'], 'fmc', t => {
      if (t === 'Interfaces') return h('div', {}, tbl(['Interface', 'Name', 'Security zone', 'IPv4 / len', 'Enabled', ''], Object.values(dr.ifs).map(x => { const z = inp_(x.zone, 'zone', '70px'), ip = inp_(x.ip, 'x.x.x.x', '110px'), ln = inp_(x.len, 'len', '40px'), en = h('input', { type: 'checkbox', checked: x.up });
        return h('tr', {}, h('td', {}, x.name), h('td', {}, x.nameif), h('td', {}, z), h('td', {}, ip, '/', ln), h('td', {}, en), h('td', {}, h('button', { onclick: () => { x.zone = z.value.trim(); x.ip = ip.value.trim() || null; x.len = +ln.value || 24; x.up = en.checked; dirty(); } }, 'Save'))); })), h('p', { class: 'dim' }, 'Suggested: Gi0/0 zone OUT 192.0.2.1/24 (to R2), Gi0/1 zone IN 10.2.1.1/24 (to FTD-Client).'));
      if (t === 'Routing') { const f = { n: inp_('0.0.0.0/0', 'network/len', '120px'), g: inp_('192.0.2.2', 'gateway', '110px') };
        return h('div', {}, tbl(['Network', 'Gateway', ''], dr.routes.map((r, i) => h('tr', {}, h('td', {}, r.net + '/' + r.len), h('td', {}, r.nh), h('td', {}, h('button', { class: 'x', onclick: () => { dr.routes.splice(i, 1); dirty(); } }, '✕'))))), h('h4', {}, 'Add static route'), h('div', { class: 'frm' }, f.n, 'via', f.g, h('button', { onclick: () => { const [n, l] = f.n.value.split('/'); dr.routes.push({ net: n, len: +l || 0, nh: f.g.value }); dirty(); } }, 'Add'))); }
      if (t === 'NAT') { const f = { s: inp_('IN', 'src zone', '70px'), d: inp_('OUT', 'dst zone', '70px') };
        return h('div', {}, tbl(['Type', 'Source zone', 'Destination zone', ''], dr.nat.map((n, i) => h('tr', {}, h('td', {}, 'Dynamic PAT (interface)'), h('td', {}, n.srcZone), h('td', {}, n.dstZone), h('td', {}, h('button', { class: 'x', onclick: () => { dr.nat.splice(i, 1); dirty(); } }, '✕'))))), h('h4', {}, 'Add PAT rule'), h('div', { class: 'frm' }, f.s, '→', f.d, h('button', { onclick: () => { dr.nat.push({ srcZone: f.s.value.trim(), dstZone: f.d.value.trim() }); dirty(); } }, 'Add'))); }
      if (t === 'Access Policy') { const f = { n: inp_('Allow-IN-OUT', 'name', '110px'), s: inp_('IN', 'src zone', '60px'), d: inp_('OUT', 'dst zone', '60px'), sn: inp_('any', 'src net', '100px'), dn: inp_('any', 'dst net', '100px'), p: sel_(['any', 'tcp', 'udp', 'icmp']), pt: inp_('', 'port', '55px'), a: sel_(['allow', 'block']), ips: h('input', { type: 'checkbox' }) };
        const defSel = sel_(['block', 'allow'], dr.policy.defaultAction); defSel.addEventListener('change', () => { dr.policy.defaultAction = defSel.value; dirty(); });
        return h('div', {}, tbl(['#', 'Name', 'Src zone', 'Dst zone', 'Src net', 'Dst net', 'Proto/Port', 'Action', 'IPS', 'Hits', ''], dr.policy.rules.map((r, i) => { const ips = h('input', { type: 'checkbox', checked: r.ips }); ips.addEventListener('change', () => { r.ips = ips.checked; dirty(); });
            return h('tr', {}, h('td', {}, i + 1), h('td', {}, r.name), h('td', {}, r.srcZone), h('td', {}, r.dstZone), h('td', {}, r.srcNet), h('td', {}, r.dstNet), h('td', {}, r.proto + (r.dport ? '/' + r.dport : '')), h('td', { class: r.action === 'allow' ? 'up' : 'dn' }, r.action), h('td', {}, ips), h('td', {}, r.hits || 0), h('td', {}, h('button', { class: 'x', onclick: () => { dr.policy.rules.splice(i, 1); dirty(); } }, '✕'))); })),
          h('p', {}, 'Default action: ', defSel, h('span', { class: 'dim' }, '  (Block All Traffic = anything not explicitly allowed is dropped)')),
          h('h4', {}, 'Add access control rule'), h('div', { class: 'frm' }, f.n, f.s, '→', f.d, f.sn, f.dn, f.p, f.pt, f.a, h('label', {}, f.ips, ' IPS'), h('button', { onclick: () => { dr.policy.rules.push({ name: f.n.value, srcZone: f.s.value.trim() || 'any', dstZone: f.d.value.trim() || 'any', srcNet: f.sn.value || 'any', dstNet: f.dn.value || 'any', proto: f.p.value, dport: f.pt.value ? +f.pt.value : null, action: f.a.value, ips: f.ips.checked }); dirty(); } }, 'Add'))); }
      if (t === 'Events') return h('div', {}, h('button', { onclick: () => renderPanel() }, '⟳ Refresh'), tbl(['Action', 'Src', 'Dst', 'Proto', 'Port', 'Rule', 'Reason'], d.events.slice(0, 25).map(e => h('tr', {}, h('td', { class: e.action === 'Allow' ? 'up' : 'dn' }, e.action), h('td', {}, e.src), h('td', {}, e.dst), h('td', {}, e.proto), h('td', {}, e.dport), h('td', {}, e.rule), h('td', {}, e.why)))));
      return null; }));
}

// ---------- boot ----------
function boot() {
  load(); drawTopo(); renderPanel(); runChecks();
  $('#reset').addEventListener('click', () => { if (confirm('Reset the whole lab to its starting state?')) { localStorage.removeItem(KEY); terms = {}; sessions = {}; L = newLab(); sel = 'Client'; commit(); notice('Lab reset.'); } });
}
window.addEventListener('DOMContentLoaded', boot);
})();
