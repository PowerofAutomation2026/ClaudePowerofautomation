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
  const L = { dev: {}, links: [], conns: [] };
  const D = (t, n, label, x, y) => (L.dev[n] = mk(t, n, label, x, y));
  const host = (n, label, x, y, ip, len, gw, listen) => { const d = D('host', n, label, x, y); addIf(d, 'eth0', ip, len); d.gw = gw; d.listen = listen; return d; };
  host('Outside', 'Outside-Desktop', 70, 120, '198.51.100.10', 24, '198.51.100.1', { tcp: [22, 80], udp: [], page: 'Outside web server (198.51.100.10)' });
  const r2 = D('router', 'R2', 'R2', 250, 120);
  addIf(r2, 'Gi0/1', '203.0.113.2', 24); addIf(r2, 'Gi0/2', '198.51.100.1', 24); addIf(r2, 'Gi0/3', '192.0.2.2', 24);
  r2.routes.push({ net: '10.2.1.0', len: 24, nh: '192.0.2.1' });
  r2.routes.push({ net: '172.16.1.0', len: 24, nh: '203.0.113.1' });
  const fw = D('asa', 'FW1', 'FW1-ASA', 450, 120); fw.objects = {}; fw.nats = []; fw.conns = []; fw.xlates = [];
  addIf(fw, 'Gi0/0', '203.0.113.1', 24, { nameif: 'outside', sec: 0 });
  addIf(fw, 'Gi0/1', '10.1.1.1', 24, { nameif: 'inside', sec: 100 });
  addIf(fw, 'Gi0/2', '172.16.1.1', 24, { nameif: 'dmz', sec: 50 });
  fw.routes.push({ net: '0.0.0.0', len: 0, nh: '203.0.113.2', nameif: 'outside' }, { net: '10.1.10.0', len: 24, nh: '10.1.1.2', nameif: 'inside' });
  fw.objects['INSIDE-NETS'] = { kind: 'subnet', ip: '10.1.0.0', len: 16 };
  fw.nats.push({ kind: 'dynamic', obj: 'INSIDE-NETS', realIf: 'inside', mappedIf: 'outside', mapped: 'interface' });
  const r1 = D('router', 'R1', 'R1', 650, 120);
  addIf(r1, 'Gi0/1', '10.1.1.2', 24); addIf(r1, 'Gi0/2', '10.1.10.1', 24); r1.routes.push({ net: '0.0.0.0', len: 0, nh: '10.1.1.1' });
  D('switch', 'SW1', 'SW1', 790, 120);
  host('Client', 'Client (inside PC)', 920, 120, '10.1.10.10', 24, '10.1.10.1', { tcp: [22], udp: [], page: 'Client PC' });
  host('DMZ', 'DMZ-Server', 450, 290, '172.16.1.10', 24, '172.16.1.1', { tcp: [22, 80], udp: [], page: 'DMZ web server (172.16.1.10) - welcome!' });
  const ft = D('ftd', 'FTD1', 'FTD1', 250, 290); ft.conns = []; ft.xlates = []; ft.events = [];
  addIf(ft, 'Gi0/0', '192.0.2.1', 24, { zone: 'OUT', nameif: 'outside' }); addIf(ft, 'Gi0/1', '10.2.1.1', 24, { zone: 'IN', nameif: 'inside' });
  ft.routes.push({ net: '0.0.0.0', len: 0, nh: '192.0.2.2' });
  ft.policy = { defaultAction: 'block', rules: [{ name: 'Allow-IN-OUT', srcZone: 'IN', dstZone: 'OUT', srcNet: 'any', dstNet: 'any', proto: 'any', dport: null, action: 'allow', ips: false, hits: 0 }] }; ft.nat = [{ srcZone: 'IN', dstZone: 'OUT' }]; ft.dirty = false;
  host('FTDClient', 'FTD-Client', 250, 450, '10.2.1.10', 24, '10.2.1.1', { tcp: [22, 80], udp: [], page: 'FTD-Client internal web server (10.2.1.10)' });
  ft.draft = clone({ ifs: ft.ifs, routes: ft.routes, policy: ft.policy, nat: ft.nat });
  L.links = [['Outside:eth0', 'R2:Gi0/2'], ['R2:Gi0/1', 'FW1:Gi0/0'], ['FW1:Gi0/1', 'R1:Gi0/1'], ['FW1:Gi0/2', 'DMZ:eth0'], ['R1:Gi0/2', 'SW1:p1'],
    ['SW1:p2', 'Client:eth0'], ['R2:Gi0/3', 'FTD1:Gi0/0'], ['FTD1:Gi0/1', 'FTDClient:eth0']];
  return L;
}

