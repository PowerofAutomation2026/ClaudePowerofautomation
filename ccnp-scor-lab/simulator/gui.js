// SCOR Lab Simulator - product-style management GUIs (ASDM, FMC, ISE, ESA, WSA, IOS web UI)
(function (root) {
'use strict';
const A = () => root.App, S = root.Sim, C = root.Cli, L = () => A().L;
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) { if (k === 'class') e.className = attrs[k]; else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]); }
  for (const c of kids.flat(2)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const sel = (opts, v) => h('select', {}, opts.map(o => h('option', { value: o, selected: o === v }, o)));
const inp = (v, ph, w) => h('input', { value: v == null ? '' : v, placeholder: ph || '', style: w ? 'width:' + w : '' });
const tbl = (head, rows) => h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, head.map(x => h('th', {}, x)))), h('tbody', {}, rows));
const btn = (t, f, cls) => h('button', { class: 'pb ' + (cls || ''), onclick: f }, t);
const chk = (v, f) => { const c = h('input', { type: 'checkbox' }); c.checked = !!v; if (f) c.addEventListener('change', () => f(c.checked)); return c; };
const row = (...k) => h('div', { class: 'prow' }, k);
const panel = (title, ...k) => h('div', { class: 'ppanel' }, title ? h('div', { class: 'phead' }, title) : null, h('div', { class: 'pbody' }, k));
const note = t => h('p', { class: 'pnote' }, t);
const pre = t => h('pre', { class: 'ppre' }, t);
const tiles = arr => h('div', { class: 'ptiles' }, arr.map(([k, v]) => h('div', { class: 'ptile' }, h('b', {}, v), h('span', {}, k))));
const cliOut = (d, c) => A().cliOut(d, c);
const clone = o => JSON.parse(JSON.stringify(o));
const NS = {};

// ---------- shell ----------
function shell(o) {
  const st = NS[o.key] = NS[o.key] || { m: o.nav[0].id, s: o.nav[0].pages[0].id };
  let mn = o.nav.find(x => x.id === st.m); if (!mn && !st.m.startsWith('_')) { st.m = o.nav[0].id; mn = o.nav[0]; }
  if (mn && !mn.pages.find(p => p.id === st.s)) st.s = mn.pages[0].id;
  const go = (m, s) => { st.m = m; st.s = s || (o.nav.find(x => x.id === m) || { pages: [{ id: '' }] }).pages[0].id; A().refreshWins(); };
  const special = st.m.startsWith('_');
  const hdr = h('div', { class: 'phdr' }, h('div', { class: 'pbrand' }, h('b', {}, o.brand), o.sub ? h('span', {}, o.sub) : null),
    o.layout === 'left' ? null : h('div', { class: 'pmenu' }, o.nav.map(m => h('button', { class: !special && st.m === m.id ? 'on' : '', onclick: () => go(m.id) }, m.label))),
    h('div', { class: 'pright' }, o.right ? o.right(go) : null));
  const crumb = (m, p) => h('div', { class: 'pcrumb' }, m, p ? ' › ' + p : '');
  let body;
  const content = () => special ? o.page(st.m, st.s, go) : o.page(st.m, st.s, go);
  if (o.layout === 'toptabs') {
    body = h('div', { class: 'pmain' }, special ? null : h('div', { class: 'ptabs' }, mn.pages.map(p => h('button', { class: st.s === p.id ? 'on' : '', onclick: () => go(st.m, p.id) }, p.label))),
      special ? null : crumb(mn.label, (mn.pages.find(p => p.id === st.s) || {}).label), h('div', { class: 'pcontent' }, content()));
  } else {
    const groups = o.layout === 'topleft' ? (mn ? [mn] : []) : o.nav;
    const tree = h('div', { class: 'ptree' }, groups.map(g => h('div', { class: 'tgrp' }, o.layout === 'left' ? h('div', { class: 'tgh' }, g.label) : null, g.pages.map(p => h('div', { class: 'tnode' + (st.m === g.id && st.s === p.id ? ' on' : ''), onclick: () => go(g.id, p.id) }, p.label)))));
    body = h('div', { class: 'psplit' }, tree, h('div', { class: 'pmain' }, special ? null : crumb(mn.label, (mn.pages.find(p => p.id === st.s) || {}).label), h('div', { class: 'pcontent' }, content())));
  }
  return h('div', { class: 'prod ' + o.cls }, hdr, body, o.status ? h('div', { class: 'pstat' }, o.status) : null);
}

// ---------- shared pages ----------
function toolsPane(d) {
  const t = inp('10.1.1.1', 'target IP', '130px'), out = pre('Run ping or traceroute from this device.');
  const run = c => { A().setAnim(null); out.textContent = cliOut(d, c + ' ' + t.value); A().afterTool(); };
  return panel('Ping / Traceroute', row('Target IP', t, btn('Ping', () => run('ping'), 'pri'), btn('Traceroute', () => run('traceroute'))), out);
}
const wild = len => S.n2ip((~S.ip2n(S.lenToMask(len))) >>> 0);
function iosAddr(type, v) { if (type === 'any') return 'any'; if (type === 'host') return 'host ' + v; const [n, l] = v.split('/'); return n + ' ' + wild(+l || 24); }

