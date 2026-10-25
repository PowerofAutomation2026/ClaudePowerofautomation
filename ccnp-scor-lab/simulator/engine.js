// SCOR Lab Simulator - network + stateful firewall engine (no DOM; runs in browser and node)
(function (root) {
'use strict';
const ip2n = s => s.split('.').reduce((a, b) => a * 256 + (+b), 0) >>> 0;
const n2ip = n => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.');
const lenMask = l => l === 0 ? 0 : (0xFFFFFFFF << (32 - l)) >>> 0;
const inNet = (ip, net, len) => ((ip2n(ip) & lenMask(len)) >>> 0) === ((ip2n(net) & lenMask(len)) >>> 0);
const maskToLen = m => ip2n(m).toString(2).split('').filter(x => x === '1').length;
const wildToLen = w => 32 - ip2n(w).toString(2).split('').filter(x => x === '1').length;
const lenToMask = l => n2ip(lenMask(l));
const isIp = s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every(x => +x < 256);
const PORTS = { www: 80, http: 80, https: 443, ssh: 22, telnet: 23, domain: 53, smtp: 25, ftp: 21, pop3: 110, snmp: 161, ntp: 123 };
const portNum = t => PORTS[t] !== undefined ? PORTS[t] : parseInt(t, 10);
const clone = o => JSON.parse(JSON.stringify(o));

// ---------- lab model ----------
function mk(type, name, label, x, y) { return { type, name, label, x, y, ifs: {}, routes: [], acls: {}, hostname: label }; }
function addIf(d, name, ip, len, extra) { d.ifs[name] = Object.assign({ name, ip: ip || null, len: len || 24, up: true }, extra || {}); }
function newLab() {
  const L = { dev: {}, links: [], conns: [], ver: 6 };
  const D = (t, n, label, x, y) => (L.dev[n] = mk(t, n, label, x, y));
  const host = (n, label, x, y, ip, len, gw, listen) => { const d = D('host', n, label, x, y); addIf(d, 'eth0', ip, len); d.gw = gw; d.listen = listen; return d; };
  host('Outside', 'Outside-Desktop', 70, 120, '198.51.100.10', 24, '198.51.100.1', { tcp: [22, 80, 443], udp: [], page: 'Outside web server (198.51.100.10)' });
  const r2 = D('router', 'R2', 'R2', 250, 120);
  addIf(r2, 'Gi0/1', '203.0.113.2', 24); addIf(r2, 'Gi0/2', '198.51.100.1', 24); addIf(r2, 'Gi0/3', '192.0.2.2', 24);
  r2.routes.push({ net: '10.2.1.0', len: 24, nh: '192.0.2.1' });
  r2.routes.push({ net: '172.16.1.0', len: 24, nh: '203.0.113.1' });
  const fw = D('asa', 'FW1', 'FW1-ASA', 450, 120); fw.objects = {}; fw.objectGroups = {}; fw.syslog = []; fw.inspect = { icmp: true, http: true, dns: true, ftp: true, tftp: false, sip: false, esmtp: true }; fw.sameSec = false; fw.intraSec = false; fw.nats = []; fw.conns = []; fw.xlates = [];
  addIf(fw, 'Gi0/0', '203.0.113.1', 24, { nameif: 'outside', sec: 0 });
  addIf(fw, 'Gi0/1', '10.1.1.1', 24, { nameif: 'inside', sec: 100 });
  addIf(fw, 'Gi0/2', '172.16.1.1', 24, { nameif: 'dmz', sec: 50 });
  fw.routes.push({ net: '0.0.0.0', len: 0, nh: '203.0.113.2', nameif: 'outside' }, { net: '10.1.10.0', len: 24, nh: '10.1.1.2', nameif: 'inside' });
  fw.objects['INSIDE-NETS'] = { kind: 'subnet', ip: '10.1.0.0', len: 16 };
  fw.nats.push({ kind: 'dynamic', obj: 'INSIDE-NETS', realIf: 'inside', mappedIf: 'outside', mapped: 'interface' });
  const r1 = D('router', 'R1', 'R1', 650, 120);
  addIf(r1, 'Gi0/1', '10.1.1.2', 24); addIf(r1, 'Gi0/2', '10.1.10.1', 24); r1.routes.push({ net: '0.0.0.0', len: 0, nh: '10.1.1.1' });
  const sw = D('switch', 'SW1', 'SW1', 790, 120); sw.vlans = { 1: 'default', 10: 'USERS' };
  addIf(sw, 'Gi0/1', null, 24, { mode: 'access', vlan: 10 }); addIf(sw, 'Gi0/2', null, 24, { mode: 'access', vlan: 10 }); addIf(sw, 'Gi0/3', null, 24, { mode: 'access', vlan: 1 });
  host('Client', 'Client (inside PC)', 920, 120, '10.1.10.10', 24, '10.1.10.1', { tcp: [22], udp: [], page: 'Client PC' });
  const dsw = D('switch', 'DMZ-SW', 'DMZ-SW', 450, 235); dsw.vlans = { 1: 'default' }; ['Gi0/1', 'Gi0/2', 'Gi0/3', 'Gi0/4'].forEach(p => addIf(dsw, p, null, 24, { mode: 'access', vlan: 1 }));
  const wsa = host('WSA1', 'WSA1 (web proxy)', 455, 455, '172.16.1.30', 24, '172.16.1.1', { tcp: [3128, 443], udp: [], page: 'Secure Web Appliance (explicit proxy on tcp/3128)' }); wsa.role = 'wsa'; wsa.hostname = 'wsa1.lab.local';
  host('DMZ', 'DMZ-Server', 370, 345, '172.16.1.10', 24, '172.16.1.1', { tcp: [22, 80], udp: [], page: 'DMZ web server (172.16.1.10) - welcome!' });
  const esa = host('ESA1', 'ESA1 (email gw)', 540, 345, '172.16.1.20', 24, '172.16.1.1', { tcp: [25, 443], udp: [], page: 'ESA mail gateway (SMTP on tcp/25, GUI on tcp/443)' }); esa.role = 'esa'; esa.hostname = 'esa1.lab.local';
  const msw = D('switch', 'MGMT-SW', 'MGMT-SW', 780, 235); msw.vlans = { 1: 'default' }; ['Gi0/1', 'Gi0/2', 'Gi0/3'].forEach(p => addIf(msw, p, null, 24, { mode: 'access', vlan: 1 }));
  const fmc = host('FMC1', 'FMC1', 690, 345, '192.168.100.13', 24, '192.168.100.1', { tcp: [22, 443], udp: [], page: 'Firewall Management Center' }); fmc.role = 'fmc'; fmc.hostname = 'fmc1';
  const ise = host('ISE1', 'ISE1', 850, 345, '192.168.100.14', 24, '192.168.100.1', { tcp: [22, 443], udp: [], page: 'Identity Services Engine' }); ise.role = 'ise'; ise.hostname = 'ise1';
  const ft = D('ftd', 'FTD1', 'FTD1', 250, 290); ft.conns = []; ft.xlates = []; ft.events = [];
  addIf(ft, 'Gi0/0', '192.0.2.1', 24, { zone: 'OUT', nameif: 'outside' }); addIf(ft, 'Gi0/1', '10.2.1.1', 24, { zone: 'IN', nameif: 'inside' });
  ft.routes.push({ net: '0.0.0.0', len: 0, nh: '192.0.2.2' });
  ft.zones = ['IN', 'OUT'];
  ft.objects = { 'Inside-Net': { kind: 'network', value: '10.2.1.0/24' }, 'Web-Server': { kind: 'host', value: '10.2.1.10' } };
  ft.portObjs = { HTTP: { proto: 'tcp', from: 80, to: 80 }, HTTPS: { proto: 'tcp', from: 443, to: 443 }, SSH: { proto: 'tcp', from: 22, to: 22 }, Telnet: { proto: 'tcp', from: 23, to: 23 }, FTP: { proto: 'tcp', from: 21, to: 21 }, SMTP: { proto: 'tcp', from: 25, to: 25 }, DNS_over_UDP: { proto: 'udp', from: 53, to: 53 }, ICMP: { proto: 'icmp', from: 0, to: 0 } };
  ft.policy = { name: 'Initial_Access_Policy', defaultAction: 'block', rules: [{ id: 1, name: 'Allow-IN-OUT', enabled: true, action: 'allow', srcZones: ['IN'], dstZones: ['OUT'], srcNets: [], dstNets: [], ports: [], apps: [], urlCats: [], ips: '', file: '', log: { begin: false, end: true }, comment: 'Inside users to the Internet', hits: 0 }], nextId: 2 };
  ft.nat = [{ id: 1, type: 'dynamic', srcZone: 'IN', dstZone: 'OUT', orig: 'any', trans: 'interface' }]; ft.dirty = false; ft.intrusion = []; ft.fileEvents = []; ft.deploys = [{ t: '00:00:00', by: 'admin', items: ['Initial deployment'] }];
  host('FTDClient', 'FTD-Client', 250, 450, '10.2.1.10', 24, '10.2.1.1', { tcp: [22, 80], udp: [], page: 'FTD-Client internal web server (10.2.1.10)' });
  L.ise = { allowDot1x: true, allowMab: true, authn: { dot1x: 'Internal Users', mab: 'Internal Endpoints' }, devices: [],
    users: [{ name: 'alice', pass: 'Cisco123!', group: 'Employees', enabled: true }, { name: 'carl', pass: 'Cisco123!', group: 'Contractors', enabled: true }], endpoints: [{ mac: 'aabb.cc00.0001', group: 'Printers' }],
    profiles: { PermitAccess: { access: 'accept', vlan: 10, dacl: '' }, 'Contractor-Web': { access: 'accept', vlan: 10, dacl: 'permit tcp any any eq 80' }, Quarantine: { access: 'accept', vlan: 99, quarantine: true, dacl: '' }, DenyAccess: { access: 'reject' } },
    authz: [{ name: 'Employees', group: 'Employees', method: 'any', profile: 'PermitAccess' }, { name: 'Contractors', group: 'Contractors', method: 'any', profile: 'PermitAccess' }, { name: 'Printers-MAB', group: 'Printers', method: 'mab', profile: 'PermitAccess' }], logs: [] };
  L.wsa = { policies: [], decryptCats: { 'Social Networking': 'decrypt', Gambling: 'decrypt', Business: 'decrypt', News: 'decrypt', 'Streaming Media': 'decrypt', 'Malware Sites': 'decrypt', 'File Downloads': 'decrypt', Uncategorized: 'decrypt' }, policy: { 'Social Networking': 'allow', Gambling: 'allow', 'Malware Sites': 'block', Business: 'allow', News: 'allow', 'Streaming Media': 'monitor', 'File Downloads': 'allow', Uncategorized: 'monitor' }, allowlist: [], blocklist: [], av: true, decrypt: false, log: [], counters: { total: 0, allowed: 0, blocked: 0, malware: 0 } };
  L.esa = { domains: ['lab.local'], hat: [{ name: 'BLOCKLIST', policy: 'block', ips: [] }, { name: 'ALLOWLIST', policy: 'allow', ips: [] }], dmarc: { on: false }, spfAction: 'tag', antispam: { on: true, threshold: 50, action: 'quarantine' }, antivirus: true, dlp: false, filters: [],
    dns: { 'partner.com': { spf: ['198.51.100.10'], dkim: true, dmarc: 'reject' }, 'example.org': { spf: ['198.51.100.99'], dkim: false, dmarc: 'reject' }, 'lab.local': { spf: ['203.0.113.1'], dkim: true, dmarc: 'none' } }, tracking: [], quarantine: [], mailboxes: {}, counters: { accepted: 0, spam: 0, virus: 0, blocked: 0, dlp: 0 } };
  ft.draft = clone({ ifs: ft.ifs, routes: ft.routes, policy: ft.policy, nat: ft.nat, objects: ft.objects, portObjs: ft.portObjs, zones: ft.zones });
  L.links = [['Outside:eth0', 'R2:Gi0/2'], ['R2:Gi0/1', 'FW1:Gi0/0'], ['FW1:Gi0/1', 'R1:Gi0/1'], ['FW1:Gi0/2', 'DMZ-SW:Gi0/1'], ['DMZ-SW:Gi0/2', 'DMZ:eth0'], ['DMZ-SW:Gi0/3', 'ESA1:eth0'], ['DMZ-SW:Gi0/4', 'WSA1:eth0'], ['SW1:Gi0/3', 'MGMT-SW:Gi0/1'], ['MGMT-SW:Gi0/2', 'FMC1:eth0'], ['MGMT-SW:Gi0/3', 'ISE1:eth0'], ['R1:Gi0/2', 'SW1:Gi0/1'],
    ['SW1:Gi0/2', 'Client:eth0'], ['R2:Gi0/3', 'FTD1:Gi0/0'], ['FTD1:Gi0/1', 'FTDClient:eth0']];
  return L;
}

// ---------- topology helpers ----------
function farEnd(L, port) { for (const [a, b] of L.links) { if (a === port) return b; if (b === port) return a; } return null; }
function segment(L, d, i) {
  const out = [], sw = [], vis = new Set([d + ':' + i]);
  (function walk(port, vlan) {
    const f = farEnd(L, port); if (!f || vis.has(f)) return; vis.add(f);
    const [fd, fi] = f.split(':'), fdev = L.dev[fd];
    if (fdev.type === 'switch') {
      if (fdev.on === false) return; const ing = fdev.ifs[fi];
      if (ing && ing.up === false) return;                                   // shutdown / err-disabled port
      if (ing && ing.ps && ing.ps.on && ing.ps.viol === 'protect' && ing.ps.over) return;
      const trunkIn = ing && ing.mode === 'trunk'; if (vlan !== null && !trunkIn && ing && (ing.vlan || 1) !== vlan) return;   // access VLAN mismatch
      const v = vlan !== null ? vlan : (trunkIn || !ing ? null : (ing.vlan || 1));
      sw.push(fd);
      for (const [a, b] of L.links) for (const e2 of [a, b]) { if (e2.split(':')[0] !== fd || vis.has(e2)) continue; const eif = fdev.ifs[e2.split(':')[1]];
        if (eif && eif.up === false) continue; if (eif && eif.mode !== 'trunk' && v !== null && (eif.vlan || 1) !== v) continue; vis.add(e2); walk(e2, v); }
    } else out.push({ dev: fd, if: fi });
  })(d + ':' + i, null);
  return { eps: out, sw };
}
function arp(L, dn, ifn, ip) {
  const s = segment(L, dn, ifn);
  for (const ep of s.eps) { if (L.dev[ep.dev].on === false) continue; if (L.dev[ep.dev].type === 'host' && nacBlocked(L, ep.dev)) continue; const x = L.dev[ep.dev].ifs[ep.if]; if (x && x.up && x.ip === ip) return { dev: ep.dev, if: ep.if, sw: s.sw }; }
  for (const ep of s.eps) { const fd = L.dev[ep.dev]; if (fd.type !== 'asa' || fd.on === false) continue;   // proxy-ARP for static-NAT mapped addresses
    for (const n of fd.nats) if (n.kind === 'static' && n.mapped === ip && fd.ifs[ep.if].nameif === n.mappedIf) return { dev: ep.dev, if: ep.if, sw: s.sw }; }
  for (const ep of s.eps) { const fd = L.dev[ep.dev]; if (fd.type !== 'ftd' || fd.on === false) continue;
    for (const n of fd.nat) if (n.type === 'static' && n.trans === ip && fd.ifs[ep.if].zone === n.dstZone) return { dev: ep.dev, if: ep.if, sw: s.sw }; }
  return null;
}
function ifByNameif(d, n) { for (const k in d.ifs) if (d.ifs[k].nameif === n) return d.ifs[k]; return null; }
function routeLookup(d, dst) {
  let best = null;
  for (const k in d.ifs) { const x = d.ifs[k]; if (x.up && x.ip && inNet(dst, x.ip, x.len)) { if (!best || x.len > best.len) best = { len: x.len, if: k, nh: null, kind: 'C' }; } }
  for (const r of d.routes) {
    if (!inNet(dst, r.net, r.len)) continue;
    let oif = null;
    if (r.nameif) { const x = ifByNameif(d, r.nameif); if (x) oif = x.name; }
    else for (const k in d.ifs) { const x = d.ifs[k]; if (x.up && x.ip && inNet(r.nh, x.ip, x.len)) oif = k; }
    if (oif && (!best || r.len > best.len)) best = { len: r.len, if: oif, nh: r.nh, kind: 'S' };
  }
  if (d.type === 'host' && d.gw && !best) { for (const k in d.ifs) { const x = d.ifs[k]; if (x.up && x.ip && inNet(d.gw, x.ip, x.len)) return { len: 0, if: k, nh: d.gw, kind: 'G' }; } }
  return best;
}
const ownsIp = (d, ip) => { for (const k in d.ifs) if (d.ifs[k].up && d.ifs[k].ip === ip) return k; return null; };

// ---------- ACLs ----------
function matchAddr(d, m, ip) {
  if (!m || m.t === 'any') return true;
  if (m.t === 'host') return m.ip === ip;
  if (m.t === 'net') return inNet(ip, m.ip, m.len);
  if (m.t === 'obj') { const o = d.objects && d.objects[m.name]; if (!o) return false; return o.kind === 'host' ? o.ip === ip : inNet(ip, o.ip, o.len); }
  if (m.t === 'og') { const g = d.objectGroups && d.objectGroups[m.name]; if (!g) return false; return g.members.some(x => x.kind === 'host' ? x.ip === ip : x.kind === 'subnet' ? inNet(ip, x.ip, x.len) : x.kind === 'object' ? matchAddr(d, { t: 'obj', name: x.name }, ip) : x.kind === 'group' ? matchAddr(d, { t: 'og', name: x.name }, ip) : false); }
  return false;
}
function matchPort(p, v) { if (!p) return true; if (p.op === 'eq') return v === p.p; if (p.op === 'neq') return v !== p.p; if (p.op === 'gt') return v > p.p; if (p.op === 'lt') return v < p.p; if (p.op === 'range') return v >= p.p && v <= p.p2; return true; }
function evalAcl(d, name, pkt) {
  const es = d.acls[name]; if (!es) return null;
  for (let i = 0; i < es.length; i++) {
    const e = es[i];
    if (e.proto !== 'ip' && e.proto !== pkt.proto) continue;
    if (!matchAddr(d, e.src, pkt.src) || !matchAddr(d, e.dst, pkt.dst)) continue;
    if ((pkt.proto === 'tcp' || pkt.proto === 'udp') && (!matchPort(e.sport, pkt.sport) || !matchPort(e.dport, pkt.dport))) continue;
    if (pkt.proto === 'icmp' && e.icmpType && e.icmpType !== 'any' && e.icmpType !== pkt.type && !(e.icmpType === 'echo' && pkt.type === 'echo')) continue;
    e.hits = (e.hits || 0) + 1; return { action: e.action, idx: i + 1, entry: e };
  }
  return { action: 'deny', implicit: true };
}
function parseAclTokens(tok, style) {
  let i = 0; const e = { proto: tok[i++] };
  if (!['ip', 'tcp', 'udp', 'icmp'].includes(e.proto)) throw new Error('% Invalid protocol: ' + e.proto);
  const addr = () => {
    const t = tok[i++];
    if (t === 'any' || t === 'any4') return { t: 'any' };
    if (t === 'host') { if (!isIp(tok[i])) throw new Error('% Invalid host'); return { t: 'host', ip: tok[i++] }; }
    if (t === 'object') return { t: 'obj', name: tok[i++] };
    if (t === 'object-group') return { t: 'og', name: tok[i++] };
    if (!isIp(t) || !isIp(tok[i])) throw new Error('% Invalid address/mask near "' + (t || '') + '"');
    const m = tok[i++]; return { t: 'net', ip: t, len: style === 'ios' ? wildToLen(m) : maskToLen(m) };
  };
  const port = () => { const t = tok[i]; if (['eq', 'gt', 'lt', 'neq'].includes(t)) { i++; return { op: t, p: portNum(tok[i++]) }; } if (t === 'range') { i++; const a = portNum(tok[i++]), b = portNum(tok[i++]); return { op: 'range', p: a, p2: b }; } return null; };
  e.src = addr(); if (e.proto === 'tcp' || e.proto === 'udp') e.sport = port();
  e.dst = addr(); if (e.proto === 'tcp' || e.proto === 'udp') e.dport = port(); else if (e.proto === 'icmp' && tok[i] && tok[i] !== 'log') e.icmpType = tok[i++];
  return e;
}
const fmtAddr = (a, style) => !a || a.t === 'any' ? 'any' : a.t === 'host' ? 'host ' + a.ip : a.t === 'obj' ? 'object ' + a.name : a.t === 'og' ? 'object-group ' + a.name : a.ip + ' ' + (style === 'ios' ? n2ip((~lenMask(a.len)) >>> 0) : lenToMask(a.len));
const fmtPort = p => !p ? '' : ' ' + (p.op === 'range' ? 'range ' + p.p + ' ' + p.p2 : p.op + ' ' + p.p);
function aclText(e, style) { return e.action + ' ' + e.proto + ' ' + fmtAddr(e.src, style) + fmtPort(e.sport) + ' ' + fmtAddr(e.dst, style) + fmtPort(e.dport) + (e.icmpType ? ' ' + e.icmpType : ''); }

// ---------- packet processing ----------
const T = (ctx, dev, t, kind) => ctx.trace.push({ dev, t, kind: kind || 'info' });
const pstr = p => (p.proto === 'icmp' ? 'ICMP ' + (p.type || 'echo') + ' ' + p.src + ' > ' + p.dst : p.proto.toUpperCase() + ' ' + p.src + ':' + p.sport + ' > ' + p.dst + ':' + p.dport);
function pushPath(ctx, n) { if (ctx.path[ctx.path.length - 1] !== n) ctx.path.push(n); }

function forward(ctx, d, r, pkt, depth) {
  const x = d.ifs[r.if];
  if (!x.up) return { st: 'drop', dev: d.name, why: 'egress interface ' + r.if + ' is down', kind: 'unreach' };
  const nh = r.nh || pkt.dst;
  const ep = arp(ctx.L, d.name, r.if, nh);
  if (!ep) { T(ctx, d.name, 'ARP for ' + nh + ' on ' + r.if + ': no reply', 'drop'); return { st: 'drop', dev: d.name, why: 'host unreachable (ARP failed for ' + nh + ')', kind: 'unreach' }; }
  ep.sw.forEach(s => pushPath(ctx, s));
  T(ctx, d.name, 'out ' + r.if + (x.nameif ? ' (' + x.nameif + ')' : '') + ' -> next hop ' + nh);
  return process(ctx, ep.dev, ep.if, pkt, depth + 1);
}
function process(ctx, dn, inIf, pkt, depth) {
  if (depth > 40) return { st: 'drop', dev: dn, why: 'routing loop', kind: 'ttl' };
  const d = ctx.L.dev[dn]; pushPath(ctx, dn);
  if (d.type === 'host') {
    if (ownsIp(d, pkt.dst)) { T(ctx, dn, 'received ' + pstr(pkt), 'ok'); return { st: 'delivered', dev: dn, pkt }; }
    return { st: 'drop', dev: dn, why: 'not addressed to this host', kind: 'drop' };
  }
  if (d.type === 'router') return routerRx(ctx, d, inIf, pkt, depth);
  return fwRx(ctx, d, inIf, pkt, depth);
}
function routerRx(ctx, d, inIf, pkt, depth) {
  const inI = d.ifs[inIf];
  if (!inI.up) return { st: 'drop', dev: d.name, why: 'ingress interface down', kind: 'drop' };
  if (inI.aclIn) { const r = evalAcl(d, inI.aclIn, pkt);
    if (r) { if (r.action === 'deny') { T(ctx, d.name, 'ACL ' + inI.aclIn + ' (in ' + inIf + ') ' + (r.implicit ? 'implicit deny' : 'line ' + r.idx + ' DENY'), 'drop'); return { st: 'drop', dev: d.name, why: 'denied by ACL ' + inI.aclIn + (r.implicit ? ' (implicit deny)' : ' line ' + r.idx), kind: 'prohibited' }; }
      T(ctx, d.name, 'ACL ' + inI.aclIn + ' (in) line ' + r.idx + ' permit', 'ok'); } }
  if (ownsIp(d, pkt.dst)) { T(ctx, d.name, 'destined to this router: ' + pstr(pkt), 'ok'); return { st: 'delivered', dev: d.name, pkt }; }
  pkt = Object.assign({}, pkt, { ttl: pkt.ttl - 1 });
  if (pkt.ttl <= 0) { T(ctx, d.name, 'TTL expired', 'drop'); return { st: 'drop', dev: d.name, why: 'TTL expired in transit', kind: 'ttl', hopIp: inI.ip }; }
  const r = routeLookup(d, pkt.dst);
  if (!r) { T(ctx, d.name, 'no route to ' + pkt.dst, 'drop'); return { st: 'drop', dev: d.name, why: 'no route to ' + pkt.dst, kind: 'noroute' }; }
  T(ctx, d.name, 'route ' + (r.kind === 'C' ? 'connected' : 'static') + ' -> ' + r.if + (r.nh ? ' via ' + r.nh : ''));
  const o = d.ifs[r.if];
  if (o.aclOut) { const a = evalAcl(d, o.aclOut, pkt);
    if (a) { if (a.action === 'deny') { T(ctx, d.name, 'ACL ' + o.aclOut + ' (out ' + r.if + ') DENY', 'drop'); return { st: 'drop', dev: d.name, why: 'denied by ACL ' + o.aclOut + ' (out)', kind: 'prohibited' }; } } }
  return forward(ctx, d, r, pkt, depth);
}

// ----- firewalls (ASA + FTD share conn table logic) -----
function findFwd(d, inIf, p) { return d.conns.find(c => c.proto === p.proto && c.in.if === inIf && c.in.src === p.src && c.in.sport === p.sport && c.in.dst === p.dst && c.in.dport === p.dport); }
function findRev(d, inIf, p) { return d.conns.find(c => c.proto === p.proto && c.out.if === inIf && c.out.dst === p.src && c.out.dport === p.sport && c.out.src === p.dst && c.out.sport === p.dport); }
function fwRx(ctx, d, inIf, pkt, depth) {
  const inI = d.ifs[inIf], inName = inI.nameif || inIf;
  if (!inI.up || !inI.ip) return { st: 'drop', dev: d.name, why: 'ingress interface ' + inIf + ' down/unconfigured', kind: 'drop', silent: true };
  const rev = findRev(d, inIf, pkt);
  if (rev && pkt.proto === 'icmp' && d.type === 'asa' && d.inspect && d.inspect.icmp === false) { T(ctx, d.name, 'ICMP return traffic denied: "inspect icmp" is not enabled in the global policy', 'drop'); sysl(d, 4, '313004', 'Denied ICMP type=0, from ' + pkt.src + ' on interface ' + (inI.nameif || inIf) + ' to ' + pkt.dst + ': no matching session'); return { st: 'drop', dev: d.name, why: 'ICMP echo-reply without matching session (inspect icmp disabled)', kind: 'drop', silent: true }; }
  if (rev) { rev.hits++; T(ctx, d.name, 'return traffic matches connection #' + rev.id + ' (stateful) - allowed', 'ok');
    const np = Object.assign({}, pkt, { src: rev.in.dst, sport: rev.in.dport, dst: rev.in.src, dport: rev.in.sport });
    const r = routeLookup(d, np.dst); if (!r) return { st: 'drop', dev: d.name, why: 'no route back to ' + np.dst, kind: 'noroute', silent: true };
    return forward(ctx, d, r, np, depth); }
  const fw0 = findFwd(d, inIf, pkt);
  if (fw0) { fw0.hits++; T(ctx, d.name, 'existing connection #' + fw0.id, 'ok');
    const np = Object.assign({}, pkt, { src: fw0.out.src, sport: fw0.out.sport, dst: fw0.out.dst, dport: fw0.out.dport }); const r = routeLookup(d, np.dst);
    return forward(ctx, d, r, np, depth); }
  const own = ownsIp(d, pkt.dst);
  if (own) { if (pkt.proto === 'icmp' && d.type === 'asa' && inI.sec === 0) { T(ctx, d.name, 'ICMP to own interface from lowest-security interface: dropped', 'drop'); return { st: 'drop', dev: d.name, why: 'ICMP to interface denied from outside', kind: 'drop', silent: true }; }
    T(ctx, d.name, 'destined to the firewall itself', 'ok'); return { st: 'delivered', dev: d.name, pkt }; }
  if (pkt.proto === 'icmp' && pkt.type === 'echo-reply') { T(ctx, d.name, 'no connection for ICMP echo-reply - dropped', 'drop'); return { st: 'drop', dev: d.name, why: 'no matching connection', kind: 'drop', silent: true }; }
  pkt = Object.assign({}, pkt, { ttl: d.type === 'asa' ? pkt.ttl : pkt.ttl - 1 });
  return d.type === 'asa' ? asaNew(ctx, d, inIf, inI, inName, pkt, depth) : ftdNew(ctx, d, inIf, inI, inName, pkt, depth);
}
function addConn(ctx, d, proto, inn, out) {
  const id = (d.connSeq = (d.connSeq || 0) + 1);
  const c = { id, proto, in: inn, out, hits: 1, t: ctx.now }; d.conns.push(c);
  if (inn.src !== out.src || inn.dst !== out.dst) d.xlates.push({ id, proto, real: inn.src + ':' + inn.sport, mapped: out.src + ':' + out.sport, realDst: inn.dst, mappedDst: out.dst });
  return c;
}
function sysl(d, sev, id, msg) { if (!d.syslog) return; d.syslog.unshift({ t: hhmm(), sev, id, msg }); d.syslog.length = Math.min(d.syslog.length, 120); }
function asaNew(ctx, d, inIf, inI, inName, pkt, depth) {
  let dstReal = pkt.dst, unat = null;
  for (const n of d.nats) if (n.kind === 'static' && pkt.dst === n.mapped && inName === n.mappedIf) { dstReal = n.real; unat = n; T(ctx, d.name, 'NAT: untranslate ' + n.mapped + ' -> ' + n.real + ' (static ' + n.obj + ')', 'ok'); break; }
  const r = routeLookup(d, dstReal);
  if (!r) { T(ctx, d.name, 'no route to ' + dstReal, 'drop'); return { st: 'drop', dev: d.name, why: 'no route to ' + dstReal, kind: 'noroute', silent: true }; }
  const out = d.ifs[r.if], outName = out.nameif;
  if (outName === inName && !d.intraSec) { T(ctx, d.name, 'No NAT/untranslate rule matched ' + pkt.dst + ': it routes back out the ingress interface (' + inName + ') - dropped', 'drop'); return { st: 'drop', dev: d.name, why: pkt.dst + ' is reachable only back out the ingress interface: no static NAT (untranslate) rule for it', kind: 'drop', silent: true }; }
  const chk = Object.assign({}, pkt, { dst: dstReal });
  if (inI.aclIn && d.acls[inI.aclIn]) {
    const a = evalAcl(d, inI.aclIn, chk);
    if (a.action === 'deny') { sysl(d, 4, '106023', 'Deny ' + pkt.proto + ' src ' + inName + ':' + pkt.src + (pkt.proto === 'icmp' ? '' : '/' + pkt.sport) + ' dst ' + outName + ':' + dstReal + (pkt.proto === 'icmp' ? '' : '/' + pkt.dport) + ' by access-group "' + inI.aclIn + '"'); T(ctx, d.name, '[' + inName + '] ACL ' + inI.aclIn + ': ' + (a.implicit ? 'implicit deny (no matching line)' : 'line ' + a.idx + ' DENY') + ' -> DROP', 'drop'); return { st: 'drop', dev: d.name, why: 'access-list ' + inI.aclIn + (a.implicit ? ' implicit deny' : ' line ' + a.idx + ' deny') + ' on ' + inName, kind: 'drop', silent: true }; }
    T(ctx, d.name, '[' + inName + '] ACL ' + inI.aclIn + ' line ' + a.idx + ' permit', 'ok');
  } else if (inI.sec > out.sec || (inI.sec === out.sec && d.sameSec)) T(ctx, d.name, 'security-level ' + inI.sec + ' (' + inName + ') > ' + out.sec + ' (' + outName + '): allowed by default', 'ok');
  else { T(ctx, d.name, 'no ACL on ' + inName + ' and security-level ' + inI.sec + ' <= ' + out.sec + ': implicit deny', 'drop'); return { st: 'drop', dev: d.name, why: 'implicit deny: ' + inName + '(' + inI.sec + ') -> ' + outName + '(' + out.sec + ') with no access-list', kind: 'drop', silent: true }; }
  let ns = pkt.src, how = null;
  for (const n of d.nats) {
    if (n.realIf !== inName || n.mappedIf !== outName) continue;
    if (n.kind === 'static' && n.real === pkt.src) { ns = n.mapped; how = 'static ' + n.obj; break; }
    if (n.kind === 'dynamic') { const o = d.objects[n.obj]; if (o && matchAddr(d, { t: 'obj', name: n.obj }, pkt.src)) { ns = n.mapped === 'interface' ? out.ip : n.mapped; how = 'dynamic PAT ' + n.obj; break; } }
  }
  if (how) T(ctx, d.name, 'NAT: ' + pkt.src + ' -> ' + ns + ' (' + how + ')', 'ok');
  const c = addConn(ctx, d, pkt.proto, { if: inIf, src: pkt.src, sport: pkt.sport, dst: pkt.dst, dport: pkt.dport }, { if: r.if, src: ns, sport: pkt.sport, dst: dstReal, dport: pkt.dport });
  sysl(d, 6, '302013', 'Built ' + (c.proto === 'icmp' ? 'ICMP' : c.proto.toUpperCase()) + ' connection ' + c.id + ' for ' + inName + ':' + pkt.src + (c.proto === 'icmp' ? '' : '/' + pkt.sport) + ' (' + ns + ') to ' + outName + ':' + dstReal + (c.proto === 'icmp' ? '' : '/' + pkt.dport));
  T(ctx, d.name, 'connection #' + c.id + ' built ' + inName + ' -> ' + outName, 'ok');
  return forward(ctx, d, r, Object.assign({}, pkt, { src: ns, dst: dstReal }), depth);
}
function inCidr(ip, s) { if (!s || s === 'any') return true; const [n, l] = s.split('/'); return inNet(ip, n, l === undefined ? 32 : +l); }
const IPS_POLICIES = { 'Connectivity Over Security': ['sqlmap', 'metasploit'], 'Balanced Security and Connectivity': ['sqlmap', 'metasploit', 'nikto', 'union select'], 'Security Over Connectivity': ['sqlmap', 'metasploit', 'nikto', 'union select', 'masscan', '../../etc/passwd', '<script>'], 'Maximum Detection': ['sqlmap', 'metasploit', 'nikto', 'union select', 'masscan', '../../etc/passwd', '<script>', 'nmap-scan'] };
const SIGINFO = { sqlmap: ['SERVER-WEBAPP sqlmap SQL injection tool', 1], metasploit: ['EXPLOIT-KIT Metasploit user-agent', 1], nikto: ['SERVER-WEBAPP Nikto scanner', 2], 'union select': ['SERVER-WEBAPP SQL injection attempt (UNION SELECT)', 1], masscan: ['POLICY-OTHER masscan scan', 2], '../../etc/passwd': ['SERVER-WEBAPP directory traversal /etc/passwd', 1], '<script>': ['SERVER-WEBAPP cross-site scripting attempt', 2], 'nmap-scan': ['PROTOCOL-SCAN nmap TCP port scan', 3] };
const FTD_APPS = ['HTTP', 'HTTPS', 'SSH', 'Telnet', 'FTP', 'SMTP', 'DNS', 'ICMP', 'Facebook', 'YouTube'];
const FTD_URLCATS = ['Social Networking', 'Gambling', 'Business', 'News', 'Streaming Media', 'Malware Sites', 'File Downloads', 'Uncategorized'];
function ftdApps(pkt) { const a = []; if (pkt.host && /facebook/.test(pkt.host)) a.push('Facebook'); if (pkt.host && /youtube/.test(pkt.host)) a.push('YouTube');
  if (pkt.proto === 'icmp') a.push('ICMP'); else { const m = { 80: 'HTTP', 443: 'HTTPS', 22: 'SSH', 23: 'Telnet', 21: 'FTP', 25: 'SMTP', 53: 'DNS', 8080: 'HTTP', 3128: 'HTTP' }; if (m[pkt.dport]) a.push(m[pkt.dport]); } return a; }
function ftdUrlCat(pkt) { if (!pkt.host) return null; const w = WEB[pkt.host]; return w ? w.cat : 'Uncategorized'; }
function ftdNet(d, spec, ip) { if (!spec || spec === 'any') return true; if (spec.startsWith('obj:')) { const o = d.objects[spec.slice(4)]; return o ? ftdNet(d, o.value, ip) : false; }
  if (spec.includes('-')) { const [a, b] = spec.split('-'); return ip2n(ip) >= ip2n(a) && ip2n(ip) <= ip2n(b); } if (spec.includes('/')) { const [n, l] = spec.split('/'); return inNet(ip, n, +l); } return ip === spec; }
function ftdRuleMatch(d, ru, pkt, zin, zout) {
  if (ru.enabled === false) return false;
  if (ru.srcZones.length && !ru.srcZones.includes(zin)) return false; if (ru.dstZones.length && !ru.dstZones.includes(zout)) return false;
  if (ru.srcNets.length && !ru.srcNets.some(n => ftdNet(d, n, pkt.src))) return false; if (ru.dstNets.length && !ru.dstNets.some(n => ftdNet(d, n, pkt.dst))) return false;
  if (ru.ports.length && !ru.ports.some(p => p.proto === 'any' || (p.proto === 'icmp' ? pkt.proto === 'icmp' : p.proto === pkt.proto && pkt.dport >= p.from && pkt.dport <= (p.to || p.from)))) return false;
  if (ru.apps.length && !ftdApps(pkt).some(a => ru.apps.includes(a))) return false;
  if (ru.urlCats.length) { const c = ftdUrlCat(pkt); if (!c || !ru.urlCats.includes(c)) return false; }
  return true;
}
function ftdNew(ctx, d, inIf, inI, inName, pkt, depth) {
  const zin = inI.zone; let dstReal = pkt.dst;
  for (const n of d.nat) if (n.type === 'static' && n.dstZone === zin && n.trans && pkt.dst === n.trans) { dstReal = n.orig; T(ctx, d.name, 'NAT: untranslate ' + n.trans + ' -> ' + n.orig + ' (static NAT rule ' + n.id + ')', 'ok'); break; }
  const r = routeLookup(d, dstReal);
  if (!r) { T(ctx, d.name, 'no route to ' + dstReal, 'drop'); return { st: 'drop', dev: d.name, why: 'no route to ' + dstReal, kind: 'noroute', silent: true }; }
  const out = d.ifs[r.if], zout = out.zone, chk = Object.assign({}, pkt, { dst: dstReal });
  const zl = (zin || 'no zone') + ' -> ' + (zout || 'no zone'); let rule = null;
  const ev = (a, why, ru, extra) => { const ent = Object.assign({ t: hhmm(), action: a, why: why || '', src: pkt.src, dst: dstReal, proto: pkt.proto, dport: pkt.dport, app: ftdApps(chk)[0] || '', host: pkt.host || '', cat: ftdUrlCat(chk) || '', rule: ru ? ru.name : 'Default Action', zones: zl }, extra || {}); d.events.unshift(ent); d.events.length = Math.min(d.events.length, 80); };
  for (const ru of d.policy.rules) { if (!ftdRuleMatch(d, ru, chk, zin, zout)) continue;
    if (ru.action === 'monitor') { ru.hits = (ru.hits || 0) + 1; ev('Monitor', 'monitor rule', ru); T(ctx, d.name, 'Access Control: rule "' + ru.name + '" MONITOR (logged, evaluation continues)', 'ok'); continue; } rule = ru; break; }
  const da = d.policy.defaultAction; let action, ipsName = '', fileName = '';
  if (rule) { action = rule.action; ipsName = rule.ips || ''; fileName = rule.file || ''; rule.hits = (rule.hits || 0) + 1; }
  else { d.policy.defHits = (d.policy.defHits || 0) + 1; action = da === 'block' ? 'block' : 'allow'; ipsName = da === 'ips-connectivity' ? 'Connectivity Over Security' : da === 'ips-balanced' ? 'Balanced Security and Connectivity' : da === 'ips-security' ? 'Security Over Connectivity' : ''; }
  const rn = rule ? 'rule "' + rule.name + '"' : 'Default Action';
  if (action === 'block' || action === 'reset') { T(ctx, d.name, 'Access Control Policy: ' + rn + ' ' + (action === 'reset' ? 'BLOCK with reset' : 'BLOCK') + ' [' + zl + ']', 'drop'); if (!rule || rule.log !== undefined) ev('Block', action === 'reset' ? 'Block with reset' : 'Block', rule);
    return { st: 'drop', dev: d.name, why: rn + ' blocked ' + zl, kind: 'drop', silent: true, reset: action === 'reset' && pkt.proto === 'tcp' }; }
  T(ctx, d.name, 'Access Control Policy: ' + rn + ' ' + action.toUpperCase() + ' [' + zl + ']', 'ok');
  if (action === 'allow') {
    if (ipsName && IPS_POLICIES[ipsName] && pkt.sig && IPS_POLICIES[ipsName].includes(pkt.sig)) { const si = SIGINFO[pkt.sig] || [pkt.sig, 2]; T(ctx, d.name, 'Intrusion Prevention (' + ipsName + '): "' + si[0] + '" - BLOCKED', 'drop'); d.intrusion.unshift({ t: hhmm(), sig: si[0], prio: si[1], src: pkt.src, dst: dstReal, rule: rn, policy: ipsName, action: 'Blocked' }); d.intrusion.length = Math.min(d.intrusion.length, 60); ev('Block', 'Intrusion: ' + si[0], rule); return { st: 'drop', dev: d.name, why: 'Intrusion policy "' + ipsName + '" blocked: ' + si[0], kind: 'drop', silent: true }; }
    if (fileName && pkt.file === 'eicar') { T(ctx, d.name, 'File Policy (' + fileName + '): malware EICAR-Test-File - BLOCKED', 'drop'); d.fileEvents.unshift({ t: hhmm(), file: 'eicar.com', disp: 'Malware (Block)', src: pkt.src, dst: dstReal, rule: rn }); ev('Block', 'File policy: malware', rule); return { st: 'drop', dev: d.name, why: 'File policy "' + fileName + '" blocked malware (EICAR)', kind: 'drop', silent: true }; }
    if (ipsName) T(ctx, d.name, 'Intrusion policy "' + ipsName + '": no signature matched', 'ok'); } else T(ctx, d.name, 'Trust: inspection skipped (no IPS / file policy)', 'ok');
  let ns = pkt.src;
  for (const n of d.nat) { if (n.srcZone !== zin || n.dstZone !== zout) continue;
    if (n.type === 'static' && pkt.src === n.orig) { ns = n.trans; T(ctx, d.name, 'NAT: ' + pkt.src + ' -> ' + ns + ' (static)', 'ok'); break; }
    if (n.type === 'dynamic' && ftdNet(d, n.orig || 'any', pkt.src)) { ns = n.trans === 'interface' ? out.ip : n.trans; T(ctx, d.name, 'NAT: PAT ' + pkt.src + ' -> ' + ns + ' (' + (n.trans === 'interface' ? 'interface' : 'pool') + ')', 'ok'); break; } }
  if (!rule || rule.log === undefined || (rule.log && (rule.log.end || rule.log.begin))) ev(action === 'trust' ? 'Trust' : 'Allow', '', rule);
  const c = addConn(ctx, d, pkt.proto, { if: inIf, src: pkt.src, sport: pkt.sport, dst: pkt.dst, dport: pkt.dport }, { if: r.if, src: ns, sport: pkt.sport, dst: dstReal, dport: pkt.dport });
  T(ctx, d.name, 'connection #' + c.id + ' built', 'ok');
  return forward(ctx, d, r, Object.assign({}, pkt, { src: ns, dst: dstReal }), depth);
}

// ---------- switch port-security ----------
function psCheck(L, sw, port) {
  const x = sw.ifs[port]; if (!x || !x.ps || !x.ps.on) return { violation: false };
  const known = farEnd(L, sw.name + ':' + port) ? 1 : 0, macs = known + (x.rogue || 0);
  if (macs <= (x.ps.max || 1)) { x.ps.over = false; return { violation: false }; }
  x.ps.count = (x.ps.count || 0) + 1; x.ps.over = true; const act = x.ps.viol || 'shutdown'; sw.logs = sw.logs || [];
  sw.logs.unshift({ t: hhmm(), msg: '%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address dead.beef.' + String(100 + (x.rogue || 0)) + ' on port ' + port + ' (action: ' + act + ')' });
  if (act === 'shutdown') { x.up = false; x.errdisable = true; sw.logs.unshift({ t: hhmm(), msg: '%PM-4-ERR_DISABLE: psecure-violation error detected on ' + port + ', putting ' + port + ' in err-disable state' }); }
  return { violation: true, action: act };
}
function addRogue(L, swn, port) { const x = L.dev[swn].ifs[port]; x.rogue = (x.rogue || 0) + 1; return psCheck(L, L.dev[swn], port); }
function removeRogue(L, swn, port) { const x = L.dev[swn].ifs[port]; x.rogue = 0; if (x.ps) x.ps.over = false; }
function portUp(L, swn, port, up) { const sw = L.dev[swn], x = sw.ifs[port]; x.up = up; if (up) { x.errdisable = false; psCheck(L, sw, port); } }
// ---------- 802.1X / ISE ----------
function portOf(L, hn) { const f = farEnd(L, hn + ':eth0'); if (!f) return null; const [sd, sp] = f.split(':'); const sw = L.dev[sd]; return sw && sw.type === 'switch' && sw.ifs[sp] ? { sw, port: sw.ifs[sp], name: sp } : null; }
function nacBlocked(L, hn) { const p = portOf(L, hn); return !!(p && p.port.auth === 'auto' && p.port.state !== 'authorized'); }
function parseDacl(txt) { const out = []; for (const l of (txt || '').split(/\n/)) { const t = l.trim().split(/\s+/).filter(Boolean); if (t.length < 2) continue; try { const en = parseAclTokens(t.slice(1), 'ios'); en.action = t[0]; en.hits = 0; out.push(en); } catch (x) { } } return out; }
const hhmm = () => new Date().toTimeString().slice(0, 8);
function iseAuth(L, rq) {
  const I = L.ise, sw = L.dev[rq.nas], port = sw && sw.ifs[rq.port]; const log = (res, why, prof, extra) => { I.logs.unshift(Object.assign({ t: hhmm(), user: rq.user || '(mab)', mac: rq.mac, nas: rq.nas + ' ' + rq.port, method: rq.method, result: res, profile: prof || '', why }, extra || {})); I.logs.length = Math.min(I.logs.length, 60); return { ok: res === 'Pass', why, profile: prof }; };
  const fail = (why, st) => { if (port) { port.state = st || 'unauth'; port.user = ''; port.dacl = null; } return log('Fail', why); };
  if (!sw || !port) return fail('Unknown switch/port');
  if (L.dev.ISE1.on === false || (L.dev['MGMT-SW'] && L.dev['MGMT-SW'].on === false)) return fail('RADIUS timeout: ISE1 is powered off or unreachable');
  if (!sw.aaa) return fail('Switch: "aaa new-model" is not configured - the switch never sent a RADIUS request');
  if (!sw.dot1xGlobal) return fail('Switch: "dot1x system-auth-control" is missing');
  if (port.auth !== 'auto') return fail('Switch port ' + rq.port + ' is not in "authentication port-control auto"');
  if (!sw.radius || !sw.radius.ip) return fail('Switch: no RADIUS server configured (radius server ... address ipv4 <ISE ip>)');
  if (sw.radius.ip !== '192.168.100.14') return fail('Switch: RADIUS server ' + sw.radius.ip + ' is not ISE (192.168.100.14) - request timed out');
  const nad = I.devices.find(d => d.name === rq.nas); if (!nad) return fail('ISE: 5405 RADIUS request dropped - unknown Network Access Device (add ' + rq.nas + ' under Network Devices)');
  if (nad.ip && sw.radius && nad.secret !== sw.radius.key) return fail('ISE: 5400 Authentication failed - invalid RADIUS shared secret (switch key does not match the Network Device secret)');
  let group = 'Unknown';
  if (I.authn && I.authn[rq.method === 'dot1x' ? 'dot1x' : 'mab'] === 'DenyAccess') return fail('ISE: Authentication policy rule "' + (rq.method === 'dot1x' ? 'Dot1X' : 'MAB') + '" uses identity source DenyAccess -> request rejected');
  if (rq.method === 'dot1x') { if (!I.allowDot1x) return fail('ISE: 802.1X (PEAP) is not allowed in Allowed Protocols'); const u = I.users.find(x => x.name === rq.user); if (!u) return fail('ISE: 22056 Subject not found in the applicable identity store(s)'); if (u.enabled === false) return fail('ISE: 22057 User account is disabled'); if (u.pass !== rq.pass) return fail('ISE: 22040 Wrong password or invalid shared secret'); group = u.group; }
  else { if (!I.allowMab) return fail('ISE: MAB is not allowed in Allowed Protocols'); const en = I.endpoints.find(x => x.mac.toLowerCase() === (rq.mac || '').toLowerCase()); group = en ? en.group : 'Unknown'; }
  const rule = I.authz.find(r => r.enabled !== false && (r.group === 'any' || r.group === group) && (r.method === 'any' || r.method === rq.method) && (!r.device || r.device === 'any' || r.device === rq.nas));
  const pname = rule ? rule.profile : 'DenyAccess', prof = I.profiles[pname] || { access: 'reject' };
  if (prof.access === 'reject') return fail('Authorization: ' + (rule ? 'rule "' + rule.name + '"' : 'Default rule') + ' -> ' + pname, 'unauth');
  port.state = prof.quarantine ? 'quarantine' : 'authorized'; port.user = rq.user || rq.mac; port.profile = pname; port.authVlan = prof.vlan; port.dacl = parseDacl(prof.dacl).length ? parseDacl(prof.dacl) : null;
  if (prof.quarantine) return log('Pass', 'Authorized into quarantine VLAN ' + prof.vlan + ' (no network access)', pname, { group });
  return log('Pass', 'Authorization rule "' + rule.name + '" -> ' + pname + (port.dacl ? ' (+ dACL)' : '') + ' [' + group + ']', pname, { group });
}
function iseLogoff(L, hn) { const p = portOf(L, hn); if (p) { p.port.state = 'unauth'; p.port.user = ''; p.port.dacl = null; p.port.profile = ''; } }
// ---------- ESA ----------
function ipIn(ip, list) { return list.some(x => { const [n, l] = x.split('/'); return inNet(ip, n, l === undefined ? 32 : +l); }); }
function esaSend(L, from, m) {
  const E = L.esa, esa = L.dev.ESA1, steps = [], mid = 1000 + E.tracking.length + 1;
  const done = (disp, ok, why) => { E.tracking.unshift({ t: hhmm(), mid, from: m.from, to: m.to, subject: m.subject, attach: (m.attach || []).join(','), src: seen || '', disp, why }); E.tracking.length = Math.min(E.tracking.length, 60); return { ok, disp, why, steps, mid }; };
  let seen = null;
  const net = flow(L, from, { proto: 'tcp', dst: m.server || '203.0.113.20', dport: 25 });
  if (!net.ok) { steps.push({ k: 'drop', t: 'SMTP connection to ' + (m.server || '203.0.113.20') + ':25 failed - ' + (net.kind === 'closed' ? 'connection refused' : (net.why || net.kind)) }); return { ok: false, disp: 'not-connected', why: net.why || net.kind, steps, net, mid }; }
  seen = net.seenSrc; steps.push({ k: 'ok', t: 'TCP/25 connected (ESA sees sender IP ' + seen + ')' });
  if (esa.on === false) return { ok: false, disp: 'not-connected', why: 'ESA is powered off', steps, mid };
  for (const g of E.hat) { if (ipIn(seen, g.ips)) { if (g.policy === 'block') { E.counters.blocked++; steps.push({ k: 'drop', t: 'HAT: sender ' + seen + ' is in group ' + g.name + ' -> REJECT (554 connection refused)' }); return done('rejected', false, 'HAT group ' + g.name); } if (g.policy === 'allow') steps.push({ k: 'ok', t: 'HAT: sender in ' + g.name + ' -> trusted (skips spam scoring)' }); m._trusted = g.policy === 'allow'; } }
  const rd = (m.to.split('@')[1] || '').toLowerCase();
  if (!E.domains.includes(rd)) { steps.push({ k: 'drop', t: 'RAT: recipient domain "' + rd + '" is not a Public Listener accepted domain -> 550 relaying denied' }); return done('rejected', false, 'relay denied for ' + rd); }
  steps.push({ k: 'ok', t: 'RAT: recipient domain ' + rd + ' accepted' });
  const sd = (m.from.split('@')[1] || '').toLowerCase(), rec = E.dns[sd]; let spf = 'none'; if (rec) spf = ipIn(seen, rec.spf || []) ? 'pass' : 'fail';
  steps.push({ k: spf === 'fail' ? 'warn' : 'ok', t: 'SPF check for ' + sd + ' from ' + seen + ': ' + spf.toUpperCase() });
  const dkOk = !!m.dkim && !!(rec && rec.dkim); steps.push({ k: m.dkim ? (dkOk ? 'ok' : 'warn') : 'ok', t: 'DKIM: ' + (m.dkim ? (dkOk ? 'signature verified (PASS)' : 'signature present but no public key published (FAIL)') : 'message not signed (NONE)') });
  if (E.dmarc && E.dmarc.on && rec && rec.dmarc && rec.dmarc !== 'none') { const aligned = spf === 'pass' || dkOk; steps.push({ k: aligned ? 'ok' : 'drop', t: 'DMARC for ' + sd + ' (policy p=' + rec.dmarc + '): ' + (aligned ? 'PASS (SPF or DKIM aligned)' : 'FAIL (neither SPF nor DKIM aligned)') });
    if (!aligned) { if (rec.dmarc === 'reject') { E.counters.blocked++; steps.push({ k: 'drop', t: 'DMARC policy reject -> REJECT (550 5.7.1 DMARC)' }); return done('rejected', false, 'DMARC fail'); } steps.push({ k: 'drop', t: 'DMARC policy quarantine -> QUARANTINE' }); E.quarantine.push(m); return done('quarantined', false, 'DMARC fail'); } }
  let tag = ''; const dmarcOk = !!(E.dmarc && E.dmarc.on && rec && rec.dmarc && rec.dmarc !== 'none' && dkOk);   // DMARC pass through DKIM overrides a bare SPF fail
  if (spf === 'fail' && dmarcOk) steps.push({ k: 'ok', t: 'SPF failed but DKIM-aligned DMARC passed -> SPF policy action not applied' });
  else if (spf === 'fail') { if (E.spfAction === 'reject') { steps.push({ k: 'drop', t: 'Policy: SPF fail -> REJECT (550 5.7.1 sender not authorized)' }); E.counters.blocked++; return done('rejected', false, 'SPF fail'); } if (E.spfAction === 'quarantine') { steps.push({ k: 'drop', t: 'Policy: SPF fail -> QUARANTINE' }); E.quarantine.push(m); return done('quarantined', false, 'SPF fail'); } tag = '[SPF-FAIL] '; steps.push({ k: 'warn', t: 'Policy: SPF fail -> deliver but tag subject' }); }
  if (E.antispam.on && !m._trusted) { let score = 0; const txt = (m.subject + ' ' + m.body).toLowerCase(); for (const w of ['free money', 'winner', 'viagra', 'click here', 'wire transfer', 'lottery', 'urgent']) if (txt.includes(w)) score += 30; if (m.subject && m.subject === m.subject.toUpperCase() && /[A-Z]/.test(m.subject)) score += 15; if (spf === 'fail') score += 20;
    steps.push({ k: score >= E.antispam.threshold ? 'drop' : 'ok', t: 'Anti-Spam score ' + score + ' (threshold ' + E.antispam.threshold + ')' }); if (score >= E.antispam.threshold) { E.counters.spam++; if (E.antispam.action === 'drop') { steps.push({ k: 'drop', t: 'Anti-Spam: positively identified spam -> DROP' }); return done('dropped', false, 'spam'); } steps.push({ k: 'drop', t: 'Anti-Spam: spam -> QUARANTINE' }); E.quarantine.push(m); return done('quarantined', false, 'spam score ' + score); } }
  if (E.antivirus) { const v = (m.attach || []).find(a => /eicar/i.test(a)); if (v) { E.counters.virus++; steps.push({ k: 'drop', t: 'Anti-Virus: "' + v + '" infected (EICAR-Test-File) -> DROP attachment+message' }); return done('dropped', false, 'virus in ' + v); } steps.push({ k: 'ok', t: 'Anti-Virus: clean' }); }
  for (const f of E.filters) { let hit = false; const ext = a => (a.split('.').pop() || '').toLowerCase();
    if (f.cond === 'attachment-ext') hit = (m.attach || []).some(a => ext(a) === f.value.toLowerCase().replace('.', '')); else if (f.cond === 'subject-contains') hit = (m.subject || '').toLowerCase().includes(f.value.toLowerCase()); else if (f.cond === 'body-contains') hit = (m.body || '').toLowerCase().includes(f.value.toLowerCase());
    if (hit) { steps.push({ k: f.action === 'tag' ? 'warn' : 'drop', t: 'Content filter "' + f.name + '" matched (' + f.cond + ' ' + f.value + ') -> ' + f.action.toUpperCase() }); if (f.action === 'drop') return done('dropped', false, 'filter ' + f.name); if (f.action === 'quarantine') { E.quarantine.push(m); return done('quarantined', false, 'filter ' + f.name); } if (f.action === 'tag') tag += '[' + f.name + '] '; } }
  if (E.dlp && /\b\d{3}-\d{2}-\d{4}\b/.test(m.body || '')) { E.counters.dlp++; steps.push({ k: 'drop', t: 'DLP: US Social Security Number pattern detected -> QUARANTINE' }); E.quarantine.push(m); return done('quarantined', false, 'DLP: SSN'); }
  const user = m.to.split('@')[0].toLowerCase(); (E.mailboxes[user] = E.mailboxes[user] || []).unshift({ from: m.from, subject: tag + m.subject, t: hhmm() }); E.counters.accepted++;
  steps.push({ k: 'ok', t: 'Delivered to mailbox ' + m.to + (tag ? ' (tagged ' + tag.trim() + ')' : '') }); return done(tag ? 'delivered (tagged)' : 'delivered', true, '');
}
// ---------- web (simulated Internet + WSA proxy) ----------
const WEB = { 'www.facebook.com': { cat: 'Social Networking', page: 'Facebook (simulated social network)' }, 'www.casino-royal.com': { cat: 'Gambling', page: 'Casino Royal - place your bets' }, 'www.cisco.com': { cat: 'Business', page: 'Cisco - business site (simulated)' },
  'news.example.org': { cat: 'News', page: 'Example News - today' }, 'www.youtube.com': { cat: 'Streaming Media', page: 'Video streaming (simulated)' }, 'www.malware-test.net': { cat: 'Malware Sites', page: 'Malware distribution site (simulated)' }, 'downloads.example.org': { cat: 'File Downloads', page: 'Example downloads - files' } };
function webGet(L, host, rq) {
  const m = /^(https?):\/\/([^\/:]+)(?::(\d+))?(\/.*)?$/i.exec(rq.url || ''); if (!m) return { ok: false, kind: 'bad', why: 'Invalid URL (use http://name or https://name)', steps: [] };
  const https = m[1].toLowerCase() === 'https', name = m[2].toLowerCase(), port = m[3] ? +m[3] : https ? 443 : 80, path = m[4] || '/', steps = [], isIpN = /^\d+(\.\d+){3}$/.test(name);
  const site = WEB[name], dst = isIpN ? name : site ? '198.51.100.10' : null;
  if (!dst) return { ok: false, kind: 'dns', why: 'DNS: ' + name + ' could not be resolved (not in the simulated Internet: try www.facebook.com, www.cisco.com, www.casino-royal.com, www.youtube.com, downloads.example.org)', steps };
  steps.push({ k: 'ok', t: 'DNS: ' + name + ' -> ' + dst });
  if (!rq.proxy) { const r = flow(L, host, { proto: 'tcp', dst, dport: port, host: isIpN ? null : name, file: /eicar/i.test(path) ? 'eicar' : null }); steps.push({ k: r.ok ? 'ok' : 'drop', t: 'Direct connection to ' + dst + ':' + port + (r.ok ? ' succeeded' : ' failed: ' + (r.why || r.kind)) });
    return { ok: r.ok, kind: r.kind, status: r.ok ? 200 : 0, page: site ? site.page : r.page, cat: site ? site.cat : '', why: r.why, steps, net: r }; }
  const [pip, pp] = rq.proxy.split(':'), pr = flow(L, host, { proto: 'tcp', dst: pip, dport: +pp || 3128 });
  steps.push({ k: pr.ok ? 'ok' : 'drop', t: 'Connect to proxy ' + rq.proxy + (pr.ok ? ' OK' : ' failed: ' + (pr.why || pr.kind)) });
  if (!pr.ok) return { ok: false, kind: 'proxy', why: 'Proxy ' + rq.proxy + ' unreachable: ' + (pr.why || pr.kind), steps, net: pr };
  const W = L.wsa; W.counters.total++; const cat = site ? site.cat : 'Uncategorized'; const cip = L.dev[host].ifs.eth0.ip; const grp = (W.policies || []).find(p => p.members.some(mm => inCidr(cip, mm))); const pol = grp ? grp.policy : W.policy; let act = pol[cat] || 'allow'; if (grp) steps.push({ k: 'ok', t: 'WSA: client ' + cip + ' matched Access Policy "' + grp.name + '"' });
  if (W.blocklist.includes(name)) { act = 'block'; steps.push({ k: 'warn', t: 'Custom URL list: ' + name + ' is in the Block list' }); } if (W.allowlist.includes(name)) { act = 'allow'; steps.push({ k: 'ok', t: 'Custom URL list: ' + name + ' is in the Allow list' }); }
  const lg = (a, why) => { W.log.unshift({ t: hhmm(), client: host, url: rq.url, cat, act: a, why: why || '' }); W.log.length = Math.min(W.log.length, 60); };
  steps.push({ k: 'ok', t: 'WSA: ' + (https ? 'HTTPS CONNECT (' + (W.decrypt && ((W.decryptCats || {})[cat] || 'decrypt') === 'decrypt' ? 'DECRYPTED - full inspection' : 'tunnelled - only the host name is visible') + ')' : 'HTTP request') + ', category "' + cat + '", policy action ' + act.toUpperCase() });
  if (act === 'block') { W.counters.blocked++; lg('Blocked', 'category ' + cat); steps.push({ k: 'drop', t: 'WSA: BLOCKED by Access Policy (category ' + cat + ') - block page returned' }); return { ok: false, kind: 'blocked', status: 403, cat, why: 'Blocked by WSA: URL category "' + cat + '"', steps, net: pr }; }
  const dmode = https && W.decrypt ? ((W.decryptCats || {})[cat] || 'decrypt') : 'passthrough'; if (https && W.decrypt && dmode === 'drop') { W.counters.blocked++; lg('Blocked', 'decryption policy drop: ' + cat); steps.push({ k: 'drop', t: 'WSA Decryption Policy: category ' + cat + ' = DROP' }); return { ok: false, kind: 'blocked', status: 403, cat, why: 'Blocked by WSA decryption policy (' + cat + ')', steps, net: pr }; }
  if (/eicar|malware|\.exe$/i.test(path)) { if (W.av && (!https || dmode === 'decrypt')) { W.counters.malware++; W.counters.blocked++; lg('Blocked', 'malware: ' + path); steps.push({ k: 'drop', t: 'WSA Anti-Malware: "' + path + '" is malicious (EICAR) -> BLOCKED' }); return { ok: false, kind: 'malware', status: 403, cat, why: 'Blocked by WSA: malware detected in download', steps, net: pr }; }
    steps.push({ k: 'warn', t: W.av ? 'WSA cannot scan inside the encrypted HTTPS tunnel - malware passes! (enable HTTPS decryption)' : 'Anti-Malware scanning is disabled' }); }
  const up = flow(L, 'WSA1', { proto: 'tcp', dst, dport: port }); steps.push({ k: up.ok ? 'ok' : 'drop', t: 'WSA fetches from the Internet ' + dst + ':' + port + (up.ok ? ' - OK' : ' - FAILED: ' + (up.why || up.kind)) });
  if (!up.ok) { lg('Error', 'upstream ' + (up.why || up.kind)); return { ok: false, kind: 'upstream', status: 503, cat, why: 'WSA could not reach the Internet: ' + (up.why || up.kind) + ' (check the firewall for DMZ -> outside)', steps, net: pr }; }
  W.counters.allowed++; lg(act === 'monitor' ? 'Monitored' : 'Allowed', ''); return { ok: true, status: 200, cat, page: site ? site.page : 'OK', via: 'WSA', steps, net: pr };
}
// ---------- flows ----------
function originate(ctx, dn, pkt) {
  const d = ctx.L.dev[dn]; pushPath(ctx, dn);
  if (ownsIp(d, pkt.dst)) return { st: 'delivered', dev: dn, pkt };
  const r = routeLookup(d, pkt.dst);
  if (!r) { T(ctx, dn, 'no route to ' + pkt.dst, 'drop'); return { st: 'drop', dev: dn, why: 'no route to host ' + pkt.dst, kind: 'noroute' }; }
  T(ctx, dn, 'sends ' + pstr(pkt));
  return forward(ctx, d, r, pkt, 0);
}
function srcIpFor(d, dst) { const r = routeLookup(d, dst); return r ? d.ifs[r.if].ip : null; }
function flow(L, srcName, p) { const r = flow0(L, srcName, p); if (API.hook) API.hook(r, srcName, p); return r; }
function flow0(L, srcName, p) {
  const ctx = { L, trace: [], path: [], now: Date.now() }; const d = L.dev[srcName];
  if (d.on === false) return { ok: false, kind: 'off', why: srcName + ' is powered off', trace: ctx.trace, path: [srcName] };
  const sip = p.srcIp || srcIpFor(d, p.dst);
  if (!sip) return { ok: false, kind: 'noroute', why: 'no route to ' + p.dst, trace: ctx.trace, path: [srcName] };
  if (d.type === 'host' && nacBlocked(L, srcName)) { const pp = portOf(L, srcName); return { ok: false, kind: 'unauth', why: '802.1X: port ' + pp.name + ' on ' + pp.sw.name + ' is ' + (pp.port.state === 'quarantine' ? 'in the quarantine VLAN (no access)' : 'not authenticated') + ' - authenticate with ISE first', at: pp.sw.name, trace: ctx.trace, path: [srcName, pp.sw.name] }; }
  const id = 1000 + Math.floor(Math.random() * 60000);
  const pkt = { proto: p.proto, src: sip, dst: p.dst, sport: p.proto === 'icmp' ? id : (p.sport || 40000 + Math.floor(Math.random() * 20000)), dport: p.proto === 'icmp' ? id : p.dport, ttl: p.ttl || 64, type: 'echo', sig: p.sig, host: p.host, file: p.file };
  if (d.type === 'host') { const pp = portOf(L, srcName); if (pp && pp.port.dacl) { const r = evalAcl({ acls: { D: pp.port.dacl }, objects: {} }, 'D', pkt); if (r.action === 'deny') { T(ctx, pp.sw.name, 'dACL from ISE denied ' + pstr(pkt), 'drop'); return { ok: false, kind: 'prohibited', why: 'downloadable ACL (dACL) assigned by ISE on ' + pp.sw.name + ' ' + pp.name + ' denied this traffic', at: pp.sw.name, trace: ctx.trace, path: [srcName, pp.sw.name] }; } } }
  const o = originate(ctx, srcName, pkt);
  if (o.st !== 'delivered') return { ok: false, kind: o.reset ? 'closed' : o.kind === 'prohibited' ? 'prohibited' : o.kind === 'noroute' || o.kind === 'unreach' ? 'unreach' : o.kind === 'ttl' ? 'ttl' : o.silent ? 'timeout' : 'timeout', why: o.why, at: o.dev, hopIp: o.hopIp, trace: ctx.trace, path: ctx.path };
  const dd = L.dev[o.dev], fp = o.pkt; let kind, rp;
  const isHost = dd.type === 'host';
  if (fp.proto === 'icmp') { kind = 'open'; rp = { proto: 'icmp', type: 'echo-reply' }; }
  else if (isHost && ((dd.listen[fp.proto] || []).includes(fp.dport))) { kind = 'open'; rp = { proto: fp.proto }; }
  else { kind = 'closed'; rp = { proto: fp.proto }; }
  T(ctx, dd.name, fp.proto === 'icmp' ? 'sends echo-reply' : kind === 'open' ? fp.proto + '/' + fp.dport + ' open -> ' + (fp.proto === 'tcp' ? 'SYN-ACK' : 'reply') : fp.proto + '/' + fp.dport + ' closed -> ' + (fp.proto === 'tcp' ? 'RST' : 'ICMP port unreachable'), kind === 'open' ? 'ok' : 'drop');
  const reply = { proto: fp.proto === 'icmp' ? 'icmp' : fp.proto, type: rp.type, src: fp.dst, dst: fp.src, sport: fp.dport, dport: fp.sport, ttl: 64 };
  const o2 = originate(ctx, o.dev, reply);
  if (o2.st !== 'delivered' || o2.dev !== srcName) return { ok: false, kind: 'timeout', why: 'return traffic failed: ' + (o2.why || 'not delivered to source'), at: o2.dev, trace: ctx.trace, path: ctx.path };
  return { seenSrc: fp.src, ok: kind === 'open', kind, page: kind === 'open' && dd.listen && p.dport === 80 ? dd.listen.page : null, trace: ctx.trace, path: ctx.path, dstDev: o.dev };
}
function traceroute(L, srcName, dst, max) {
  const hops = [];
  for (let t = 1; t <= (max || 12); t++) {
    const r = flow(L, srcName, { proto: 'icmp', dst, ttl: t });
    if (r.kind === 'ttl') hops.push({ n: t, ip: r.hopIp });
    else if (r.ok) { hops.push({ n: t, ip: dst, done: true }); break; }
    else { hops.push({ n: t, ip: null }); if (r.kind !== 'timeout' || t > 3) { if (r.kind === 'unreach' || r.kind === 'prohibited') break; } }
  }
  return hops;
}
function ftdChanges(d) { const o = []; const dr = d.draft; if (!dr) return o; const j = JSON.stringify; const strip = p => { const q = JSON.parse(j(p)); (q.rules || []).forEach(r => delete r.hits); delete q.defHits; return q; };
  if (j(dr.ifs) !== j(d.ifs)) o.push('Interfaces'); if (j(dr.routes) !== j(d.routes)) o.push('Routing (static routes)'); if (j(dr.nat) !== j(d.nat)) o.push('NAT policy'); if (j(strip(dr.policy)) !== j(strip(d.policy))) o.push('Access Control Policy: ' + d.policy.name); if (j(dr.objects) !== j(d.objects) || j(dr.portObjs) !== j(d.portObjs) || j(dr.zones) !== j(d.zones)) o.push('Objects (network / port / security zones)'); return o; }
function ftdDeploy(d) { if (d.draft) { const ch = ftdChanges(d); const hits = {}; d.policy.rules.forEach(r => hits[r.id] = r.hits); d.ifs = clone(d.draft.ifs); d.routes = clone(d.draft.routes); d.policy = clone(d.draft.policy); d.nat = clone(d.draft.nat); d.objects = clone(d.draft.objects); d.portObjs = clone(d.draft.portObjs); d.zones = clone(d.draft.zones); d.policy.rules.forEach(r => { r.hits = hits[r.id] || 0; }); d.deploys = d.deploys || []; d.deploys.unshift({ t: hhmm(), by: 'admin', items: ch.length ? ch : ['(no changes)'] }); } d.dirty = false; }

function packetTracer(L, dn, nameif, p) {
  const d = L.dev[dn]; const ifx = ifByNameif(d, nameif); if (!ifx) return null;
  const ctx = { L, trace: [], path: [], now: Date.now() };
  const nc = d.conns.length, nx = d.xlates.length, seq = d.connSeq, evn = d.events ? d.events.length : 0;
  const pkt = { proto: p.proto, src: p.src, dst: p.dst, sport: p.sport || 1234, dport: p.dport || 0, ttl: 64, type: 'echo', sig: p.sig };
  const o = process(ctx, dn, ifx.name, pkt, 0);
  d.conns.length = nc; d.xlates.length = nx; d.connSeq = seq; if (d.events) d.events.splice(0, d.events.length - evn);
  return { o, trace: ctx.trace, path: ctx.path };
}
const API = { WEB, IPS_POLICIES, SIGINFO, FTD_APPS, FTD_URLCATS, ftdChanges, ftdApps, addRogue, removeRogue, psCheck, portUp, VERSION: 6, webGet, packetTracer, iseAuth, iseLogoff, esaSend, portOf, nacBlocked,  ip2n, n2ip, inNet, maskToLen, lenToMask, wildToLen, isIp, portNum, clone, newLab, flow, traceroute, routeLookup, ownsIp, evalAcl, parseAclTokens, aclText, fmtAddr, ifByNameif, ftdDeploy, segment };
root.Sim = API; if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