// ---------- topology helpers ----------
function farEnd(L, port) { for (const [a, b] of L.links) { if (a === port) return b; if (b === port) return a; } return null; }
function segment(L, d, i) {
  const out = [], sw = [], vis = new Set([d + ':' + i]);
  (function walk(port) {
    const f = farEnd(L, port); if (!f || vis.has(f)) return; vis.add(f);
    const [fd, fi] = f.split(':');
    if (L.dev[fd].type === 'switch') { if (L.dev[fd].on === false) return; sw.push(fd); for (const [a, b] of L.links) for (const e of [a, b]) if (e.split(':')[0] === fd && !vis.has(e)) { vis.add(e); walk(e); } }
    else out.push({ dev: fd, if: fi });
  })(d + ':' + i);
  return { eps: out, sw };
}
function arp(L, dn, ifn, ip) {
  const s = segment(L, dn, ifn);
  for (const ep of s.eps) { if (L.dev[ep.dev].on === false) continue; const x = L.dev[ep.dev].ifs[ep.if]; if (x && x.up && x.ip === ip) return { dev: ep.dev, if: ep.if, sw: s.sw }; }
  for (const ep of s.eps) { const fd = L.dev[ep.dev]; if (fd.type !== 'asa' || fd.on === false) continue;   // proxy-ARP for static-NAT mapped addresses
    for (const n of fd.nats) if (n.kind === 'static' && n.mapped === ip && fd.ifs[ep.if].nameif === n.mappedIf) return { dev: ep.dev, if: ep.if, sw: s.sw }; }
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
    if (!isIp(t) || !isIp(tok[i])) throw new Error('% Invalid address/mask near "' + (t || '') + '"');
    const m = tok[i++]; return { t: 'net', ip: t, len: style === 'ios' ? wildToLen(m) : maskToLen(m) };
  };
  const port = () => { const t = tok[i]; if (['eq', 'gt', 'lt', 'neq'].includes(t)) { i++; return { op: t, p: portNum(tok[i++]) }; } if (t === 'range') { i++; const a = portNum(tok[i++]), b = portNum(tok[i++]); return { op: 'range', p: a, p2: b }; } return null; };
  e.src = addr(); if (e.proto === 'tcp' || e.proto === 'udp') e.sport = port();
  e.dst = addr(); if (e.proto === 'tcp' || e.proto === 'udp') e.dport = port(); else if (e.proto === 'icmp' && tok[i] && tok[i] !== 'log') e.icmpType = tok[i++];
  return e;
}
const fmtAddr = (a, style) => !a || a.t === 'any' ? 'any' : a.t === 'host' ? 'host ' + a.ip : a.t === 'obj' ? 'object ' + a.name : a.ip + ' ' + (style === 'ios' ? n2ip((~lenMask(a.len)) >>> 0) : lenToMask(a.len));
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
function asaNew(ctx, d, inIf, inI, inName, pkt, depth) {
  let dstReal = pkt.dst, unat = null;
  for (const n of d.nats) if (n.kind === 'static' && pkt.dst === n.mapped && inName === n.mappedIf) { dstReal = n.real; unat = n; T(ctx, d.name, 'NAT: untranslate ' + n.mapped + ' -> ' + n.real + ' (static ' + n.obj + ')', 'ok'); break; }
  const r = routeLookup(d, dstReal);
  if (!r) { T(ctx, d.name, 'no route to ' + dstReal, 'drop'); return { st: 'drop', dev: d.name, why: 'no route to ' + dstReal, kind: 'noroute', silent: true }; }
  const out = d.ifs[r.if], outName = out.nameif;
  if (outName === inName) { T(ctx, d.name, 'No NAT/untranslate rule matched ' + pkt.dst + ': it routes back out the ingress interface (' + inName + ') - dropped', 'drop'); return { st: 'drop', dev: d.name, why: pkt.dst + ' is reachable only back out the ingress interface: no static NAT (untranslate) rule for it', kind: 'drop', silent: true }; }
  const chk = Object.assign({}, pkt, { dst: dstReal });
  if (inI.aclIn && d.acls[inI.aclIn]) {
    const a = evalAcl(d, inI.aclIn, chk);
    if (a.action === 'deny') { T(ctx, d.name, '[' + inName + '] ACL ' + inI.aclIn + ': ' + (a.implicit ? 'implicit deny (no matching line)' : 'line ' + a.idx + ' DENY') + ' -> DROP', 'drop'); return { st: 'drop', dev: d.name, why: 'access-list ' + inI.aclIn + (a.implicit ? ' implicit deny' : ' line ' + a.idx + ' deny') + ' on ' + inName, kind: 'drop', silent: true }; }
    T(ctx, d.name, '[' + inName + '] ACL ' + inI.aclIn + ' line ' + a.idx + ' permit', 'ok');
  } else if (inI.sec > out.sec) T(ctx, d.name, 'security-level ' + inI.sec + ' (' + inName + ') > ' + out.sec + ' (' + outName + '): allowed by default', 'ok');
  else { T(ctx, d.name, 'no ACL on ' + inName + ' and security-level ' + inI.sec + ' <= ' + out.sec + ': implicit deny', 'drop'); return { st: 'drop', dev: d.name, why: 'implicit deny: ' + inName + '(' + inI.sec + ') -> ' + outName + '(' + out.sec + ') with no access-list', kind: 'drop', silent: true }; }
  let ns = pkt.src, how = null;
  for (const n of d.nats) {
    if (n.realIf !== inName || n.mappedIf !== outName) continue;
    if (n.kind === 'static' && n.real === pkt.src) { ns = n.mapped; how = 'static ' + n.obj; break; }
    if (n.kind === 'dynamic') { const o = d.objects[n.obj]; if (o && matchAddr(d, { t: 'obj', name: n.obj }, pkt.src)) { ns = n.mapped === 'interface' ? out.ip : n.mapped; how = 'dynamic PAT ' + n.obj; break; } }
  }
  if (how) T(ctx, d.name, 'NAT: ' + pkt.src + ' -> ' + ns + ' (' + how + ')', 'ok');
  const c = addConn(ctx, d, pkt.proto, { if: inIf, src: pkt.src, sport: pkt.sport, dst: pkt.dst, dport: pkt.dport }, { if: r.if, src: ns, sport: pkt.sport, dst: dstReal, dport: pkt.dport });
  T(ctx, d.name, 'connection #' + c.id + ' built ' + inName + ' -> ' + outName, 'ok');
  return forward(ctx, d, r, Object.assign({}, pkt, { src: ns, dst: dstReal }), depth);
}
function inCidr(ip, s) { if (!s || s === 'any') return true; const [n, l] = s.split('/'); return inNet(ip, n, l === undefined ? 32 : +l); }
function ftdNew(ctx, d, inIf, inI, inName, pkt, depth) {
  const zin = inI.zone;
  const r = routeLookup(d, pkt.dst);
  if (!r) { T(ctx, d.name, 'no route to ' + pkt.dst, 'drop'); return { st: 'drop', dev: d.name, why: 'no route to ' + pkt.dst, kind: 'noroute', silent: true }; }
  const out = d.ifs[r.if], zout = out.zone;
  let rule = null, action = d.policy.defaultAction;
  for (const ru of d.policy.rules) {
    if (ru.srcZone !== 'any' && ru.srcZone !== zin) continue; if (ru.dstZone !== 'any' && ru.dstZone !== zout) continue;
    if (!zin || !zout) continue;
    if (!inCidr(pkt.src, ru.srcNet) || !inCidr(pkt.dst, ru.dstNet)) continue;
    if (ru.proto !== 'any' && ru.proto !== pkt.proto) continue;
    if (ru.dport && pkt.proto !== 'icmp' && +ru.dport !== pkt.dport) continue;
    rule = ru; action = ru.action; break;
  }
  const ev = (a, why) => d.events.unshift({ t: ctx.now, src: pkt.src, dst: pkt.dst, proto: pkt.proto, dport: pkt.dport, action: a, rule: rule ? rule.name : 'Default Action', why: why || '' });
  if (action !== 'allow') { T(ctx, d.name, 'Access Control Policy: ' + (rule ? 'rule "' + rule.name + '" BLOCK' : 'Default Action "Block All Traffic"') + ' [' + (zin || 'no zone') + ' -> ' + (zout || 'no zone') + ']', 'drop'); ev('Block'); if (rule) rule.hits = (rule.hits || 0) + 1; else d.policy.defHits = (d.policy.defHits || 0) + 1; return { st: 'drop', dev: d.name, why: (rule ? 'rule "' + rule.name + '"' : 'default action') + ' blocked ' + (zin || '?') + '->' + (zout || '?'), kind: 'drop', silent: true }; }
  rule.hits = (rule.hits || 0) + 1;
  T(ctx, d.name, 'Access Control Policy: rule "' + rule.name + '" ALLOW [' + zin + ' -> ' + zout + ']', 'ok');
  if (rule.ips && pkt.sig) { T(ctx, d.name, 'Intrusion Prevention: signature "' + pkt.sig + '" matched - BLOCKED', 'drop'); ev('Block', 'IPS: ' + pkt.sig); return { st: 'drop', dev: d.name, why: 'Intrusion policy blocked signature "' + pkt.sig + '"', kind: 'drop', silent: true }; }
  let ns = pkt.src;
  for (const n of d.nat) if (n.srcZone === zin && n.dstZone === zout) { ns = out.ip; T(ctx, d.name, 'NAT: PAT ' + pkt.src + ' -> ' + ns + ' (interface)', 'ok'); break; }
  ev('Allow');
  const c = addConn(ctx, d, pkt.proto, { if: inIf, src: pkt.src, sport: pkt.sport, dst: pkt.dst, dport: pkt.dport }, { if: r.if, src: ns, sport: pkt.sport, dst: pkt.dst, dport: pkt.dport });
  T(ctx, d.name, 'connection #' + c.id + ' built', 'ok');
  return forward(ctx, d, r, Object.assign({}, pkt, { src: ns }), depth);
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
  const id = 1000 + Math.floor(Math.random() * 60000);
  const pkt = { proto: p.proto, src: sip, dst: p.dst, sport: p.proto === 'icmp' ? id : (p.sport || 40000 + Math.floor(Math.random() * 20000)), dport: p.proto === 'icmp' ? id : p.dport, ttl: p.ttl || 64, type: 'echo', sig: p.sig };
  const o = originate(ctx, srcName, pkt);
  if (o.st !== 'delivered') return { ok: false, kind: o.kind === 'prohibited' ? 'prohibited' : o.kind === 'noroute' || o.kind === 'unreach' ? 'unreach' : o.kind === 'ttl' ? 'ttl' : o.silent ? 'timeout' : 'timeout', why: o.why, at: o.dev, hopIp: o.hopIp, trace: ctx.trace, path: ctx.path };
  const dd = L.dev[o.dev], fp = o.pkt; let kind, rp;
  const isHost = dd.type === 'host';
  if (fp.proto === 'icmp') { kind = 'open'; rp = { proto: 'icmp', type: 'echo-reply' }; }
  else if (isHost && ((dd.listen[fp.proto] || []).includes(fp.dport))) { kind = 'open'; rp = { proto: fp.proto }; }
  else { kind = 'closed'; rp = { proto: fp.proto }; }
  T(ctx, dd.name, fp.proto === 'icmp' ? 'sends echo-reply' : kind === 'open' ? fp.proto + '/' + fp.dport + ' open -> ' + (fp.proto === 'tcp' ? 'SYN-ACK' : 'reply') : fp.proto + '/' + fp.dport + ' closed -> ' + (fp.proto === 'tcp' ? 'RST' : 'ICMP port unreachable'), kind === 'open' ? 'ok' : 'drop');
  const reply = { proto: fp.proto === 'icmp' ? 'icmp' : fp.proto, type: rp.type, src: fp.dst, dst: fp.src, sport: fp.dport, dport: fp.sport, ttl: 64 };
  const o2 = originate(ctx, o.dev, reply);
  if (o2.st !== 'delivered' || o2.dev !== srcName) return { ok: false, kind: 'timeout', why: 'return traffic failed: ' + (o2.why || 'not delivered to source'), at: o2.dev, trace: ctx.trace, path: ctx.path };
  return { ok: kind === 'open', kind, page: kind === 'open' && dd.listen && p.dport === 80 ? dd.listen.page : null, trace: ctx.trace, path: ctx.path, dstDev: o.dev };
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
function ftdDeploy(d) { if (d.draft) { d.ifs = clone(d.draft.ifs); d.routes = clone(d.draft.routes); d.policy = clone(d.draft.policy); d.nat = clone(d.draft.nat); } d.dirty = false; }

function packetTracer(L, dn, nameif, p) {
  const d = L.dev[dn]; const ifx = ifByNameif(d, nameif); if (!ifx) return null;
  const ctx = { L, trace: [], path: [], now: Date.now() };
  const nc = d.conns.length, nx = d.xlates.length, seq = d.connSeq, evn = d.events ? d.events.length : 0;
  const pkt = { proto: p.proto, src: p.src, dst: p.dst, sport: p.sport || 1234, dport: p.dport || 0, ttl: 64, type: 'echo', sig: p.sig };
  const o = process(ctx, dn, ifx.name, pkt, 0);
  d.conns.length = nc; d.xlates.length = nx; d.connSeq = seq; if (d.events) d.events.splice(0, d.events.length - evn);
  return { o, trace: ctx.trace, path: ctx.path };
}
const API = { packetTracer,  ip2n, n2ip, inNet, maskToLen, lenToMask, wildToLen, isIp, portNum, clone, newLab, flow, traceroute, routeLookup, ownsIp, evalAcl, parseAclTokens, aclText, fmtAddr, ifByNameif, ftdDeploy, segment };
root.Sim = API; if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