// =====================================================================
// ASDM (ASA)
// =====================================================================
function asdm(d) {
  const nameifs = Object.values(d.ifs).map(x => x.nameif), P = (...a) => A().apply(d, ...a);
  const nav = [
    { id: 'home', label: 'Home', pages: [{ id: 'dash', label: 'Device Dashboard' }] },
    { id: 'cfg', label: 'Configuration', pages: [{ id: 'if', label: 'Device Setup > Interfaces' }, { id: 'acl', label: 'Firewall > Access Rules' }, { id: 'nat', label: 'Firewall > NAT Rules' }, { id: 'rt', label: 'Routing > Static Routes' }, { id: 'pt', label: 'Tools > Packet Tracer' }, { id: 'ping', label: 'Tools > Ping / Traceroute' }, { id: 'cli', label: 'Tools > Command Line (running-config)' }] },
    { id: 'mon', label: 'Monitoring', pages: [{ id: 'ifs', label: 'Interfaces' }, { id: 'conn', label: 'Connections' }, { id: 'xl', label: 'NAT Translations' }, { id: 'hits', label: 'Access Rule Hit Counts' }] }];
  return shell({ key: 'asdm' + d.name, cls: 'asdm', layout: 'topleft', brand: 'ASDM', sub: 'Adaptive Security Device Manager  -  ' + d.hostname + '  (192.168.100.11)', nav,
    right: () => [btn('⟳ Refresh', () => A().refreshWins()), btn('💾 Save', () => { cliOut(d, 'write memory'); A().notice('Running configuration saved to flash.'); })],
    status: 'admin (15)  |  Connected to ' + d.hostname + '  |  Device running  |  ' + new Date().toLocaleTimeString(),
    page: (m, s) => {
      if (s === 'dash') return h('div', {}, panel('Device Information', tbl(['Host name', 'Version', 'Mode', 'Interfaces', 'Connections'], [h('tr', {}, h('td', {}, d.hostname), h('td', {}, '9.20(1) (simulated)'), h('td', {}, 'Routed / Single'), h('td', {}, Object.keys(d.ifs).length), h('td', {}, d.conns.length))])),
        panel('Interface Status', tbl(['Interface', 'IP address', 'Line', 'Link'], Object.values(d.ifs).map(x => h('tr', {}, h('td', {}, x.nameif + ' (' + x.name + ')'), h('td', {}, x.ip + '/' + x.len), h('td', { class: x.up ? 'up' : 'dn' }, x.up ? '● Up' : '● Down'), h('td', { class: x.up ? 'up' : 'dn' }, x.up ? 'Up' : 'Down'))))), tiles([['NAT rules', d.nats.length], ['Access lists', Object.keys(d.acls).length], ['Connections', d.conns.length], ['Translations', d.xlates.length]]));
      if (s === 'if') { const f = { n: sel(Object.keys(d.ifs)), nm: inp('', 'name', '80px'), ip: inp('', 'IP address', '110px'), m: inp('255.255.255.0', 'mask', '110px'), sec: inp('', 'level', '50px') };
        return h('div', {}, panel('Interfaces', tbl(['Interface', 'Name', 'IP address', 'Subnet mask', 'Security level', 'Enabled'], Object.values(d.ifs).map(x => h('tr', {}, h('td', {}, x.name), h('td', {}, x.nameif), h('td', {}, x.ip), h('td', {}, S.lenToMask(x.len)), h('td', {}, x.sec), h('td', {}, x.up ? 'Yes' : 'No'))))),
          panel('Edit Interface', row(f.n, 'Name', f.nm, 'IP', f.ip, 'Mask', f.m, 'Level', f.sec, btn('Apply', () => P(['interface ' + f.n.value, f.nm.value ? 'nameif ' + f.nm.value : '', f.sec.value ? 'security-level ' + f.sec.value : '', f.ip.value ? 'ip address ' + f.ip.value + ' ' + f.m.value : ''].filter(Boolean)), 'pri')))); }
      if (s === 'acl') { const f = { acl: inp('OUT-IN', 'ACL name', '90px'), act: sel(['permit', 'deny']), pr: sel(['tcp', 'udp', 'icmp', 'ip']), st: sel(['any', 'host', 'network']), sv: inp('', 'source', '110px'), dt: sel(['host', 'any', 'object', 'network']), dv: inp('172.16.1.10', 'destination', '110px'), op: inp('80', 'port', '55px'), ifc: sel(['(none)'].concat(nameifs), 'outside') };
        const rows = []; for (const [n, es] of Object.entries(d.acls)) es.forEach((e, i) => rows.push(h('tr', {}, h('td', {}, n), h('td', {}, i + 1), h('td', { class: e.action === 'permit' ? 'up' : 'dn' }, e.action === 'permit' ? '✔ Permit' : '✖ Deny'), h('td', {}, S.aclText(e, 'asa').replace(/^(permit|deny) /, '')), h('td', {}, e.hits || 0), h('td', {}, btn('Delete', () => P(['no access-list ' + n + ' extended ' + S.aclText(e, 'asa')]), 'del')))));
        const add = () => { const sv_ = f.st.value === 'network' ? f.sv.value.split('/') : [f.sv.value]; const src = f.st.value === 'any' ? 'any' : f.st.value === 'host' ? 'host ' + f.sv.value : sv_[0] + ' ' + S.lenToMask(+sv_[1] || 24); const dd = f.dt.value === 'network' ? f.dv.value.split('/') : [f.dv.value]; const dst = f.dt.value === 'any' ? 'any' : f.dt.value === 'host' ? 'host ' + f.dv.value : f.dt.value === 'object' ? 'object ' + f.dv.value : dd[0] + ' ' + S.lenToMask(+dd[1] || 24);
          const port = (f.pr.value === 'tcp' || f.pr.value === 'udp') && f.op.value ? ' eq ' + f.op.value : ''; const ln = ['access-list ' + f.acl.value + ' extended ' + f.act.value + ' ' + f.pr.value + ' ' + src + ' ' + dst + port]; if (f.ifc.value !== '(none)') ln.push('access-group ' + f.acl.value + ' in interface ' + f.ifc.value); P(ln); };
        return h('div', {}, panel('Access Rules', tbl(['ACL', '#', 'Action', 'Rule', 'Hits', ''], rows), note('Rules match the REAL (un-NATed) destination address. Applied inbound on an interface; with no ACL the security-level rule applies.')), panel('Add Access Rule', row(f.acl, f.act, f.pr, 'Source', f.st, f.sv, 'Destination', f.dt, f.dv, 'Port', f.op, 'Interface', f.ifc, btn('Add', add, 'pri')))); }
      if (s === 'nat') { const x = { ip: inp('172.16.1.10', 'real host', '110px'), ri: sel(nameifs, 'dmz'), mi: sel(nameifs, 'outside'), mp: inp('203.0.113.10', 'mapped IP', '110px') }, p = { net: inp('10.1.0.0/16', 'network/len', '120px'), ri: sel(nameifs, 'inside'), mi: sel(nameifs, 'outside') };
        return h('div', {}, panel('NAT Rules', tbl(['#', 'Type', 'Object', 'Real interface', 'Mapped interface', 'Mapped address', ''], d.nats.map((n, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, n.kind === 'static' ? 'Static' : 'Dynamic (PAT)'), h('td', {}, n.obj), h('td', {}, n.realIf), h('td', {}, n.mappedIf), h('td', {}, n.mapped), h('td', {}, btn('Delete', () => P(['no object network ' + n.obj]), 'del')))))),
          panel('Add Static NAT (publish a server)', row('Real host', x.ip, x.ri, '→ Mapped IP', x.mp, x.mi, btn('Add', () => P(['object network OBJ-' + x.ip.value, 'host ' + x.ip.value, 'nat (' + x.ri.value + ',' + x.mi.value + ') static ' + x.mp.value]), 'pri'))),
          panel('Add Dynamic PAT (interface)', row('Network', p.net, p.ri, '→', p.mi, btn('Add', () => { const [n, l] = p.net.value.split('/'); P(['object network NET-' + n, 'subnet ' + n + ' ' + S.lenToMask(+l || 24), 'nat (' + p.ri.value + ',' + p.mi.value + ') dynamic interface']); }, 'pri')))); }
      if (s === 'rt') { const f = { i: sel(nameifs, 'outside'), n: inp('0.0.0.0/0', 'network/len', '120px'), g: inp('', 'gateway', '110px') };
        return h('div', {}, panel('Static Routes', tbl(['Interface', 'Network', 'Gateway', ''], d.routes.map(r => h('tr', {}, h('td', {}, r.nameif), h('td', {}, r.net + '/' + r.len), h('td', {}, r.nh), h('td', {}, btn('Delete', () => P(['no route ' + r.nameif + ' ' + r.net + ' ' + S.lenToMask(r.len) + ' ' + r.nh]), 'del')))))), panel('Add Route', row(f.i, f.n, 'via', f.g, btn('Add', () => { const [n, l] = f.n.value.split('/'); P(['route ' + f.i.value + ' ' + n + ' ' + S.lenToMask(+l || 0) + ' ' + f.g.value]); }, 'pri')))); }
      if (s === 'pt') { const f = { i: sel(nameifs, 'outside'), p: sel(['tcp', 'udp', 'icmp']), s: inp('198.51.100.10', 'source IP', '110px'), sp: inp('1234', 'sport', '55px'), d: inp('203.0.113.10', 'destination IP', '110px'), dp: inp('80', 'dport', '55px') }, res = h('div', {});
        return h('div', {}, panel('Packet Tracer', row('Ingress interface', f.i, f.p, 'Source', f.s, f.sp, 'Destination', f.d, f.dp, btn('Start', () => { const r = S.packetTracer(L(), d.name, f.i.value, { proto: f.p.value, src: f.s.value, sport: +f.sp.value, dst: f.d.value, dport: +f.dp.value }); res.innerHTML = ''; r.trace.forEach((x, i) => res.append(h('div', { class: 'ph ' + x.kind }, h('b', {}, 'Phase ' + (i + 1) + ': '), x.t))); const bad = r.o.st === 'drop' || r.o.st === 'noroute'; res.append(h('div', { class: 'phr ' + (bad ? 'dn' : 'up') }, bad ? '✖ Result: DROP - ' + r.o.why : '✔ Result: ALLOW')); }, 'pri')), res)); }
      if (s === 'ping') return toolsPane(d);
      if (s === 'cli') return panel('running-config', pre(cliOut(d, 'show running-config')));
      if (s === 'ifs') return panel('Interface Status', tbl(['Interface', 'Name', 'IP', 'Status', 'Level'], Object.values(d.ifs).map(x => h('tr', {}, h('td', {}, x.name), h('td', {}, x.nameif), h('td', {}, x.ip), h('td', { class: x.up ? 'up' : 'dn' }, x.up ? 'Up' : 'Down'), h('td', {}, x.sec)))));
      if (s === 'conn') return panel('Connections (' + d.conns.length + ')', row(btn('Clear all', () => { d.conns.length = 0; d.xlates.length = 0; A().commit(); })), tbl(['Proto', 'Initiator', 'Responder', 'In', 'Out', 'Hits'], d.conns.slice(-15).map(c => h('tr', {}, h('td', {}, c.proto), h('td', {}, c.in.src + ':' + c.in.sport), h('td', {}, c.in.dst + ':' + c.in.dport), h('td', {}, d.ifs[c.in.if].nameif), h('td', {}, d.ifs[c.out.if].nameif), h('td', {}, c.hits)))));
      if (s === 'xl') return panel('NAT Translations (' + d.xlates.length + ')', pre(cliOut(d, 'show xlate')));
      return panel('Access Rule Hit Counts', pre(cliOut(d, 'show access-list')));
    } });
}

// =====================================================================
// FMC (manages FTD1)
// =====================================================================
function fmc(f) {
  const d = f, dr = d.draft, P = () => { d.dirty = true; A().commit(); };
  const zones = ['any'].concat([...new Set(Object.values(dr.ifs).map(x => x.zone).filter(Boolean))]);
  const nav = [{ id: 'ov', label: 'Overview', pages: [{ id: 'dash', label: 'Dashboards' }] }, { id: 'an', label: 'Analysis', pages: [{ id: 'ev', label: 'Connection Events' }] }, { id: 'po', label: 'Policies', pages: [{ id: 'ac', label: 'Access Control' }] },
    { id: 'dv', label: 'Devices', pages: [{ id: 'dm', label: 'Device Management' }] }, { id: 'ob', label: 'Objects', pages: [{ id: 'zn', label: 'Object Management' }] }];
  const dev = NS.fmcdev = NS.fmcdev || { open: false, tab: 'Interfaces' };
  return shell({ key: 'fmc', cls: 'fmc', layout: 'toptabs', brand: 'Firewall Management Center', sub: 'FMC1  192.168.100.13', nav,
    right: (go) => [h('button', { class: 'deploybtn' + (d.dirty ? ' pend' : ''), onclick: () => go('_deploy') }, d.dirty ? 'Deploy  ●1' : 'Deploy'), h('span', { class: 'pusr' }, 'admin ▾')],
    page: (m, s, go) => {
      if (m === '_deploy') return h('div', {}, panel('Deployment', tbl(['', 'Device', 'Type', 'Status'], [h('tr', {}, h('td', {}, chk(d.dirty)), h('td', {}, 'FTD1'), h('td', {}, 'Threat Defense'), h('td', { class: d.dirty ? 'warn' : 'up' }, d.dirty ? 'Pending changes (policy, interfaces, routing, NAT)' : 'Up to date'))]), row(btn('Deploy', () => { if (!d.dirty) { A().notice('Nothing to deploy.'); return; } S.ftdDeploy(d); A().notice('Deployment to FTD1 completed.'); NS.fmc.m = 'ov'; NS.fmc.s = 'dash'; A().commit(); }, 'pri'), btn('Back', () => go('ov'))), note('Changes are NOT active on the firewall until you deploy.')));
      if (s === 'dash') { const ev = d.events, al = ev.filter(e => e.action === 'Allow').length, bl = ev.length - al, srcs = {}; ev.filter(e => e.action === 'Block').forEach(e => srcs[e.src] = (srcs[e.src] || 0) + 1);
        return h('div', {}, tiles([['Allowed connections', al], ['Blocked connections', bl], ['Active connections', d.conns.length], ['Access rules', d.policy.rules.length]]), panel('Managed devices', tbl(['Name', 'Management IP', 'Model', 'Health', 'Policy', 'Deployment'], [h('tr', {}, h('td', {}, 'FTD1'), h('td', {}, '192.168.100.12'), h('td', {}, 'Secure Firewall Threat Defense Virtual'), h('td', { class: 'up' }, '● Healthy'), h('td', {}, 'Initial_Access_Policy'), h('td', { class: d.dirty ? 'warn' : 'up' }, d.dirty ? 'Pending deploy' : 'Up to date'))])), panel('Top blocked sources', tbl(['Source IP', 'Blocks'], Object.entries(srcs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v)))))); }
      if (s === 'ev') return panel('Connection Events (all)', row(btn('⟳ Refresh', () => A().refreshWins())), tbl(['Action', 'Initiator IP', 'Responder IP', 'Protocol', 'Port', 'Access Control Rule', 'Reason'], d.events.slice(0, 30).map(e => h('tr', {}, h('td', { class: e.action === 'Allow' ? 'up' : 'dn' }, e.action), h('td', {}, e.src), h('td', {}, e.dst), h('td', {}, e.proto), h('td', {}, e.dport), h('td', {}, e.rule), h('td', {}, e.why)))));
      if (s === 'zn') return panel('Object Management > Interface > Security Zones', tbl(['Zone', 'Interfaces'], zones.filter(z => z !== 'any').map(z => h('tr', {}, h('td', {}, z), h('td', {}, Object.values(dr.ifs).filter(x => x.zone === z).map(x => x.name + ' (' + x.ip + ')').join(', '))))), note('Zones are assigned to interfaces under Devices > Device Management > Interfaces.'));
      if (s === 'dm') {
        if (!dev.open) return panel('Device Management', tbl(['Name', 'Group', 'Model', 'Access control policy', ''], [h('tr', {}, h('td', {}, 'FTD1'), h('td', {}, 'None'), h('td', {}, 'Secure Firewall Threat Defense Virtual'), h('td', {}, 'Initial_Access_Policy'), h('td', {}, btn('✎ Edit', () => { dev.open = true; A().refreshWins(); }, 'pri')))]));
        const tabs = ['Interfaces', 'Routing', 'NAT'], t = dev.tab;
        let c;
        if (t === 'Interfaces') c = tbl(['Interface', 'Logical name', 'Security zone', 'IPv4 address', 'Prefix', 'Enabled', ''], Object.values(dr.ifs).map(x => { const z = inp(x.zone, 'zone', '70px'), ip = inp(x.ip, 'x.x.x.x', '110px'), ln = inp(x.len, '', '40px'), en = chk(x.up); return h('tr', {}, h('td', {}, x.name), h('td', {}, x.nameif), h('td', {}, z), h('td', {}, ip), h('td', {}, ln), h('td', {}, en), h('td', {}, btn('Save', () => { x.zone = z.value.trim(); x.ip = ip.value.trim() || null; x.len = +ln.value || 24; x.up = en.checked; P(); }))); }));
        else if (t === 'Routing') { const r = { n: inp('0.0.0.0/0', 'network/len', '120px'), g: inp('192.0.2.2', 'gateway', '110px') }; c = h('div', {}, tbl(['Network', 'Gateway', ''], dr.routes.map((x, i) => h('tr', {}, h('td', {}, x.net + '/' + x.len), h('td', {}, x.nh), h('td', {}, btn('Delete', () => { dr.routes.splice(i, 1); P(); }, 'del'))))), row('Add static route', r.n, 'via', r.g, btn('Add', () => { const [n, l] = r.n.value.split('/'); dr.routes.push({ net: n, len: +l || 0, nh: r.g.value }); P(); }, 'pri'))); }
        else { const r = { s: inp('IN', 'source zone', '80px'), d: inp('OUT', 'dest zone', '80px') }; c = h('div', {}, tbl(['Type', 'Source zone', 'Destination zone', ''], dr.nat.map((x, i) => h('tr', {}, h('td', {}, 'Dynamic PAT (interface)'), h('td', {}, x.srcZone), h('td', {}, x.dstZone), h('td', {}, btn('Delete', () => { dr.nat.splice(i, 1); P(); }, 'del'))))), row('Add PAT rule', r.s, '→', r.d, btn('Add', () => { dr.nat.push({ srcZone: r.s.value.trim(), dstZone: r.d.value.trim() }); P(); }, 'pri'))); }
        return h('div', {}, row(btn('◀ All devices', () => { dev.open = false; A().refreshWins(); }), h('b', {}, 'FTD1'), 'Secure Firewall Threat Defense Virtual  |  192.168.100.12'), h('div', { class: 'ptabs inner' }, tabs.map(x => h('button', { class: t === x ? 'on' : '', onclick: () => { dev.tab = x; A().refreshWins(); } }, x))), panel(null, c));
      }
      // Access control policy
      const f2 = { n: inp('Allow-IN-OUT', 'name', '110px'), s: inp('IN', 'src zone', '60px'), d: inp('OUT', 'dst zone', '60px'), sn: inp('any', 'src network', '100px'), dn: inp('any', 'dst network', '100px'), p: sel(['any', 'tcp', 'udp', 'icmp']), pt: inp('', 'port', '55px'), a: sel(['allow', 'block']), ips: chk(false), pos: sel(['top', 'bottom']) };
      const defSel = sel(['block', 'allow'], dr.policy.defaultAction); defSel.addEventListener('change', () => { dr.policy.defaultAction = defSel.value; P(); });
      return h('div', {}, panel('Access Control Policy: Initial_Access_Policy', tbl(['#', 'Name', 'Source zones', 'Dest zones', 'Source networks', 'Dest networks', 'Protocol / port', 'Action', 'IPS', 'Hits', ''], dr.policy.rules.map((r, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, r.name), h('td', {}, r.srcZone), h('td', {}, r.dstZone), h('td', {}, r.srcNet), h('td', {}, r.dstNet), h('td', {}, r.proto + (r.dport ? '/' + r.dport : '')), h('td', { class: r.action === 'allow' ? 'up' : 'dn' }, r.action === 'allow' ? '✔ Allow' : '⛔ Block'), h('td', {}, chk(r.ips, v => { r.ips = v; P(); })), h('td', {}, r.hits || 0), h('td', {}, btn('↑', () => { if (i) { const [x] = dr.policy.rules.splice(i, 1); dr.policy.rules.splice(i - 1, 0, x); P(); } }), btn('Delete', () => { dr.policy.rules.splice(i, 1); P(); }, 'del'))))), row('Default Action:', defSel, h('span', { class: 'dim' }, '(rules are matched top-down; unmatched traffic gets the default action)'))),
        panel('Add Rule', row(f2.n, f2.s, '→', f2.d, f2.sn, f2.dn, f2.p, f2.pt, f2.a, h('label', {}, f2.ips, ' Intrusion policy'), 'Insert', f2.pos, btn('Add Rule', () => { dr.policy.rules[f2.pos.value === 'top' ? 'unshift' : 'push']({ name: f2.n.value, srcZone: f2.s.value.trim() || 'any', dstZone: f2.d.value.trim() || 'any', srcNet: f2.sn.value || 'any', dstNet: f2.dn.value || 'any', proto: f2.p.value, dport: f2.pt.value ? +f2.pt.value : null, action: f2.a.value, ips: f2.ips.checked }); P(); }, 'pri'))));
    } });
}

// =====================================================================
// ISE
// =====================================================================
function ise(d) {
  const I = L().ise, grp = ['Employees', 'Contractors', 'Printers', 'Unknown'], profs = Object.keys(I.profiles), C_ = () => A().commit();
  const nav = [{ id: 'home', label: 'Home', pages: [{ id: 'sum', label: 'Summary' }] }, { id: 'ops', label: 'Operations', pages: [{ id: 'live', label: 'RADIUS Live Logs' }] },
    { id: 'pol', label: 'Policy', pages: [{ id: 'authz', label: 'Authorization' }, { id: 'proto', label: 'Allowed Protocols' }, { id: 'prof', label: 'Authorization Profiles' }] }, { id: 'adm', label: 'Administration', pages: [{ id: 'nd', label: 'Network Devices' }, { id: 'usr', label: 'Users' }, { id: 'ep', label: 'Endpoints' }] }];
  return shell({ key: 'ise', cls: 'ise', layout: 'toptabs', brand: 'Identity Services Engine', sub: 'ise1  192.168.100.14', nav, right: () => [h('span', { class: 'pusr' }, 'admin ▾')],
    page: (m, s) => {
      if (s === 'sum') { const pass = I.logs.filter(l => l.result === 'Pass').length; return h('div', {}, tiles([['Total authentications', I.logs.length], ['Passed', pass], ['Failed', I.logs.length - pass], ['Network devices', I.devices.length], ['Users', I.users.length]]), panel('Latest authentications', tbl(['Time', 'Status', 'Identity', 'Network device', 'Details'], I.logs.slice(0, 5).map(e => h('tr', {}, h('td', {}, e.t), h('td', { class: e.result === 'Pass' ? 'up' : 'dn' }, e.result), h('td', {}, e.user), h('td', {}, e.nas), h('td', {}, e.why))))), note('Tip: right-click Client > Network login (802.1X) to generate authentications.')); }
      if (s === 'live') return panel('RADIUS Live Logs', row(btn('⟳ Refresh', () => A().refreshWins())), tbl(['Time', 'Status', 'Identity', 'Endpoint ID', 'Network Device', 'Protocol', 'Authorization Profile', 'Details'], I.logs.slice(0, 25).map(e => h('tr', {}, h('td', {}, e.t), h('td', { class: e.result === 'Pass' ? 'up' : 'dn' }, e.result === 'Pass' ? '✔ Pass' : '✖ Fail'), h('td', {}, e.user), h('td', {}, e.mac), h('td', {}, e.nas), h('td', {}, e.method), h('td', {}, e.profile), h('td', {}, e.why)))), I.logs.length ? null : note('No authentications yet.'));
      if (s === 'nd') { const f = { n: inp('SW1', 'name', '90px'), ip: inp('192.168.100.23', 'IP address', '120px'), s: inp('', 'shared secret', '120px') };
        return h('div', {}, panel('Network Devices', tbl(['Name', 'IP address', 'Shared secret', ''], I.devices.map((x, i) => h('tr', {}, h('td', {}, x.name), h('td', {}, x.ip), h('td', {}, '••••••'), h('td', {}, btn('Delete', () => { I.devices.splice(i, 1); C_(); }, 'del'))))), I.devices.length ? null : note('No network devices: ISE ignores RADIUS requests from unknown devices.')), panel('Add Network Device', row(f.n, f.ip, f.s, btn('Submit', () => { I.devices.push({ name: f.n.value, ip: f.ip.value, secret: f.s.value }); C_(); }, 'pri')), note('The shared secret must equal "key" under the switch radius server.'))); }
      if (s === 'usr') { const u = { n: inp('', 'username', '100px'), p: inp('Cisco123!', 'password', '100px'), g: sel(['Employees', 'Contractors']) };
        return h('div', {}, panel('Network Access Users', tbl(['Username', 'Identity group', ''], I.users.map((x, i) => h('tr', {}, h('td', {}, x.name), h('td', {}, x.group), h('td', {}, btn('Delete', () => { I.users.splice(i, 1); C_(); }, 'del'))))), row(u.n, u.p, u.g, btn('Add', () => { if (u.n.value) { I.users.push({ name: u.n.value, pass: u.p.value, group: u.g.value }); C_(); } }, 'pri')))); }
      if (s === 'ep') { const en = { m: inp(C.macOf('Client', 'eth0'), 'MAC', '130px'), g: sel(['Printers', 'Unknown']) };
        return h('div', {}, panel('Endpoints (for MAC Authentication Bypass)', tbl(['MAC address', 'Endpoint identity group', ''], I.endpoints.map((x, i) => h('tr', {}, h('td', {}, x.mac), h('td', {}, x.group), h('td', {}, btn('Delete', () => { I.endpoints.splice(i, 1); C_(); }, 'del'))))), row(en.m, en.g, btn('Add endpoint', () => { I.endpoints.push({ mac: en.m.value, group: en.g.value }); C_(); }, 'pri')), note('Prefilled MAC = the Client PC.'))); }
      if (s === 'proto') return panel('Allowed Protocols: Default Network Access', row(h('label', {}, chk(I.allowDot1x, v => { I.allowDot1x = v; C_(); }), ' Allow PEAP / EAP (802.1X)')), row(h('label', {}, chk(I.allowMab, v => { I.allowMab = v; C_(); }), ' Allow MAC Authentication Bypass (MAB)')));
      if (s === 'authz') { const f = { n: inp('Rule1', 'name', '90px'), g: sel(['any'].concat(grp)), m: sel(['any', 'dot1x', 'mab']), p: sel(profs) };
        return h('div', {}, panel('Authorization Policy (first match wins)', tbl(['#', 'Rule name', 'Identity group', 'Method', 'Result: profile', ''], I.authz.map((r, i) => { const ps = sel(profs, r.profile); ps.addEventListener('change', () => { r.profile = ps.value; C_(); }); return h('tr', {}, h('td', {}, i + 1), h('td', {}, r.name), h('td', {}, r.group), h('td', {}, r.method), h('td', {}, ps), h('td', {}, btn('↑', () => { if (i) { const [x] = I.authz.splice(i, 1); I.authz.splice(i - 1, 0, x); C_(); } }), btn('Delete', () => { I.authz.splice(i, 1); C_(); }, 'del'))); })), note('Default (no match): DenyAccess')), panel('Add rule', row(f.n, f.g, f.m, f.p, btn('Add (top)', () => { I.authz.unshift({ name: f.n.value, group: f.g.value, method: f.m.value, profile: f.p.value }); C_(); }, 'pri')))); }
      const f = { n: inp('', 'name', '110px'), a: sel(['accept', 'reject']), v: inp('10', 'VLAN', '50px'), d: h('textarea', { rows: 3, placeholder: 'permit tcp any any eq 80', style: 'width:98%' }) };
      return h('div', {}, panel('Authorization Profiles', tbl(['Name', 'Access type', 'VLAN', 'Downloadable ACL', ''], Object.entries(I.profiles).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: v.access === 'accept' ? 'up' : 'dn' }, v.access === 'accept' ? 'ACCESS_ACCEPT' : 'ACCESS_REJECT'), h('td', {}, v.vlan || ''), h('td', {}, h('pre', { class: 'mini' }, v.dacl || '-')), h('td', {}, ['PermitAccess', 'DenyAccess'].includes(k) ? '' : btn('Delete', () => { delete I.profiles[k]; C_(); }, 'del')))))),
        panel('Add profile', row(f.n, f.a, f.v), f.d, row(btn('Save', () => { if (f.n.value) { I.profiles[f.n.value] = { access: f.a.value, vlan: +f.v.value || 1, dacl: f.d.value }; C_(); } }, 'pri')), note('A dACL is pushed to the switch port, e.g. "permit tcp any any eq 80" (everything else is implicitly denied).')));
    } });
}

// =====================================================================
// ESA / WSA with staged "Commit Changes"
// =====================================================================
const ESA_KEYS = ['domains', 'hat', 'spfAction', 'antispam', 'antivirus', 'dlp', 'filters', 'dns'], WSA_KEYS = ['policy', 'allowlist', 'blocklist', 'av', 'decrypt'];
const pick = (o, keys) => { const r = {}; keys.forEach(k => r[k] = o[k]); return r; };
function stage(name, obj, keys) { const L_ = L(), dk = name + 'Draft'; if (!L_[dk]) L_[dk] = clone(pick(obj, keys)); return L_[dk]; }
function pending(name, obj, keys) { const dk = name + 'Draft', L_ = L(); return !!L_[dk] && JSON.stringify(L_[dk]) !== JSON.stringify(pick(obj, keys)); }
function commitPage(name, obj, keys, go) {
  const L_ = L(), dk = name + 'Draft', pend = pending(name, obj, keys);
  return h('div', {}, panel('Commit Changes', pend ? h('p', { class: 'warn' }, '⚠ You have uncommitted changes. They are NOT active until you commit.') : h('p', { class: 'up' }, '✔ No uncommitted changes.'), row(btn('Commit Changes', () => { if (L_[dk]) Object.assign(obj, clone(L_[dk])); delete L_[dk]; A().notice('Changes committed.'); NS[name].m = name === 'esa' ? 'mon' : 'rep'; NS[name].s = 'ov'; A().commit(); }, 'pri'), btn('Abandon Changes', () => { delete L_[dk]; A().notice('Changes abandoned.'); A().commit(); }, 'del'), btn('Back', () => go(name === 'esa' ? 'mon' : 'rep'))), note('AsyncOS-style: configuration edits take effect only after Commit.')));
}
function esa(d) {
  const E = L().esa, D = () => stage('esa', E, ESA_KEYS), E1 = () => A().commit();
  const nav = [{ id: 'mon', label: 'Monitor', pages: [{ id: 'ov', label: 'Overview' }, { id: 'mt', label: 'Message Tracking' }, { id: 'qu', label: 'Quarantine' }] }, { id: 'mp', label: 'Mail Policies', pages: [{ id: 'inc', label: 'Incoming Mail Policies' }, { id: 'cf', label: 'Incoming Content Filters' }, { id: 'hat', label: 'HAT Overview' }] },
    { id: 'net', label: 'Network', pages: [{ id: 'rat', label: 'Recipient Access Table' }, { id: 'dns', label: 'DNS (SPF records)' }] }, { id: 'sys', label: 'System Administration', pages: [{ id: 'trace', label: 'Trace (test mail flow)' }] }];
  const pend = pending('esa', E, ESA_KEYS);
  return shell({ key: 'esa', cls: 'esa', layout: 'toptabs', brand: 'Email Security Appliance', sub: 'C100V  esa1.lab.local', nav, right: go => [h('button', { class: 'commitbtn' + (pend ? ' pend' : ''), onclick: () => go('_commit') }, pend ? 'Commit Changes ●' : 'No Changes Pending'), h('span', { class: 'pusr' }, 'Options: admin ▾')],
    page: (m, s, go) => {
      if (m === '_commit') return commitPage('esa', E, ESA_KEYS, go);
      const Dr = D();
      if (s === 'ov') return h('div', {}, tiles([['Accepted', E.counters.accepted], ['Spam detected', E.counters.spam], ['Viruses', E.counters.virus], ['Blocked (HAT/SPF)', E.counters.blocked], ['DLP violations', E.counters.dlp]]), panel('Mailboxes', tbl(['User', 'Messages', 'Latest'], Object.entries(E.mailboxes).map(([u, ms]) => h('tr', {}, h('td', {}, u + '@lab.local'), h('td', {}, ms.length), h('td', {}, ms[0] ? ms[0].subject + ' (from ' + ms[0].from + ')' : ''))))));
      if (s === 'mt') return panel('Message Tracking', row(btn('⟳ Refresh', () => A().refreshWins())), tbl(['Time', 'MID', 'From', 'To', 'Subject', 'Attachments', 'Sender IP', 'Result', 'Reason'], E.tracking.slice(0, 25).map(x => h('tr', {}, h('td', {}, x.t), h('td', {}, x.mid), h('td', {}, x.from), h('td', {}, x.to), h('td', {}, x.subject), h('td', {}, x.attach), h('td', {}, x.src), h('td', { class: /delivered/.test(x.disp) ? 'up' : 'dn' }, x.disp), h('td', {}, x.why)))));
      if (s === 'qu') return panel('Quarantines', tbl(['From', 'To', 'Subject', ''], E.quarantine.map((x, i) => h('tr', {}, h('td', {}, x.from), h('td', {}, x.to), h('td', {}, x.subject), h('td', {}, btn('Release', () => { const u = x.to.split('@')[0]; (E.mailboxes[u] = E.mailboxes[u] || []).unshift({ from: x.from, subject: x.subject, t: 'released' }); E.quarantine.splice(i, 1); E1(); }), btn('Delete', () => { E.quarantine.splice(i, 1); E1(); }, 'del'))))), E.quarantine.length ? null : note('Quarantine is empty.'));
      if (s === 'inc') { const as = chk(Dr.antispam.on), th = inp(Dr.antispam.threshold, 'score', '55px'), aa = sel(['quarantine', 'drop'], Dr.antispam.action), av = chk(Dr.antivirus), dl = chk(Dr.dlp), sp = sel(['tag', 'quarantine', 'reject'], Dr.spfAction);
        return panel('Incoming Mail Policies > Default Policy', row(h('label', {}, as, ' Anti-Spam'), 'positive threshold', th, 'action', aa), row(h('label', {}, av, ' Anti-Virus')), row(h('label', {}, dl, ' Data Loss Prevention (US SSN)')), row('SPF/SIDF verification - action on FAIL', sp), row(btn('Submit', () => { Dr.antispam = { on: as.checked, threshold: +th.value || 50, action: aa.value }; Dr.antivirus = av.checked; Dr.dlp = dl.checked; Dr.spfAction = sp.value; E1(); A().notice('Submitted. Remember to Commit Changes.'); }, 'pri')), note('Edits stay pending until you press "Commit Changes" (top right).')); }
      if (s === 'cf') { const f = { n: inp('NoExe', 'name', '90px'), c: sel(['attachment-ext', 'subject-contains', 'body-contains']), v: inp('exe', 'value', '90px'), a: sel(['drop', 'quarantine', 'tag']) };
        return h('div', {}, panel('Incoming Content Filters', tbl(['Order', 'Name', 'Condition', 'Value', 'Action', ''], Dr.filters.map((x, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, x.name), h('td', {}, x.cond), h('td', {}, x.value), h('td', {}, x.action), h('td', {}, btn('Delete', () => { Dr.filters.splice(i, 1); E1(); }, 'del'))))), Dr.filters.length ? null : note('No content filters defined.')), panel('Add Filter', row(f.n, f.cond || f.c, f.v, f.a, btn('Add', () => { Dr.filters.push({ name: f.n.value, cond: f.c.value, value: f.v.value, action: f.a.value }); E1(); }, 'pri')))); }
      if (s === 'hat') { const f = { g: sel(Dr.hat.map(x => x.name)), ip: inp('198.51.100.10', 'IP or CIDR', '140px') };
        return h('div', {}, panel('Host Access Table (HAT) Overview', tbl(['Sender group', 'Policy', 'Sender IPs'], Dr.hat.map(g => h('tr', {}, h('td', {}, g.name), h('td', { class: g.policy === 'block' ? 'dn' : 'up' }, g.policy === 'block' ? 'REJECT' : 'ACCEPT (trusted)'), h('td', {}, g.ips.map((ip, i) => h('span', { class: 'chip' }, ip, h('button', { class: 'x', onclick: () => { g.ips.splice(i, 1); E1(); } }, '✕'))))))), note('A sender in BLOCKLIST is refused at connection time, before any content scanning.')), panel('Add sender', row(f.g, f.ip, btn('Add', () => { Dr.hat.find(x => x.name === f.g.value).ips.push(f.ip.value); E1(); }, 'pri')))); }
      if (s === 'rat') { const f = inp('', 'domain', '120px'); return panel('Recipient Access Table (accepted domains)', tbl(['Domain', ''], Dr.domains.map((x, i) => h('tr', {}, h('td', {}, x), h('td', {}, btn('Delete', () => { Dr.domains.splice(i, 1); E1(); }, 'del'))))), row(f, btn('Add domain', () => { if (f.value) { Dr.domains.push(f.value); E1(); } }, 'pri'))); }
      if (s === 'dns') { const g = { d: inp('example.net', 'domain', '120px'), ips: inp('198.51.100.10', 'authorised sending IPs (comma separated)', '240px') }; return panel('Simulated Internet DNS - SPF records', tbl(['Sender domain', 'SPF-authorised sending IPs', ''], Object.entries(Dr.dns).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v.spf.join(', ')), h('td', {}, btn('Delete', () => { delete Dr.dns[k]; E1(); }, 'del'))))), row(g.d, g.ips, btn('Add / replace', () => { Dr.dns[g.d.value] = { spf: g.ips.value.split(',').map(x => x.trim()).filter(Boolean) }; E1(); }, 'pri'))); }
      const hosts = Object.keys(L().dev).filter(k => L().dev[k].type === 'host' && !L().dev[k].role), hs = sel(hosts, 'Outside');
      return panel('Trace: send a test message through the appliance', row('Send from PC', hs), A().mailForm(() => hs.value, { server: '203.0.113.20' }), note('Uses the COMMITTED configuration. From Outside-Desktop use 203.0.113.20 (published); from inside PCs use 172.16.1.20.'));
    } });
}
function wsa(d) {
  const W = L().wsa, D = () => stage('wsa', W, WSA_KEYS), E1 = () => A().commit();
  const nav = [{ id: 'rep', label: 'Reporting', pages: [{ id: 'ov', label: 'Overview' }, { id: 'log', label: 'Web Tracking (access log)' }] }, { id: 'wsm', label: 'Web Security Manager', pages: [{ id: 'ap', label: 'Access Policies' }, { id: 'cl', label: 'Custom URL Categories' }] },
    { id: 'ss', label: 'Security Services', pages: [{ id: 'https', label: 'HTTPS Proxy' }, { id: 'am', label: 'Anti-Malware and Reputation' }] }, { id: 'sys', label: 'System Administration', pages: [{ id: 'pt', label: 'Policy Trace (test request)' }] }];
  const pend = pending('wsa', W, WSA_KEYS);
  return shell({ key: 'wsa', cls: 'wsa', layout: 'toptabs', brand: 'Secure Web Appliance', sub: 'S100V  wsa1.lab.local  proxy 172.16.1.30:3128', nav, right: go => [h('button', { class: 'commitbtn' + (pend ? ' pend' : ''), onclick: () => go('_commit') }, pend ? 'Commit Changes ●' : 'No Changes Pending'), h('span', { class: 'pusr' }, 'Options: admin ▾')],
    page: (m, s, go) => {
      if (m === '_commit') return commitPage('wsa', W, WSA_KEYS, go);
      const Dr = D();
      if (s === 'ov') return h('div', {}, tiles([['Total requests', W.counters.total], ['Allowed', W.counters.allowed], ['Blocked', W.counters.blocked], ['Malware blocked', W.counters.malware]]), note('Explicit proxy: configure a browser Proxy = 172.16.1.30:3128 (Client > Desktop > "use WSA"), or: curl -x 172.16.1.30:3128 http://www.cisco.com'));
      if (s === 'log') return panel('Web Tracking', row(btn('⟳ Refresh', () => A().refreshWins())), tbl(['Time', 'Client', 'URL', 'Category', 'Action', 'Reason'], W.log.slice(0, 25).map(x => h('tr', {}, h('td', {}, x.t), h('td', {}, x.client), h('td', {}, x.url), h('td', {}, x.cat), h('td', { class: x.act === 'Blocked' ? 'dn' : 'up' }, x.act), h('td', {}, x.why)))));
      if (s === 'ap') return panel('Access Policies > Global Policy > URL Filtering', tbl(['URL category', 'Action'], Object.keys(Dr.policy).map(c => { const sl = sel(['allow', 'monitor', 'block'], Dr.policy[c]); sl.addEventListener('change', () => { Dr.policy[c] = sl.value; E1(); A().notice(c + ': ' + sl.value + ' (pending commit)'); }); return h('tr', {}, h('td', {}, c), h('td', {}, sl)); })), note('Edits stay pending until you press "Commit Changes" (top right).'));
      if (s === 'cl') { const f = { l: sel(['Allow list', 'Block list']), d: inp('www.example.com', 'domain', '170px') };
        return panel('Custom URL Categories', h('p', {}, 'Allow: ', Dr.allowlist.length ? Dr.allowlist.map((x, i) => h('span', { class: 'chip' }, x, h('button', { class: 'x', onclick: () => { Dr.allowlist.splice(i, 1); E1(); } }, '✕'))) : '-', '   Block: ', Dr.blocklist.length ? Dr.blocklist.map((x, i) => h('span', { class: 'chip' }, x, h('button', { class: 'x', onclick: () => { Dr.blocklist.splice(i, 1); E1(); } }, '✕'))) : '-'), row(f.l, f.d, btn('Add', () => { (f.l.value === 'Allow list' ? Dr.allowlist : Dr.blocklist).push(f.d.value); E1(); }, 'pri')), note('Custom lists override the category action.')); }
      if (s === 'https') return panel('HTTPS Proxy', row(h('label', {}, chk(Dr.decrypt, v => { Dr.decrypt = v; E1(); }), ' Enable HTTPS Proxy (decrypt and inspect HTTPS)')), note('Without decryption the WSA sees only the destination host name of HTTPS requests: it can filter by category but cannot scan downloads for malware.'));
      if (s === 'am') return panel('Anti-Malware and Reputation', row(h('label', {}, chk(Dr.av, v => { Dr.av = v; E1(); }), ' Enable Anti-Malware scanning')));
      const hosts = Object.keys(L().dev).filter(k => L().dev[k].type === 'host' && !L().dev[k].role), hs = sel(hosts, 'Client'), u = inp('http://www.facebook.com', 'URL', '260px'), out = h('div', {});
      return panel('Policy Trace', row('From', hs, u, btn('Send request', () => { A().setAnim(null); const r = S.webGet(L(), hs.value, { url: u.value, proxy: '172.16.1.30:3128' }); out.innerHTML = ''; (r.steps || []).forEach(x => out.append(h('div', { class: 'ph ' + (x.k === 'drop' ? 'drop' : x.k === 'ok' ? 'ok' : '') }, x.t))); out.append(h('div', { class: 'phr ' + (r.ok ? 'up' : 'dn') }, r.ok ? '✔ 200 OK - ' + r.page : '✖ ' + (r.why || r.kind))); A().afterTool(r.net); }, 'pri')), out, note('Uses the COMMITTED configuration.'));
    } });
}

// =====================================================================
// IOS web UI (routers + switches)
// =====================================================================
function iosRouter(d) {
  const acls = Object.keys(d.acls), ifs = Object.keys(d.ifs), P = a => A().apply(d, a);
  const nav = [{ id: 'dash', label: 'Dashboard', pages: [{ id: 'ov', label: 'Overview' }] }, { id: 'cfg', label: 'Configuration', pages: [{ id: 'if', label: 'Interfaces' }, { id: 'rt', label: 'Static Routing' }, { id: 'acl', label: 'Access Lists (ACL)' }] },
    { id: 'mon', label: 'Monitoring', pages: [{ id: 'route', label: 'Routing Table' }, { id: 'arp', label: 'ARP & CDP' }] }, { id: 'adm', label: 'Administration', pages: [{ id: 'ping', label: 'Ping & Traceroute' }, { id: 'run', label: 'Running Config' }] }];
  return shell({ key: 'ios' + d.name, cls: 'ios', layout: 'left', brand: d.hostname, sub: 'IOS-XE style Web UI (simulated)', nav, right: () => [btn('💾 Save config', () => { cliOut(d, 'write memory'); A().notice('Configuration saved.'); })],
    page: (m, s) => {
      if (s === 'ov') return h('div', {}, panel('System', tbl(['Hostname', 'Software', 'Interfaces up', 'Static routes', 'ACLs'], [h('tr', {}, h('td', {}, d.hostname), h('td', {}, 'IOSv 15.9(3)M6 (simulated)'), h('td', {}, Object.values(d.ifs).filter(x => x.up).length + ' / ' + ifs.length), h('td', {}, d.routes.length), h('td', {}, acls.length))])), panel('Interfaces', tbl(['Interface', 'IP / mask', 'Status', 'ACL in', 'ACL out'], Object.values(d.ifs).map(x => h('tr', {}, h('td', {}, x.name), h('td', {}, x.ip ? x.ip + '/' + x.len : '-'), h('td', { class: x.up ? 'up' : 'dn' }, x.up ? '● up' : '● down'), h('td', {}, x.aclIn || '-'), h('td', {}, x.aclOut || '-'))))));
      if (s === 'if') { const f = { n: sel(ifs), ip: inp('', 'IP address', '120px'), m: inp('255.255.255.0', 'mask', '120px'), en: chk(true), ai: sel(['(none)'].concat(acls)), ao: sel(['(none)'].concat(acls)) };
        return h('div', {}, panel('Interfaces', tbl(['Interface', 'IP / mask', 'State'], Object.values(d.ifs).map(x => h('tr', {}, h('td', {}, x.name), h('td', {}, x.ip ? x.ip + '/' + x.len : '-'), h('td', {}, x.up ? 'up' : 'down'))))), panel('Edit interface', row(f.n, f.ip, f.m, h('label', {}, f.en, ' enabled'), 'ACL in', f.ai, 'ACL out', f.ao, btn('Apply', () => { const x = d.ifs[f.n.value], ln = ['interface ' + x.name]; if (f.ip.value) ln.push('ip address ' + f.ip.value + ' ' + f.m.value); ln.push(f.en.checked ? 'no shutdown' : 'shutdown');
          if (x.aclIn && f.ai.value === '(none)') ln.push('no ip access-group ' + x.aclIn + ' in'); else if (f.ai.value !== '(none)') ln.push('ip access-group ' + f.ai.value + ' in'); if (x.aclOut && f.ao.value === '(none)') ln.push('no ip access-group ' + x.aclOut + ' out'); else if (f.ao.value !== '(none)') ln.push('ip access-group ' + f.ao.value + ' out'); P(ln); }, 'pri')))); }
      if (s === 'rt') { const f = { n: inp('0.0.0.0/0', 'network/len', '120px'), g: inp('', 'next hop', '110px') };
        return h('div', {}, panel('Static Routes', tbl(['Network', 'Next hop', ''], d.routes.map(r => h('tr', {}, h('td', {}, r.net + '/' + r.len), h('td', {}, r.nh), h('td', {}, btn('Delete', () => P(['no ip route ' + r.net + ' ' + S.lenToMask(r.len) + ' ' + r.nh]), 'del'))))), d.routes.length ? null : note('No static routes.')), panel('Add Static Route', row(f.n, 'via', f.g, btn('Add', () => { const [n, l] = f.n.value.split('/'); P(['ip route ' + n + ' ' + S.lenToMask(+l || 0) + ' ' + f.g.value]); }, 'pri')))); }
      if (s === 'acl') { const f = { acl: inp(acls[0] || 'BLOCK', 'ACL name', '100px'), act: sel(['permit', 'deny']), pr: sel(['tcp', 'udp', 'icmp', 'ip']), st: sel(['any', 'host', 'network']), sv: inp('', 'source', '100px'), dt: sel(['host', 'any', 'network']), dv: inp('172.16.1.10', 'destination', '100px'), op: inp('80', 'port', '50px'), ifc: sel(['(none)'].concat(ifs)), dir: sel(['in', 'out']) };
        const rows = []; for (const [n, es] of Object.entries(d.acls)) es.forEach((e, i) => rows.push(h('tr', {}, h('td', {}, n), h('td', {}, (i + 1) * 10), h('td', { class: e.action === 'permit' ? 'up' : 'dn' }, e.action), h('td', {}, S.aclText(e, 'ios').replace(/^(permit|deny) /, '')), h('td', {}, e.hits || 0), h('td', {}, btn('Delete', () => P(['ip access-list extended ' + n, 'no ' + S.aclText(e, 'ios')]), 'del')))));
        return h('div', {}, panel('Extended Access Lists', tbl(['ACL', 'Seq', 'Action', 'Rule', 'Hits', ''], rows), note('Checked top-down. End with "permit ip any any" or everything else is implicitly denied.')), panel('Add Rule', row(f.acl, f.act, f.pr, 'src', f.st, f.sv, 'dst', f.dt, f.dv, 'port', f.op, 'apply to', f.ifc, f.dir, btn('Add', () => { const port = (f.pr.value === 'tcp' || f.pr.value === 'udp') && f.op.value ? ' eq ' + f.op.value : ''; const ln = ['ip access-list extended ' + f.acl.value, f.act.value + ' ' + f.pr.value + ' ' + iosAddr(f.st.value, f.sv.value) + ' ' + iosAddr(f.dt.value, f.dv.value) + port]; if (f.ifc.value !== '(none)') ln.push('interface ' + f.ifc.value, 'ip access-group ' + f.acl.value + ' ' + f.dir.value); P(ln); }, 'pri')))); }
      if (s === 'route') return panel('Routing Table', pre(cliOut(d, 'show ip route')));
      if (s === 'arp') return panel('ARP table', pre(cliOut(d, 'show arp')), pre(cliOut(d, 'show cdp neighbors')));
      if (s === 'ping') return toolsPane(d);
      return panel('Running Configuration', pre(cliOut(d, 'show running-config')));
    } });
}
function iosSwitch(d) {
  const ports = Object.keys(d.ifs).filter(k => !d.ifs[k].svi), vl = Object.keys(d.vlans), P = a => A().apply(d, a);
  const nav = [{ id: 'dash', label: 'Dashboard', pages: [{ id: 'ov', label: 'Overview' }] }, { id: 'cfg', label: 'Configuration', pages: [{ id: 'ports', label: 'Switch Ports' }, { id: 'vlan', label: 'VLANs' }, { id: 'dot', label: '802.1X / RADIUS' }] }, { id: 'mon', label: 'Monitoring', pages: [{ id: 'mac', label: 'MAC Address Table' }, { id: 'cdp', label: 'CDP Neighbors' }] }, { id: 'adm', label: 'Administration', pages: [{ id: 'run', label: 'Running Config' }] }];
  return shell({ key: 'sw' + d.name, cls: 'ios', layout: 'left', brand: d.hostname, sub: 'Catalyst-style Switch Web UI (simulated)', nav, right: () => [btn('💾 Save config', () => { cliOut(d, 'write memory'); A().notice('Configuration saved.'); })],
    page: (m, s) => {
      if (s === 'ov') return h('div', {}, tiles([['Ports', ports.length], ['Connected', ports.filter(k => d.ifs[k].up && S.segment(L(), d.name, k).eps.length).length], ['VLANs', vl.length], ['802.1X ports', ports.filter(k => d.ifs[k].auth === 'auto').length]]), panel('Ports', tbl(['Port', 'Status', 'Mode', 'VLAN', '802.1X'], ports.map(k => { const x = d.ifs[k], c = !!S.segment(L(), d.name, k).eps.length; return h('tr', {}, h('td', {}, k), h('td', { class: !x.up ? 'dn' : c ? 'up' : '' }, !x.up ? 'disabled' : c ? 'connected' : 'notconnect'), h('td', {}, x.mode), h('td', {}, x.vlan), h('td', {}, x.auth === 'auto' ? (x.state || 'unauth') : 'open')); }))));
      if (s === 'ports') { const f = { p: sel(ports), m: sel(['access', 'trunk']), v: sel(vl), en: chk(true), dx: chk(false) };
        return h('div', {}, panel('Switch Ports', tbl(['Port', 'Mode', 'VLAN', 'Admin', '802.1X'], ports.map(k => { const x = d.ifs[k]; return h('tr', {}, h('td', {}, k), h('td', {}, x.mode), h('td', {}, x.vlan), h('td', { class: x.up ? 'up' : 'dn' }, x.up ? 'up' : 'shutdown'), h('td', {}, x.auth === 'auto' ? 'port-control auto' : 'open')); }))), panel('Edit port', row(f.p, f.m, 'VLAN', f.v, h('label', {}, f.en, ' enabled'), h('label', {}, f.dx, ' 802.1X (port-control auto)'), btn('Apply', () => P(['interface ' + f.p.value, 'switchport mode ' + f.m.value].concat(f.m.value === 'access' ? ['switchport access vlan ' + f.v.value] : [], [f.en.checked ? 'no shutdown' : 'shutdown', f.dx.checked ? 'authentication port-control auto' : 'no authentication port-control auto'])), 'pri')))); }
      if (s === 'vlan') { const f = { id: inp('20', 'VLAN id', '60px'), n: inp('SERVERS', 'name', '120px') };
        return h('div', {}, panel('VLANs', tbl(['VLAN', 'Name', 'Ports', ''], vl.map(v => h('tr', {}, h('td', {}, v), h('td', {}, d.vlans[v]), h('td', {}, ports.filter(k => String(d.ifs[k].vlan) === String(v) && d.ifs[k].mode === 'access').join(', ')), h('td', {}, +v === 1 ? '' : btn('Delete', () => P(['no vlan ' + v]), 'del')))))), panel('Add VLAN', row(f.id, f.n, btn('Add', () => P(['vlan ' + f.id.value, 'name ' + f.n.value]), 'pri')))); }
      if (s === 'dot') { const f = { aaa: chk(d.aaa), dx: chk(d.dot1xGlobal), ip: inp(d.radius && d.radius.ip || '192.168.100.14', 'RADIUS server IP', '130px'), key: inp(d.radius && d.radius.key || '', 'shared secret', '120px') };
        return h('div', {}, panel('Global 802.1X / RADIUS', row(h('label', {}, f.aaa, ' aaa new-model'), h('label', {}, f.dx, ' dot1x system-auth-control')), row('RADIUS server', f.ip, 'shared secret', f.key, btn('Apply', () => P([f.aaa.checked ? 'aaa new-model' : 'no aaa new-model', 'aaa authentication dot1x default group radius', f.dx.checked ? 'dot1x system-auth-control' : 'no dot1x system-auth-control', 'radius server ISE', 'address ipv4 ' + f.ip.value + ' auth-port 1812 acct-port 1813', 'key ' + f.key.value]), 'pri')), note('Per-port 802.1X is set under Switch Ports. The shared secret must match ISE > Network Devices.')),
          panel('802.1X sessions', tbl(['Port', 'State', 'User', 'Profile'], ports.filter(k => d.ifs[k].auth === 'auto').map(k => h('tr', {}, h('td', {}, k), h('td', { class: d.ifs[k].state === 'authorized' ? 'up' : 'dn' }, d.ifs[k].state || 'unauth'), h('td', {}, d.ifs[k].user || ''), h('td', {}, d.ifs[k].profile || '')))))); }
      if (s === 'mac') return panel('MAC Address Table', pre(cliOut(d, 'show mac address-table')));
      if (s === 'cdp') return panel('CDP Neighbors', pre(cliOut(d, 'show cdp neighbors')));
      return panel('Running Configuration', pre(cliOut(d, 'show running-config')));
    } });
}
root.GUI = { asdm, fmc, ise, esa, wsa, iosRouter, iosSwitch };
})(window);
