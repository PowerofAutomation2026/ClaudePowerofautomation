// SCOR Lab Simulator - device command lines v2 (table-driven: ? help, Tab completion, abbreviations, IOS-style errors)
(function (root) {
'use strict';
const S = root.Sim;
const { flow, traceroute, packetTracer, parseAclTokens, aclText, isIp, maskToLen, lenToMask, n2ip, ip2n, routeLookup, ifByNameif, segment } = S;
const LONG = n => n.replace(/^Gi/, 'GigabitEthernet');
const SHORT = n => n.replace(/^GigabitEthernet/, 'Gi');
const pad = (s, n) => String(s).padEnd(n);
const BAD = ['sqlmap', 'nikto', 'masscan', 'metasploit', 'union select', '../../etc/passwd', '<script>'];
const WH = { show: 'Show running system information', configure: 'Enter configuration mode', terminal: 'Configure from the terminal', interface: 'Select an interface to configure', ip: 'Global IP configuration / IP information',
  route: 'Static routing / routing table', 'access-list': 'Access list', 'access-group': 'Apply an access list to an interface', ping: 'Send echo messages', traceroute: 'Trace route to destination', enable: 'Turn on privileged commands', exit: 'Exit from the current mode',
  end: 'Return to privileged EXEC', write: 'Write running configuration to memory', copy: 'Copy configuration', hostname: 'Set the system hostname', 'no': 'Negate a command or set its defaults', object: 'Configure an object', nat: 'Configure NAT',
  shutdown: 'Shut down the interface', description: 'Interface description', address: 'Set the IP address', version: 'System hardware and software status', clock: 'Display the system clock', 'running-config': 'Current operating configuration',
  'startup-config': 'Contents of startup configuration', arp: 'ARP table', interfaces: 'Interface status and configuration', brief: 'Brief summary', 'access-lists': 'List access lists', cdp: 'CDP information', neighbors: 'CDP neighbor entries',
  vlan: 'VLAN information', 'mac': 'MAC forwarding table', 'address-table': 'MAC address table', xlate: 'NAT translations', conn: 'Connection table', nameif: 'Name of the interface', 'security-level': 'Interface security level',
  'packet-tracer': 'Simulate a packet through the firewall', clear: 'Reset functions', host: 'Specify a single host', subnet: 'Specify a subnet', permit: 'Specify packets to forward', deny: 'Specify packets to reject', line: 'Configure a terminal line',
  login: 'Enable password checking', transport: 'Define transport protocols', username: 'Establish User Name Authentication', banner: 'Define a login banner', switchport: 'Set switching mode characteristics', access: 'Set access mode', trunk: 'Set trunking mode',
  tcp: 'Transmission Control Protocol', udp: 'User Datagram Protocol', icmp: 'Internet Control Message Protocol', any: 'Any source/destination', eq: 'Match only packets on a given port number', outside: 'Outside', inside: 'Inside', dmz: 'DMZ',
  extended: 'Extended access list', remark: 'Access list entry comment', static: 'Static NAT', dynamic: 'Dynamic NAT/PAT', network: 'Network object', protocols: 'Active network routing protocols', users: 'Display information about terminal lines',
  history: 'Display the session command history', logging: 'Logging facility', route: 'Routing table', nat_: 'NAT policy', reload: 'Halt and perform a cold restart', erase: 'Erase configuration', disable: 'Turn off privileged commands', manager: 'Manager configuration', network_: 'Network' };

// ---------- helpers ----------
function normIf(d, s) {
  if (d.type === 'host') return /^eth0$/i.test(s) ? 'eth0' : null;
  const v = /^vlan\s*(\d+)$/i.exec(s); if (v && d.type === 'switch') { const n = 'Vlan' + v[1]; if (!d.ifs[n]) d.ifs[n] = { name: n, ip: null, len: 24, up: true, svi: true }; return n; }
  const m = /^g(?:i|ig|iga|igab|igabit|igabitethernet)?\s*(\d+\/\d+)$/i.exec(s); const n = m ? 'Gi' + m[1] : null; return n && d.ifs[n] ? n : null;
}
const macOf = (dn, ifn) => { let h = 0; for (const c of dn + ifn) h = (h * 31 + c.charCodeAt(0)) >>> 0; const x = h.toString(16).padStart(8, '0'); return 'aabb.cc' + x.slice(0, 2) + '.' + x.slice(2, 6); };
function peerOf(L, dn, ifn) { for (const [a, b] of L.links) { if (a === dn + ':' + ifn) return b.split(':'); if (b === dn + ':' + ifn) return a.split(':'); } return null; }
function ifBrief(d) {
  const rows = Object.values(d.ifs).map(x => pad(LONG(x.name), 24) + pad(x.ip || 'unassigned', 16) + pad('YES ' + (x.ip ? 'manual' : 'unset'), 11) + pad(x.up ? 'up' : 'administratively down', 23) + (x.up ? 'up' : 'down'));
  return pad('Interface', 24) + pad('IP-Address', 16) + pad('OK? Method', 11) + pad('Status', 23) + 'Protocol\n' + rows.join('\n');
}
function ifBriefAsa(d) {
  const rows = Object.values(d.ifs).map(x => pad(LONG(x.name), 24) + pad(x.ip || 'unassigned', 16) + pad('YES manual', 11) + pad(x.up ? 'up' : 'administratively down', 23) + (x.up ? 'up' : 'down'));
  return pad('Interface', 24) + pad('IP-Address', 16) + pad('OK? Method', 11) + pad('Status', 23) + 'Protocol\n' + rows.join('\n');
}
function routeText(d, asa) {
  const out = ['Codes: C - connected, S - static, * - candidate default']; const lines = [];
  for (const x of Object.values(d.ifs)) if (x.up && x.ip) { const net = n2ip((ip2n(x.ip) & ((0xFFFFFFFF << (32 - x.len)) >>> 0)) >>> 0); lines.push('C    ' + net + (asa ? ' ' + lenToMask(x.len) : '/' + x.len) + ' is directly connected, ' + (asa ? x.nameif : x.name)); }
  let gw = null;
  for (const r of d.routes) { lines.push('S' + (r.len === 0 ? '*' : ' ') + '   ' + r.net + (asa ? ' ' + lenToMask(r.len) + ' [1/0] via ' + r.nh + ', ' + r.nameif : '/' + r.len + ' [1/0] via ' + r.nh)); if (r.len === 0) gw = r.nh; }
  out.push('', gw ? 'Gateway of last resort is ' + gw + ' to network 0.0.0.0' : 'Gateway of last resort is not set', ''); return out.concat(lines).join('\n');
}
function aclShow(d, name, style) {
  const names = name ? [name] : Object.keys(d.acls); if (name && !d.acls[name]) return style === 'asa' ? 'ERROR: access-list ' + name + ' not found' : '% No such access list';
  if (!names.length) return style === 'asa' ? '(no access-lists configured)' : '';
  return names.map(n => style === 'asa' ? 'access-list ' + n + '; ' + d.acls[n].length + ' elements; name hash: 0x' + (n.length * 7919).toString(16) + '\n' + d.acls[n].map((e, i) => 'access-list ' + n + ' line ' + (i + 1) + ' extended ' + aclText(e, 'asa') + ' (hitcnt=' + (e.hits || 0) + ')').join('\n')
    : 'Extended IP access list ' + n + '\n' + d.acls[n].map((e, i) => '    ' + (i + 1) * 10 + ' ' + aclText(e, 'ios') + (e.hits ? ' (' + e.hits + ' matches)' : '')).join('\n')).join('\n');
}
function subKey(s) { return s.ctx; }
function runCfg(d) {
  const asa = d.type === 'asa', sw = d.type === 'switch', o = [];
  if (asa) o.push(': Saved', 'ASA Version 9.20(1) (simulated)'); else o.push('Building configuration...', '', 'version 15.9 (simulated)');
  o.push('!', 'hostname ' + d.hostname, '!'); (d.extra || []).forEach(l => o.push(l)); if ((d.extra || []).length) o.push('!');
  if (sw && d.aaa) o.push('aaa new-model'); if (sw && d.dot1xGlobal) o.push('dot1x system-auth-control'); if (sw && d.radius && d.radius.name && d.radius.name !== 'legacy') o.push('radius server ' + d.radius.name, ' address ipv4 ' + (d.radius.ip || '?') + ' auth-port 1812 acct-port 1813', ' key ' + (d.radius.key || '?'), '!');
  if (sw) for (const v of Object.keys(d.vlans || {})) if (+v !== 1) o.push('vlan ' + v, ' name ' + d.vlans[v], '!');
  for (const x of Object.values(d.ifs)) {
    o.push('interface ' + (x.svi ? x.name : LONG(x.name))); if (asa) o.push(' nameif ' + x.nameif, ' security-level ' + x.sec);
    if (x.desc) o.push(' description ' + x.desc);
    if (sw && x.auth === 'auto') o.push(' authentication port-control auto');
    if (sw && !x.svi) { o.push(' switchport mode ' + (x.mode || 'access')); if ((x.mode || 'access') === 'access' && x.vlan && x.vlan !== 1) o.push(' switchport access vlan ' + x.vlan); }
    else o.push(x.ip ? ' ip address ' + x.ip + ' ' + lenToMask(x.len) : ' no ip address');
    if (!asa && x.aclIn) o.push(' ip access-group ' + x.aclIn + ' in'); if (!asa && x.aclOut) o.push(' ip access-group ' + x.aclOut + ' out');
    (x.extra || []).forEach(l => o.push(' ' + l)); o.push(x.up ? ' no shutdown' : ' shutdown', '!'); }
  if (asa) { for (const [k, ob] of Object.entries(d.objects)) { o.push('object network ' + k, ob.kind === 'host' ? ' host ' + ob.ip : ' subnet ' + ob.ip + ' ' + lenToMask(ob.len));
      for (const n of d.nats.filter(n => n.obj === k)) o.push(' nat (' + n.realIf + ',' + n.mappedIf + ') ' + n.kind + ' ' + (n.mapped === 'interface' ? 'interface' : n.mapped)); o.push('!'); } }
  for (const [k, ls] of Object.entries(d.sub || {})) { o.push(k); ls.forEach(l => o.push(' ' + l)); o.push('!'); }
  for (const [k, es] of Object.entries(d.acls)) { if (asa) es.forEach(e => o.push('access-list ' + k + ' extended ' + aclText(e, 'asa'))); else { o.push('ip access-list extended ' + k); es.forEach(e => o.push(' ' + aclText(e, 'ios'))); o.push('!'); } }
  if (asa) for (const x of Object.values(d.ifs)) if (x.aclIn) o.push('access-group ' + x.aclIn + ' in interface ' + x.nameif);
  for (const r of d.routes) o.push(asa ? 'route ' + r.nameif + ' ' + r.net + ' ' + lenToMask(r.len) + ' ' + r.nh + ' 1' : 'ip route ' + r.net + ' ' + lenToMask(r.len) + ' ' + r.nh);
  o.push(asa ? ': end' : 'end'); return o.join('\n');
}
function connText(d) {
  if (!d.conns.length) return '0 in use, 0 most used';
  const nm = k => d.ifs[k].nameif;
  return d.conns.length + ' in use, ' + d.conns.length + ' most used\n' + d.conns.map(c => c.proto.toUpperCase() + ' ' + nm(c.out.if) + ' ' + c.out.dst + ':' + (c.proto === 'icmp' ? 0 : c.out.dport) + ' ' + nm(c.in.if) + ' ' + c.in.src + ':' + (c.proto === 'icmp' ? 0 : c.in.sport) + ', idle 0:00:01, bytes ' + c.hits * 60 + ', flags ' + (c.proto === 'tcp' ? 'UIO' : '-')).join('\n');
}
function xlateText(d) {
  if (!d.xlates.length) return '0 in use, 0 most used';
  const out = []; for (const x of d.xlates) { if (x.real.split(':')[0] !== x.mapped.split(':')[0]) out.push((x.proto === 'icmp' ? 'ICMP' : x.proto.toUpperCase()) + ' PAT from ' + x.real.split(':')[0] + ' to ' + x.mapped.split(':')[0]); if (x.realDst !== x.mappedDst) out.push('NAT (untranslate) mapped ' + x.mappedDst + ' -> real ' + x.realDst); }
  return d.xlates.length + ' in use, ' + d.xlates.length + ' most used\n' + out.join('\n');
}
function ptText(L, d, ni, proto, sip, sp, dip, dp) {
  if (!ifByNameif(d, ni)) return 'ERROR: invalid input interface name: ' + ni;
  if (!isIp(sip) || !isIp(dip)) return 'ERROR: invalid address';
  const r = packetTracer(L, d.name, ni, { proto, src: sip, sport: +sp, dst: dip, dport: +dp });
  const lines = r.trace.map((t, i) => 'Phase: ' + (i + 1) + '\nType: ' + (/NAT/.test(t.t) ? 'NAT' : /ACL|Access Control/.test(t.t) ? 'ACCESS-LIST' : /route|ARP/.test(t.t) ? 'ROUTE-LOOKUP' : 'FLOW') + '\nResult: ' + (t.kind === 'drop' ? 'DROP' : 'ALLOW') + '\nInfo: ' + t.t + '\n');
  const bad = r.o.st === 'drop' || r.o.st === 'noroute';
  return lines.join('\n') + '\nResult:\ninput-interface: ' + ni + '\ninput-status: up\noutput-status: up\naction: ' + (bad ? 'drop\nDrop-reason: ' + r.o.why : 'allow');
}
function doPing(L, d, dst) {
  if (!isIp(dst)) return '% Unrecognized host or address, or protocol not running.';
  const res = []; for (let i = 0; i < 5; i++) res.push(flow(L, d.name, { proto: 'icmp', dst }));
  const ok = res.filter(r => r.ok).length;
  return 'Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ' + dst + ', timeout is 2 seconds:\n' + res.map(r => r.ok ? '!' : r.kind === 'prohibited' || r.kind === 'unreach' ? 'U' : '.').join('') + '\nSuccess rate is ' + ok * 20 + ' percent (' + ok + '/5)' + (ok ? ', round-trip min/avg/max = 1/2/4 ms' : '');
}
function doTrace(L, d, dst) {
  if (!isIp(dst)) return '% Unrecognized host or address';
  return 'Type escape sequence to abort.\nTracing the route to ' + dst + '\nVRF info: (vrf in name/id, vrf out name/id)\n' + traceroute(L, d.name, dst).map(h => '  ' + h.n + ' ' + (h.ip ? h.ip + (h.done ? ' 4 msec 3 msec 4 msec' : ' 2 msec 2 msec 2 msec') : '* * *')).join('\n');
}
function showIfDetail(L, d, only) {
  const names = only ? [only] : Object.keys(d.ifs);
  return names.map(n => { const x = d.ifs[n]; return LONG(n) + ' is ' + (x.up ? 'up' : 'administratively down') + ', line protocol is ' + (x.up ? 'up' : 'down') + '\n  Hardware is iGbE, address is ' + macOf(d.name, n) + ' (bia ' + macOf(d.name, n) + ')\n' + (x.ip ? '  Internet address is ' + x.ip + '/' + x.len + '\n' : '') + (x.nameif ? '  Interface name: ' + x.nameif + ', security-level ' + x.sec + '\n' : '') + '  MTU 1500 bytes, BW 1000000 Kbit/sec\n  Full-duplex, 1000Mb/s\n  5 minute input rate 0 bits/sec, 0 packets/sec'; }).join('\n');
}
function arpText(L, d) {
  const rows = []; for (const x of Object.values(d.ifs)) { if (!x.ip) continue; rows.push('Internet  ' + pad(x.ip, 16) + pad('-', 6) + pad(macOf(d.name, x.name), 16) + 'ARPA   ' + LONG(x.name));
    for (const ep of segment(L, d.name, x.name).eps) { const o = L.dev[ep.dev].ifs[ep.if]; if (o && o.ip && L.dev[ep.dev].on !== false) rows.push('Internet  ' + pad(o.ip, 16) + pad('1', 6) + pad(macOf(ep.dev, ep.if), 16) + 'ARPA   ' + LONG(x.name)); } }
  return pad('Protocol', 10) + pad('Address', 18) + pad('Age (min)', 11) + pad('Hardware Addr', 16) + 'Type   Interface\n' + rows.join('\n');
}
function cdpText(L, d) {
  const rows = []; for (const x of Object.values(d.ifs)) { const p = peerOf(L, d.name, x.name); if (!p) continue; const pd = L.dev[p[0]]; if (!pd || pd.on === false) continue; rows.push(pad(pd.hostname || pd.label, 17) + pad(LONG(x.name).replace('GigabitEthernet', 'Gig '), 18) + pad('150', 11) + pad(pd.type === 'switch' ? 'S I' : pd.type === 'host' ? 'H' : 'R B', 12) + pad(pd.type === 'asa' ? 'ASAv' : pd.type === 'host' ? 'Linux' : 'IOSv', 10) + p[1].replace('Gi', 'Gig ')); }
  return 'Capability Codes: R - Router, S - Switch, H - Host, I - IGMP, B - Source Route Bridge\n\n' + pad('Device ID', 17) + pad('Local Intrfce', 18) + pad('Holdtme', 11) + pad('Capability', 12) + pad('Platform', 10) + 'Port ID\n' + rows.join('\n') + '\n\nTotal cdp entries displayed : ' + rows.length;
}
function macTable(L, d) {
  const rows = []; for (const x of Object.values(d.ifs)) { if (x.svi) continue; for (const ep of segment(L, d.name, x.name).eps) { const m = macOf(ep.dev, ep.if); if (L.dev[ep.dev].on !== false) rows.push(pad(String(x.vlan || 1), 6) + pad(m, 18) + pad('DYNAMIC', 10) + LONG(x.name).replace('GigabitEthernet', 'Gi')); } }
  return '          Mac Address Table\n-------------------------------------------\nVlan    Mac Address       Type        Ports\n----    -----------       --------    -----\n' + rows.join('\n') + '\nTotal Mac Addresses for this criterion: ' + rows.length;
}
function vlanBrief(d) {
  const lines = Object.entries(d.vlans).map(([v, n]) => pad(v, 5) + pad(n, 33) + pad('active', 10) + Object.values(d.ifs).filter(x => !x.svi && (x.vlan || 1) === +v && (x.mode || 'access') === 'access').map(x => SHORT(x.name)).join(', '));
  return 'VLAN Name                             Status    Ports\n---- -------------------------------- --------- -------------------------------\n' + lines.join('\n');
}
function ifStatus(L, d) {
  return pad('Port', 10) + pad('Name', 19) + pad('Status', 13) + pad('Vlan', 11) + pad('Duplex', 8) + pad('Speed', 7) + 'Type\n' + Object.values(d.ifs).filter(x => !x.svi).map(x => { const c = !!peerOf(L, d.name, x.name) && x.up; return pad(SHORT(x.name), 10) + pad(x.desc || '', 19) + pad(!x.up ? 'disabled' : c ? 'connected' : 'notconnect', 13) + pad((x.mode === 'trunk' ? 'trunk' : x.vlan || 1), 11) + pad('a-full', 8) + pad('a-1000', 7) + 'RJ45'; }).join('\n');
}
function verText(d) {
  if (d.type === 'asa') return 'Cisco Adaptive Security Appliance Software Version 9.20(1) (SIMULATED)\nDevice Manager Version 7.20(1)\n\nCompiled by simulator\nSystem image file is "disk0:/asa9-20-1-smp-k8.bin"\nConfig file at boot was "startup-config"\n\n' + d.hostname + ' up 2 hours 14 mins\n\nHardware:   ASAv, 2048 MB RAM, CPU Xeon\nInternal ATA Compact Flash, 1024MB\n' + Object.keys(d.ifs).length + ' GigabitEthernet interfaces\nLicense mode: Smart Licensing (simulated)';
  return 'Cisco IOS-style Software (SIMULATED), ' + (d.type === 'switch' ? 'IOSv-L2' : 'IOSv') + ' Software, Version 15.9(3)M6 (sim)\nTechnical Support: simulator - not real Cisco software\n\nROM: Bootstrap program is IOSv\n' + d.hostname + ' uptime is 2 hours, 14 minutes\nSystem returned to ROM by reload\nSystem image file is "flash0:/vios-adventerprisek9-m"\n\ncisco ' + (d.type === 'switch' ? 'IOSv-L2' : 'IOSv') + ' (revision 1.0) with 984K/62K bytes of memory.\nProcessor board ID 9SIM' + d.name.length + '00' + '\n' + Object.keys(d.ifs).filter(k => !d.ifs[k].svi).length + ' Gigabit Ethernet interfaces\nConfiguration register is 0x0';
}
// ---------- registry ----------
const MODEL = { user: ['U'], priv: ['P', 'U'], config: ['C'], if: ['I', 'C'], acl: ['A', 'C'], line: ['L', 'C'], obj: ['O', 'C'], rtr: ['R', 'C'], vlan: ['V', 'C'], clish: ['K'], diag: ['D'], diagp: ['D'], rad: ['X', 'C'] };
function mkReg() { return []; }
function def(reg, modes, pat, help, fn, noOK) { reg.push({ modes, pat, help, fn, noOK: !!noOK, toks: pat.trim().split(/\s+/).map(w => w[0] === '<' ? (w.endsWith('...>') ? { rest: w.slice(1, -4) } : { arg: w.slice(1, -1) }) : { lit: w.toLowerCase() }) }); }
const REG = { router: mkReg(), switch: mkReg(), asa: mkReg(), ftd: mkReg() };
function regOf(d) { return REG[d.type]; }
function defsFor(d, s) { const L = MODEL[s.mode]; return regOf(d).filter(x => L.some(l => x.modes.includes(l))).map(x => Object.assign({ fallback: !x.modes.includes(L[0]) }, x)); }
function advance(live, t, i) {
  const tl = t.toLowerCase(), exact = [], pref = [], other = [];
  for (const x of live) { const p = x.d.toks[i]; if (!p) continue;
    if (p.rest) other.push({ d: x.d, a: x.a.concat([t]), restAt: i });
    else if (p.arg) other.push({ d: x.d, a: x.a.concat([t]) });
    else if (p.lit === tl) exact.push({ d: x.d, a: x.a }); else if (p.lit.startsWith(tl) && !(p.lit === 'shutdown' && tl.length < 3)) pref.push({ d: x.d, a: x.a }); }
  if (!exact.length && pref.length && new Set(pref.map(x => x.d.toks[i].lit)).size > 1) return { amb: true };
  const res = (exact.length ? exact : pref).concat(other); return res.length ? { live: res } : { bad: true };
}
function parse(defs, toks) {
  let live = defs.map(d => ({ d, a: [] }));
  for (let i = 0; i < toks.length; i++) {
    // rest-consumers swallow everything
    const restDone = live.filter(x => x.restAt !== undefined);
    const norest = live.filter(x => x.restAt === undefined);
    const r = norest.length ? advance(norest, toks[i], i) : { bad: true };
    if (r.amb) return { err: 'amb', at: i };
    let nl = r.live || [];
    for (const x of restDone) { const a = x.a.slice(); a[a.length - 1] = a[a.length - 1] + ' ' + toks[i]; nl.push({ d: x.d, a, restAt: x.restAt }); }
    if (!nl.length) return { err: 'bad', at: i };
    live = nl;
  }
  const full = live.filter(x => x.restAt !== undefined || x.d.toks.length === toks.length);
  if (!full.length) return { err: 'inc' };
  const lc = x => x.d.toks.filter(t => t.lit).length; full.sort((p, q) => lc(q) - lc(p));
  return { ok: full[0] };
}
function splitTokens(line) { const re = /\S+/g, t = [], p = []; let m; while ((m = re.exec(line))) { t.push(m[0]); p.push(m.index); } return { t, p }; }
function pipeFilter(out, spec) {
  const m = /^(include|exclude|begin|section)\s+(.+)$/i.exec(spec.trim()); if (!m) return out; const rx = new RegExp(m[2].trim(), 'i'), ls = out.split('\n');
  if (m[1].toLowerCase() === 'include') return ls.filter(l => rx.test(l)).join('\n'); if (m[1].toLowerCase() === 'exclude') return ls.filter(l => !rx.test(l)).join('\n');
  if (m[1].toLowerCase() === 'begin') { const i = ls.findIndex(l => rx.test(l)); return i < 0 ? '' : ls.slice(i).join('\n'); }
  const res = []; let on = false; for (const l of ls) { if (/^\S/.test(l)) on = rx.test(l); if (on) res.push(l); } return res.join('\n');
}
function newSession(d) { return { mode: d.type === 'host' ? 'host' : d.type === 'ftd' ? 'clish' : 'user', ctx: null }; }
function prompt(d, s) {
  if (d.role === 'ise') return 'ise1/admin# '; if (d.role === 'fmc') return '> '; if (d.role === 'esa') return 'esa1.lab.local> '; if (d.role === 'wsa') return 'wsa1.lab.local> ';
  if (d.type === 'host') return 'lab@' + d.name.toLowerCase() + ':~$ ';
  if (d.type === 'ftd') return s.mode === 'diag' ? 'firepower> ' : s.mode === 'diagp' ? 'firepower# ' : '> ';
  const suf = { user: '>', priv: '#', config: '(config)#', if: d.type === 'asa' ? '(config-if)#' : '(config-if)#', acl: '(config-ext-nacl)#', line: '(config-line)#', obj: '(config-network-object)#', rtr: '(config-router)#', vlan: '(config-vlan)#', rad: '(config-radius-server)#' }[s.mode];
  return d.hostname + suf;
}
function exec(L, d, s, line) {
  if (d.type === 'host') return execHost(L, d, s, line);
  let pipe = null; const pi = line.indexOf('|'); if (pi >= 0) { pipe = line.slice(pi + 1); line = line.slice(0, pi); }
  const out = execLine(L, d, s, line); return pipe ? pipeFilter(out, pipe) : out;
}
const CFGM = ['config', 'if', 'acl', 'line', 'obj', 'rtr', 'vlan', 'rad'];
function execLine(L, d, s, line) {
  const asa = d.type === 'asa', E = asa ? 'ERROR: ' : '';
  const { t: toks, p: pos } = splitTokens(line); if (!toks.length) return '';
  const pl = prompt(d, s).length;
  if (toks.length === 1) { const w = toks[0].toLowerCase();
    if (w === 'end' && CFGM.includes(s.mode)) { s.mode = 'priv'; return ''; }
    if (['ex', 'exi', 'exit', 'logout', 'quit'].includes(w)) {
      if (s.mode === 'diag' || s.mode === 'diagp') { s.mode = 'clish'; return ''; }
      if (s.mode === 'clish') return 'Close this window to leave the FTD console.';
      s.mode = ['if', 'acl', 'line', 'obj', 'rtr', 'vlan', 'rad'].includes(s.mode) ? 'config' : s.mode === 'config' ? 'priv' : s.mode === 'priv' ? 'user' : s.mode; return ''; } }
  let rest = toks, rpos = pos, no = false, doMode = null;
  if (CFGM.includes(s.mode) && /^do$/i.test(toks[0]) && toks.length > 1) { rest = toks.slice(1); rpos = pos.slice(1); doMode = s.mode; s.mode = 'priv'; }
  if (/^no$/i.test(rest[0]) && rest.length > 1) { no = true; rest = rest.slice(1); rpos = rpos.slice(1); }
  const defs = defsFor(d, s).filter(x => !no || x.noOK);
  const r = parse(defs, rest);
  const restoreMode = () => { if (doMode) s.mode = doMode; };
  if (r.err === 'bad') { restoreMode(); let hint = ''; if (s.mode === 'user' && !no) { const pr = defsFor(d, { mode: 'priv' }); if (parse(pr, rest).ok) hint = '\n(hint: this command needs privileged mode - type "enable" first)'; }
    return ' '.repeat(pl + rpos[r.at]) + '^\n' + E + '% Invalid input detected at \'^\' marker.' + hint; }
  if (r.err === 'amb') { restoreMode(); return E + '% Ambiguous command:  "' + line.trim() + '"'; }
  if (r.err === 'inc') { restoreMode(); return E + '% Incomplete command.'; }
  const x = r.ok;
  if (x.d.fallback && s.mode !== 'priv' && !doMode) s.mode = 'config';
  const ctx = { L, d, s, no, a: x.a };
  let res; try { res = x.d.fn(x.a, ctx) || ''; } catch (e) { res = E + '% ' + e.message; }
  restoreMode(); return res;
}
// ---------- help / completion ----------
function nextOptions(L, d, s, line) {
  const trailing = /\s$/.test(line) || !line.trim(); let { t: toks } = splitTokens(line); let partial = ''; if (!trailing && toks.length) partial = toks.pop();
  if (CFGM.includes(s.mode) && toks[0] && /^do$/i.test(toks[0])) toks = toks.slice(1); let no = false; if (toks[0] && /^no$/i.test(toks[0])) { no = true; toks = toks.slice(1); }
  const mode = CFGM.includes(s.mode) && /^\s*do\b/i.test(line) ? 'priv' : s.mode;
  const defs = defsFor(d, Object.assign({}, s, { mode })).filter(x => !no || x.noOK);
  let live = defs.map(x => ({ d: x, a: [] }));
  for (let i = 0; i < toks.length; i++) { const nr = live.filter(x => x.restAt === undefined); const r = nr.length ? advance(nr, toks[i], i) : { bad: true }; if (r.live) live = r.live.concat(live.filter(x => x.restAt !== undefined)); else if (!live.some(x => x.restAt !== undefined)) return { opts: [], partial }; }
  const opts = new Map(); const i = toks.length;
  for (const x of live) { const p = x.d.toks[i]; if (x.restAt !== undefined) { opts.set('<cr>', ''); continue; }
    if (!p) { if (x.d.toks.length === i) opts.set('<cr>', ''); continue; }
    if (p.lit) { if (p.lit.startsWith(partial.toLowerCase())) opts.set(p.lit, WH[p.lit] || x.d.help || ''); }
    else if (!partial || true) opts.set('<' + (p.arg || p.rest) + '>', p.rest ? 'rest of line' : (WH[p.arg] || p.arg)); }
  if (partial) for (const k of [...opts.keys()]) if (k[0] === '<') opts.delete(k);
  return { opts: [...opts.entries()], partial, toks };
}
function help(L, d, s, line) {
  if (d.type === 'host') return 'ip addr | ip route | ping <ip> | traceroute <ip> | curl [-A agent] [-x proxy:port] <url> | nmap [-Pn] [-p ports] <ip> | ifconfig | arp -n | ss -tln | hostname | clear';
  const r = nextOptions(L, d, s, line);
  if (!r.opts.length) return '% Unrecognized command';
  return r.opts.sort((a, b) => a[0] === '<cr>' ? 1 : b[0] === '<cr>' ? -1 : a[0].localeCompare(b[0])).map(([w, h]) => '  ' + pad(w, 24) + h).join('\n');
}
function complete(L, d, s, line) {
  if (d.type === 'host') { const w = ['ping', 'traceroute', 'curl', 'nmap', 'ip', 'ifconfig', 'arp', 'ss', 'hostname', 'help', 'clear', 'uname', 'whoami']; const p = line.trim(); const m = w.filter(x => x.startsWith(p)); return m.length === 1 ? { line: m[0] + ' ' } : { options: m }; }
  const r = nextOptions(L, d, s, line); const words = r.opts.map(o => o[0]).filter(w => w[0] !== '<');
  if (!words.length) return {}; const pre = line.slice(0, line.length - r.partial.length);
  if (words.length === 1) return { line: pre + words[0] + ' ' };
  let cp = words[0]; for (const w of words) while (!w.startsWith(cp)) cp = cp.slice(0, -1);
  return { line: pre + (cp.length > r.partial.length ? cp : r.partial), options: words };
}
function suggest(d, s) {
  const t = d.type;
  if (d.role === 'ise') return ['show version', 'show application status ise', 'ping 192.168.100.23', 'help'];
  if (d.role === 'fmc') return ['show version', 'show managed-devices', 'help'];
  if (d.role === 'esa' || d.role === 'wsa') return ['status', 'version', 'help'];
  if (t === 'host') return ['ip addr', 'ip route', 'ping 198.51.100.10', 'curl http://172.16.1.10', 'curl -x 172.16.1.30:3128 http://www.facebook.com', 'traceroute 198.51.100.10', 'nmap -Pn 203.0.113.10', 'swaks --to alice@lab.local --from bob@partner.com --server 203.0.113.20 --header "Subject: hello" --body "hi"', 'help'];
  if (t === 'ftd') return s.mode.startsWith('diag') ? ['show interface ip brief', 'show route', 'show conn', 'show xlate', 'show access-list', 'exit'] : ['show version', 'show managers', 'show network', 'system support diagnostic-cli', '?'];
  const common = ['?'];
  if (s.mode === 'user') return ['enable', 'show version', t === 'asa' ? 'show interface ip brief' : 'show ip interface brief', t === 'switch' ? 'show vlan brief' : 'show ip route'].concat(common);
  if (s.mode === 'priv') return t === 'asa' ? ['show interface ip brief', 'show route', 'show access-list', 'show nat', 'show xlate', 'show conn', 'show running-config', 'packet-tracer input outside tcp 198.51.100.10 1234 203.0.113.10 80', 'configure terminal'] :
    t === 'switch' ? ['show vlan brief', 'show mac address-table', 'show interfaces status', 'show running-config', 'show cdp neighbors', 'configure terminal'] :
    ['show ip interface brief', 'show ip route', 'show running-config', 'show access-lists', 'show arp', 'show cdp neighbors', 'ping 10.1.1.1', 'traceroute 198.51.100.10', 'configure terminal'];
  if (s.mode === 'config') return t === 'asa' ? ['interface GigabitEthernet0/0', 'object network DMZ-WEB', 'access-list OUT-IN extended permit tcp any any eq 80', 'access-group OUT-IN in interface outside', 'route outside 0.0.0.0 0.0.0.0 203.0.113.2', 'hostname', 'end'] : t === 'switch' ? ['vlan 20', 'interface GigabitEthernet0/2', 'hostname', 'end'] : ['interface GigabitEthernet0/1', 'ip route 0.0.0.0 0.0.0.0 10.1.1.1', 'ip access-list extended BLOCK', 'hostname', 'end'];
  return t === 'asa' ? ['nameif', 'security-level 50', 'ip address', 'no shutdown', 'host', 'subnet', 'nat (inside,outside) dynamic interface', 'exit'] : ['ip address', 'ip access-group', 'no shutdown', 'permit ip any any', 'deny tcp any any eq 80', 'description', 'switchport mode access', 'exit'];
}

// ---------- shared handler builders ----------
const Rg = REG.router, Sw = REG.switch, As = REG.asa, Ft = REG.ftd;
function both(modes, pat, help, fn, noOK) { def(Rg, modes, pat, help, fn, noOK); def(Sw, modes, pat, help, fn, noOK); }
function store(c, line) { const { d, s, no } = c; const arr = s.mode === 'config' ? (d.extra = d.extra || []) : s.mode === 'if' ? (d.ifs[s.ctx].extra = d.ifs[s.ctx].extra || []) : ((d.sub = d.sub || {})[s.ctx] = (d.sub[s.ctx] || [])); const i = arr.indexOf(line);
  if (no) { if (i >= 0) arr.splice(i, 1); } else if (i < 0) arr.push(line); return ''; }
const saveIos = (a, c) => { c.d.startup = runCfg(c.d); return 'Building configuration...\n[OK]'; };
function iosCommon(reg) {
  const D = (m, p, h, f, n) => def(reg, m, p, h, f, n);
  D('U', 'enable', 'Turn on privileged commands', (a, c) => { c.s.mode = 'priv'; return ''; });
  D('P', 'disable', 'Turn off privileged commands', (a, c) => { c.s.mode = 'user'; return ''; });
  D('U', 'show version', 'System hardware and software status', (a, c) => verText(c.d));
  D('U', 'show clock', 'Display the system clock', () => new Date().toUTCString().replace('GMT', 'UTC'));
  D('U', 'show ip interface brief', 'Brief summary of IP status and configuration', (a, c) => ifBrief(c.d));
  D('U', 'show interfaces', 'Interface status and configuration', (a, c) => showIfDetail(c.L, c.d));
  D('U', 'show interfaces <name...>', 'Interface status', (a, c) => { const n = normIf(c.d, a[0].replace(/\s+/g, '')); return n ? showIfDetail(c.L, c.d, n) : '% Invalid interface'; });
  D('U', 'show running-config', 'Current operating configuration', (a, c) => runCfg(c.d));
  D('U', 'show startup-config', 'Contents of startup configuration', (a, c) => c.d.startup || 'startup-config is not present');
  D('U', 'show arp', 'ARP table', (a, c) => arpText(c.L, c.d)); D('U', 'show ip arp', 'IP ARP table', (a, c) => arpText(c.L, c.d));
  D('U', 'show cdp neighbors', 'CDP neighbor entries', (a, c) => cdpText(c.L, c.d));
  D('U', 'show users', 'Display information about terminal lines', (a, c) => '    Line       User       Host(s)              Idle       Location\n*  0 con 0                idle                 00:00:00');
  D('U', 'show history', 'Display the session command history', () => '(history is kept in the terminal: use the Up arrow)');
  D('U', 'show logging', 'Show the contents of logging buffers', (a, c) => 'Syslog logging: enabled\n    Console logging: level debugging\n    Buffer logging: level debugging, 12 messages logged\nLog Buffer (8192 bytes):\n%SYS-5-CONFIG_I: Configured from console by console');
  D('U', 'show flash', 'Display information about flash', () => 'Directory of flash0:/\n    2  -rw-  vios-adventerprisek9-m (simulated)');
  D('U', 'ping <ip>', 'Send echo messages', (a, c) => doPing(c.L, c.d, a[0])); D('U', 'traceroute <ip>', 'Trace route to destination', (a, c) => doTrace(c.L, c.d, a[0]));
  D('U', 'terminal length <n>', 'Set number of lines on a screen', () => ''); D('U', 'terminal monitor', 'Copy debug output to the current terminal', () => '');
  D('P', 'configure terminal', 'Configure from the terminal', (a, c) => { c.s.mode = 'config'; return 'Enter configuration commands, one per line.  End with CNTL/Z.'; });
  D('P', 'write memory', 'Write to NV memory', saveIos); D('P', 'write', 'Write running configuration to memory', saveIos); D('P', 'copy running-config startup-config', 'Copy running config to startup', saveIos);
  D('P', 'erase startup-config', 'Erase the startup configuration', (a, c) => { c.d.startup = null; return 'Erasing the nvram filesystem will remove all configuration files! [simulated] [OK]'; });
  D('P', 'reload', 'Halt and perform a cold restart', () => 'Proceed with reload? [confirm]  (simulator: reload is not performed; use Reset lab to restart)');
  D('P', 'clear counters', 'Clear counters', () => 'Clear "show interface" counters on all interfaces [confirm] [OK]');
  D('P', 'clear arp-cache', 'Clear the entire ARP cache', () => '');
  D('C', 'hostname <name>', 'Set the hostname', (a, c) => { c.d.hostname = a[0]; return ''; });
  D('C', 'enable secret <pw>', 'Assign the privileged level secret', (a, c) => store(c, 'enable secret ' + a[0]), true); D('C', 'enable password <pw>', 'Assign the privileged level password', (a, c) => store(c, 'enable password ' + a[0]), true);
  D('C', 'username <u> privilege <n> secret <pw>', 'Establish User Name Authentication', (a, c) => store(c, 'username ' + a[0] + ' privilege ' + a[1] + ' secret ' + a[2]), true);
  D('C', 'username <u> secret <pw>', 'Establish User Name Authentication', (a, c) => store(c, 'username ' + a[0] + ' secret ' + a[1]), true); D('C', 'username <u> password <pw>', 'Establish User Name Authentication', (a, c) => store(c, 'username ' + a[0] + ' password ' + a[1]), true);
  D('C', 'banner motd <text...>', 'Set Message of the Day banner', (a, c) => store(c, 'banner motd ' + a[0]), true); D('C', 'service <x...>', 'Modify use of network based services', (a, c) => store(c, 'service ' + a[0]), true);
  D('C', 'logging <x...>', 'Modify message logging facilities', (a, c) => store(c, 'logging ' + a[0]), true); D('C', 'ntp <x...>', 'Configure NTP', (a, c) => store(c, 'ntp ' + a[0]), true);
  D('C', 'snmp-server <x...>', 'Modify SNMP engine parameters', (a, c) => store(c, 'snmp-server ' + a[0]), true); D('C', 'cdp <x...>', 'Global CDP configuration subcommands', (a, c) => store(c, 'cdp ' + a[0]), true);
  D('C', 'lldp <x...>', 'Global LLDP configuration subcommands', (a, c) => store(c, 'lldp ' + a[0]), true); D('C', 'aaa <x...>', 'Authentication, Authorization and Accounting', (a, c) => store(c, 'aaa ' + a[0]), true);
  D('C', 'clock <x...>', 'Configure time-of-day clock', (a, c) => store(c, 'clock ' + a[0]), true); D('C', 'spanning-tree <x...>', 'Spanning Tree Subsystem', (a, c) => store(c, 'spanning-tree ' + a[0]), true);
  D('C', 'crypto key generate rsa', 'Generate RSA keys', () => 'The name for the keys will be: (simulated)\n% The key modulus size is 2048 bits\n% Generating 2048 bit RSA keys, keys will be non-exportable...[OK]');
  D('C', 'crypto key generate rsa modulus <n>', 'Generate RSA keys', () => '% Generating RSA keys...[OK]');
  D('C', 'ip domain-name <name>', 'Define the default domain name', (a, c) => store(c, 'ip domain name ' + a[0]), true); D('C', 'ip domain-lookup', 'Enable IP Domain Name System hostname translation', (a, c) => store(c, 'no ip domain-lookup'), true);
  D('C', 'ip ssh <x...>', 'Configure SSH parameters', (a, c) => store(c, 'ip ssh ' + a[0]), true); D('C', 'ip http server', 'HTTP server', (a, c) => store(c, 'ip http server'), true);
  D('C', 'ip http secure-server', 'Enable HTTP secure server', (a, c) => store(c, 'ip http secure-server'), true); D('C', 'ip http authentication <x...>', 'Set http server authentication method', (a, c) => store(c, 'ip http authentication ' + a[0]), true);
  D('C', 'ip name-server <ip>', 'Specify address of name server', (a, c) => store(c, 'ip name-server ' + a[0]), true); D('C', 'ip cef', 'Cisco Express Forwarding', () => ''); D('C', 'ip classless', 'Follow classless routing forwarding rules', () => '');
  D('C', 'ip dhcp <x...>', 'Configure DHCP server and relay parameters', (a, c) => store(c, 'ip dhcp ' + a[0]), true);
  D('C', 'router <x...>', 'Enable a routing process', (a, c) => { c.s.mode = 'rtr'; c.s.ctx = 'router ' + a[0]; return '[simulator] Dynamic routing protocols are NOT simulated - this command is accepted but no routes are exchanged. Use static routes.'; }, true);
  D('C', 'interface <name...>', 'Select an interface to configure', (a, c) => { const n = normIf(c.d, a[0].replace(/\s+/g, '')); if (!n) return '% Invalid interface type and number'; c.s.mode = 'if'; c.s.ctx = n; return ''; });
  D('C', 'ip access-list extended <name>', 'Extended Access List', (a, c) => { if (c.no) { delete c.d.acls[a[0]]; return ''; } c.d.acls[a[0]] = c.d.acls[a[0]] || []; c.s.mode = 'acl'; c.s.ctx = a[0]; return ''; }, true);
  D('C', 'access-list <num> permit <rule...>', 'Add a permit entry', (a, c) => aclAdd(c, a[0], 'permit', a[1]), true); D('C', 'access-list <num> deny <rule...>', 'Add a deny entry', (a, c) => aclAdd(c, a[0], 'deny', a[1]), true);
  D('A', 'permit <rule...>', 'Specify packets to forward', (a, c) => aclAdd(c, c.s.ctx, 'permit', a[0]), true); D('A', 'deny <rule...>', 'Specify packets to reject', (a, c) => aclAdd(c, c.s.ctx, 'deny', a[0]), true);
  D('A', '<seq> permit <rule...>', 'Sequence number + permit', (a, c) => aclAdd(c, c.s.ctx, 'permit', a[1]), true); D('A', '<seq> deny <rule...>', 'Sequence number + deny', (a, c) => aclAdd(c, c.s.ctx, 'deny', a[1]), true);
  D('A', 'remark <text...>', 'Access list entry comment', () => '');
  D('L', 'login local', 'Local password checking', (a, c) => store(c, 'login local'), true); D('L', 'login', 'Enable password checking', (a, c) => store(c, 'login'), true);
  D('L', 'password <pw>', 'Set a password', (a, c) => store(c, 'password ' + a[0]), true); D('L', 'transport input <x...>', 'Define which protocols to use when connecting to the terminal server', (a, c) => store(c, 'transport input ' + a[0]), true);
  D('L', 'exec-timeout <x...>', 'Set the EXEC timeout', (a, c) => store(c, 'exec-timeout ' + a[0]), true); D('L', 'logging synchronous', 'Synchronous logging of unsolicited messages', (a, c) => store(c, 'logging synchronous'), true);
  D('C', 'line console <n>', 'Primary terminal line', (a, c) => { c.s.mode = 'line'; c.s.ctx = 'line con ' + a[0]; return ''; }); D('C', 'line vty <a> <b>', 'Virtual terminal', (a, c) => { c.s.mode = 'line'; c.s.ctx = 'line vty ' + a[0] + ' ' + a[1]; return ''; });
  D('R', '<x...>', 'Routing process subcommand', (a, c) => store(c, a[0]), true);
  D('I', 'description <text...>', 'Interface specific description', (a, c) => { c.d.ifs[c.s.ctx].desc = c.no ? '' : a[0]; return ''; }, true);
  D('I', 'shutdown', 'Shutdown the selected interface', (a, c) => { c.d.ifs[c.s.ctx].up = c.no; return ''; }, true);
  D('I', 'duplex <x>', 'Configure duplex operation', (a, c) => store(c, 'duplex ' + a[0]), true); D('I', 'speed <x>', 'Configure speed operation', (a, c) => store(c, 'speed ' + a[0]), true);
  D('I', 'cdp enable', 'Enable CDP on interface', () => ''); D('I', 'negotiation auto', 'Negotiation', () => '');
}
function aclAdd(c, name, action, rule) {
  const { d, no } = c; if (!d.acls[name]) { if (no) return ''; d.acls[name] = []; }
  try { const e = parseAclTokens(rule.split(/\s+/), 'ios'); e.action = action; e.hits = 0;
    if (no) d.acls[name] = d.acls[name].filter(x => aclText(x, 'ios') !== aclText(e, 'ios')); else d.acls[name].push(e); return ''; } catch (err) { return err.message; }
}
iosCommon(Rg); iosCommon(Sw);
// router-only
function runView(d, what) { const full = runCfg(d); const w = what.trim().split(/\s+/); const k = w[0].toLowerCase();
  if (k === 'nat') return pipeFilter(full, 'include nat'); if (k === 'interface') { const n = normIf(d, w.slice(1).join('')); return n ? pipeFilter(full, 'section ^interface ' + (d.type === 'asa' || true ? LONG(n) : n) + '$') : '% Invalid interface'; }
  return pipeFilter(full, 'section ^' + k); }
for (const r of [Rg, Sw, As, Ft]) def(r, r === Ft ? 'D' : 'U', 'show running-config <what...>', 'Show part of the configuration', (a, c) => runView(c.d, a[0]));
def(Rg, 'C', 'ip route <net> <mask> <nh>', 'Establish static routes', (a, c) => { const [n, m, nh] = a; if (!isIp(n) || !isIp(m) || !isIp(nh)) return '% Invalid address'; const len = maskToLen(m); c.d.routes = c.d.routes.filter(r => !(r.net === n && r.len === len)); if (!c.no) c.d.routes.push({ net: n, len, nh }); return ''; }, true);
def(Rg, 'U', 'show ip route', 'IP routing table', (a, c) => routeText(c.d)); def(Rg, 'U', 'show ip route <ip>', 'Routing entry', (a, c) => { const r = routeLookup(c.d, a[0]); return r ? 'Routing entry for ' + a[0] + '\n  Known via "' + (r.kind === 'C' ? 'connected' : 'static') + '"' + (r.nh ? ', via ' + r.nh : '') + ', ' + r.if : '% Network not in table'; });
def(Rg, 'U', 'show ip protocols', 'IP routing protocol process parameters', () => '*** IP Routing is NSF aware ***\n(no dynamic routing protocols configured / simulated)');
def(Rg, 'U', 'show access-lists', 'List access lists', (a, c) => aclShow(c.d, null, 'ios')); def(Rg, 'U', 'show access-lists <name>', 'List access lists', (a, c) => aclShow(c.d, a[0], 'ios'));
def(Rg, 'U', 'show ip access-lists', 'List IP access lists', (a, c) => aclShow(c.d, null, 'ios')); def(Rg, 'U', 'show ip access-lists <name>', 'List IP access lists', (a, c) => aclShow(c.d, a[0], 'ios'));
def(Rg, 'U', 'show ip nat translations', 'Translation entries', () => '(no NAT configured on this router)');
def(Rg, 'I', 'ip address <ip> <mask>', 'Set the IP address of an interface', (a, c) => { const x = c.d.ifs[c.s.ctx]; if (c.no) { x.ip = null; return ''; } if (!isIp(a[0]) || !isIp(a[1])) return '% Invalid IP address'; x.ip = a[0]; x.len = maskToLen(a[1]); return ''; }, true);
def(Rg, 'I', 'ip access-group <name> <dir>', 'Specify access control for packets', (a, c) => { const x = c.d.ifs[c.s.ctx], k = /^o/i.test(a[1]) ? 'aclOut' : 'aclIn'; if (c.no) delete x[k]; else x[k] = a[0]; return ''; }, true);
def(Rg, 'I', 'ip nat <x>', 'NAT interface commands', (a, c) => store(c, 'ip nat ' + a[0]), true); def(Rg, 'I', 'ip helper-address <ip>', 'Specify a destination address for UDP broadcasts', (a, c) => store(c, 'ip helper-address ' + a[0]), true);
// switch-only
def(Sw, 'U', 'show vlan brief', 'VTP all VLAN status in brief', (a, c) => vlanBrief(c.d)); def(Sw, 'U', 'show vlan', 'VTP all VLAN status', (a, c) => vlanBrief(c.d));
def(Sw, 'U', 'show mac address-table', 'MAC forwarding table', (a, c) => macTable(c.L, c.d)); def(Sw, 'U', 'show interfaces status', 'Interface line status', (a, c) => ifStatus(c.L, c.d));
def(Sw, 'U', 'show interfaces trunk', 'Interface trunk information', (a, c) => 'Port        Mode             Encapsulation  Status        Native vlan\n' + Object.values(c.d.ifs).filter(x => x.mode === 'trunk').map(x => pad(SHORT(x.name), 12) + 'on               802.1q         trunking      1').join('\n'));
def(Sw, 'U', 'show spanning-tree', 'Spanning tree topology', (a, c) => 'VLAN0001\n  Spanning tree enabled protocol rstp\n  This bridge is the root (simulated)');
def(Sw, 'C', 'vlan <id>', 'VLAN commands', (a, c) => { if (c.no) { delete c.d.vlans[a[0]]; return ''; } c.d.vlans[a[0]] = c.d.vlans[a[0]] || 'VLAN' + String(a[0]).padStart(4, '0'); c.s.mode = 'vlan'; c.s.ctx = a[0]; return ''; }, true);
def(Sw, 'V', 'name <n>', 'Ascii name of the VLAN', (a, c) => { c.d.vlans[c.s.ctx] = a[0]; return ''; });
def(Sw, 'I', 'switchport mode <m>', 'Set trunking mode of the interface', (a, c) => { c.d.ifs[c.s.ctx].mode = /^t/i.test(a[0]) ? 'trunk' : 'access'; return ''; }, true);
def(Sw, 'I', 'switchport access vlan <id>', 'Set VLAN when interface is in access mode', (a, c) => { if (!c.d.vlans[a[0]]) c.d.vlans[a[0]] = 'VLAN' + String(a[0]).padStart(4, '0'); c.d.ifs[c.s.ctx].vlan = c.no ? 1 : +a[0]; return ''; }, true);
def(Sw, 'I', 'switchport trunk <x...>', 'Set trunking characteristics', (a, c) => store(c, 'switchport trunk ' + a[0]), true); def(Sw, 'I', 'spanning-tree <x...>', 'Spanning Tree Subsystem', (a, c) => store(c, 'spanning-tree ' + a[0]), true);
def(Sw, 'I', 'ip address <ip> <mask>', 'Set the IP address of an SVI', (a, c) => { const x = c.d.ifs[c.s.ctx]; if (!x.svi) return '% Invalid input detected (L2 port: use "interface vlan <id>")'; if (c.no) { x.ip = null; return ''; } x.ip = a[0]; x.len = maskToLen(a[1]); return ''; }, true);
def(Sw, 'C', 'aaa new-model', 'Enable NEW access control commands and functions', (a, c) => { c.d.aaa = !c.no; return ''; }, true);
def(Sw, 'C', 'dot1x system-auth-control', 'Enable or disable 802.1X globally', (a, c) => { c.d.dot1xGlobal = !c.no; return ''; }, true);
def(Sw, 'C', 'radius server <name>', 'Configure a RADIUS server', (a, c) => { c.d.radius = c.d.radius || {}; c.d.radius.name = a[0]; c.s.mode = 'rad'; c.s.ctx = 'radius server ' + a[0]; return ''; });
def(Sw, 'X', 'address ipv4 <ip> auth-port <p> acct-port <q>', 'Specify the RADIUS server address', (a, c) => { c.d.radius.ip = a[0]; return ''; }, true); def(Sw, 'X', 'address ipv4 <ip>', 'Specify the RADIUS server address', (a, c) => { c.d.radius.ip = a[0]; return ''; }, true);
def(Sw, 'X', 'key <secret>', 'Per-server encryption key', (a, c) => { c.d.radius.key = a[0]; return ''; }, true);
def(Sw, 'C', 'radius-server host <ip> key <secret>', 'Specify a RADIUS server (legacy)', (a, c) => { c.d.radius = { name: 'legacy', ip: a[0], key: a[1] }; return ''; }, true);
def(Sw, 'I', 'authentication port-control <m>', 'Set the port-control value', (a, c) => { const x = c.d.ifs[c.s.ctx]; if (/^a/i.test(a[0]) && !c.no) x.auth = 'auto'; else { x.auth = 'open'; x.state = 'authorized'; } return ''; }, true);
def(Sw, 'I', 'dot1x pae authenticator', 'Set the 802.1X port access entity', (a, c) => store(c, 'dot1x pae authenticator'), true); def(Sw, 'I', 'mab', 'MAC Authentication Bypass', (a, c) => store(c, 'mab'), true);
def(Sw, 'I', 'authentication order <x...>', 'Set the order of authentication methods', (a, c) => store(c, 'authentication order ' + a[0]), true); def(Sw, 'I', 'authentication host-mode <x...>', 'Set the host mode', (a, c) => store(c, 'authentication host-mode ' + a[0]), true);
def(Sw, 'I', 'authentication periodic', 'Enable re-authentication', (a, c) => store(c, 'authentication periodic'), true);
function nacRows(d) { return Object.values(d.ifs).filter(x => x.auth === 'auto').map(x => [x.name, x]); }
def(Sw, 'U', 'show authentication sessions', 'Authentication Manager session information', (a, c) => { const r = nacRows(c.d); if (!r.length) return 'No sessions present'; return pad('Interface', 12) + pad('MAC Address', 16) + pad('Method', 8) + pad('Domain', 8) + pad('Status', 24) + 'User / Policy\n' + r.map(([n, x]) => pad(SHORT(n), 12) + pad('(client)', 16) + pad(x.user ? 'dot1x' : '-', 8) + pad('DATA', 8) + pad(x.state === 'authorized' ? 'Auth' : x.state === 'quarantine' ? 'Auth (quarantine)' : 'Unauth', 24) + (x.user || '') + (x.profile ? ' [' + x.profile + ']' : '')).join('\n'); });
def(Sw, 'U', 'show authentication sessions interface <name...>', 'Session on one interface', (a, c) => { const n = normIf(c.d, a[0].replace(/\s+/g, '')); const x = n && c.d.ifs[n]; if (!x) return '% Invalid interface'; return 'Interface:  ' + LONG(n) + '\n  Status:  ' + (x.state === 'authorized' ? 'Authorized' : x.state === 'quarantine' ? 'Authorized (quarantine VLAN)' : x.auth === 'auto' ? 'Unauthorized' : 'port-control force-authorized') + '\n  User-Name: ' + (x.user || '-') + '\n  Policy: ' + (x.profile || '-') + '\n  ACS ACL: ' + (x.dacl ? 'xACSACLx-IP-dACL (' + x.dacl.length + ' ACEs)' : '-') + '\n  Vlan: ' + (x.vlan || 1); });
def(Sw, 'U', 'show dot1x all', 'Show dot1x information for all interfaces', (a, c) => 'Sysauthcontrol              ' + (c.d.dot1xGlobal ? 'Enabled' : 'Disabled') + '\nDot1x Info for ' + (nacRows(c.d).map(([n]) => LONG(n)).join(', ') || '(no ports in auto mode)'));
def(Sw, 'U', 'show aaa servers', 'Show AAA server status', (a, c) => c.d.radius && c.d.radius.ip ? 'RADIUS: id 1, priority 1, host ' + c.d.radius.ip + ', auth-port 1812, acct-port 1813\n     State: current UP' : 'No RADIUS servers configured');
def(Sw, 'C', 'ip default-gateway <ip>', 'Specify default gateway', (a, c) => store(c, 'ip default-gateway ' + a[0]), true);
// ---------- ASA ----------
function asaShow(reg, U_) {
  const D = (m, p, h, f, n) => def(reg, U_, p, h, f, n);
  D('U', 'show version', 'System hardware and software status', (a, c) => verText(c.d)); D('U', 'show clock', 'Display the system clock', () => new Date().toUTCString().replace('GMT', 'UTC'));
  D('U', 'show interface ip brief', 'Interface IP summary', (a, c) => ifBriefAsa(c.d)); D('U', 'show interface', 'Interface status', (a, c) => showIfDetail(c.L, c.d));
  D('U', 'show nameif', 'Interface names and levels', (a, c) => pad('Interface', 24) + pad('Name', 16) + 'Security\n' + Object.values(c.d.ifs).map(x => pad(LONG(x.name), 24) + pad(x.nameif, 16) + x.sec).join('\n'));
  D('U', 'show running-config', 'Current operating configuration', (a, c) => runCfg(c.d)); D('U', 'show route', 'Routing table', (a, c) => routeText(c.d, true));
  D('U', 'show access-list', 'Access list', (a, c) => aclShow(c.d, null, 'asa')); D('U', 'show access-list <name>', 'Access list', (a, c) => aclShow(c.d, a[0], 'asa'));
  D('U', 'show xlate', 'NAT translations', (a, c) => xlateText(c.d)); D('U', 'show conn', 'Connection table', (a, c) => connText(c.d)); D('U', 'show conn count', 'Connection count', (a, c) => c.d.conns.length + ' in use, ' + c.d.conns.length + ' most used');
  D('U', 'show nat', 'NAT policies', (a, c) => c.d.nats.length ? 'Auto NAT Policies (Section 2)\n' + c.d.nats.map((n, i) => (i + 1) + ' (' + n.realIf + ') to (' + n.mappedIf + ') source ' + n.kind + ' ' + n.obj + ' ' + n.mapped + '\n    translate_hits = ' + (c.d.xlates.length) + ', untranslate_hits = 0').join('\n') : '(no NAT policies)');
  D('U', 'show arp', 'ARP table', (a, c) => Object.values(c.d.ifs).flatMap(x => segment(c.L, c.d.name, x.name).eps.map(ep => (x.nameif || x.name) + ' ' + (c.L.dev[ep.dev].ifs[ep.if].ip || '') + ' ' + macOf(ep.dev, ep.if) + ' 1')).join('\n'));
  D('U', 'show logging', 'Logging', () => 'Syslog logging: enabled\n    Timestamp logging: disabled\n    Buffer logging: level informational, 8 messages logged');
  D('U', 'show asp drop', 'Accelerated security path drop counters', (a, c) => 'Frame drop:\n  Flow is denied by access rule (acl-drop)   ' + Object.values(c.d.acls).reduce((n, es) => n, 0) + '\n  (simulated counters - use packet-tracer for drop reasons)');
  D('U', 'ping <ip>', 'Send ICMP echo', (a, c) => doPing(c.L, c.d, a[0])); D('U', 'ping <if> <ip>', 'Send ICMP echo via interface', (a, c) => doPing(c.L, c.d, a[1]));
  D('U', 'traceroute <ip>', 'Trace route', (a, c) => doTrace(c.L, c.d, a[0]));
  D('U', 'packet-tracer input <if> <proto> <sip> <sport> <dip> <dport>', 'Trace a packet through the ASA', (a, c) => ptText(c.L, c.d, a[0], a[1].toLowerCase(), a[2], a[3], a[4], a[5]));
  D('U', 'packet-tracer input <if> icmp <sip> <type> <code> <dip>', 'Trace an ICMP packet', (a, c) => ptText(c.L, c.d, a[0], 'icmp', a[1], 0, a[4], 0));
}
asaShow(As, 'U');
const savA = (a, c) => { c.d.startup = runCfg(c.d); return 'Building configuration...\nCryptochecksum: ' + (c.d.hostname.length * 99991).toString(16) + '\n[OK]'; };
def(As, 'U', 'enable', 'Turn on privileged commands', (a, c) => { c.s.mode = 'priv'; return ''; }); def(As, 'P', 'disable', 'Turn off privileged commands', (a, c) => { c.s.mode = 'user'; return ''; });
def(As, 'P', 'configure terminal', 'Configure using terminal', (a, c) => { c.s.mode = 'config'; return ''; });
def(As, 'P', 'write memory', 'Save the running configuration', savA); def(As, 'P', 'copy running-config startup-config', 'Copy running to startup', savA);
def(As, 'P', 'clear xlate', 'Clear NAT translations', (a, c) => { c.d.xlates.length = 0; return ''; }); def(As, 'P', 'clear conn', 'Clear connections', (a, c) => { c.d.conns.length = 0; c.d.xlates.length = 0; return ''; });
def(As, 'P', 'clear access-list', 'Clear access-list counters', (a, c) => { Object.values(c.d.acls).forEach(es => es.forEach(e => e.hits = 0)); return ''; });
def(As, 'P', 'clear configure access-list <name>', 'Delete an access-list', (a, c) => { delete c.d.acls[a[0]]; return ''; });
def(As, 'P', 'reload', 'Reload the system', () => 'Proceed with reload? [confirm] (simulator: not performed)');
def(As, 'C', 'hostname <name>', 'Set the hostname', (a, c) => { c.d.hostname = a[0]; return ''; });
def(As, 'C', 'domain-name <n>', 'Set the default domain name', (a, c) => store(c, 'domain-name ' + a[0]), true); def(As, 'C', 'enable password <pw>', 'Set enable password', (a, c) => store(c, 'enable password ' + a[0]), true);
def(As, 'C', 'username <u> password <pw> privilege <n>', 'Create a user', (a, c) => store(c, 'username ' + a[0] + ' password ' + a[1] + ' privilege ' + a[2]), true); def(As, 'C', 'username <u> password <pw>', 'Create a user', (a, c) => store(c, 'username ' + a[0] + ' password ' + a[1]), true);
for (const w of ['aaa', 'http', 'ssh', 'telnet', 'logging', 'ntp', 'snmp-server', 'crypto', 'policy-map', 'class-map', 'service-policy', 'dhcpd', 'icmp', 'threat-detection', 'asdm', 'mtu', 'failover', 'same-security-traffic', 'timeout', 'dns', 'names', 'service', 'clock', 'webvpn', 'group-policy', 'tunnel-group']) def(As, 'C', w + ' <x...>', WH[w] || 'Configuration command', (a, c) => store(c, w + ' ' + a[0]), true);
def(As, 'C', 'interface <name...>', 'Select an interface', (a, c) => { const n = normIf(c.d, a[0].replace(/\s+/g, '')); if (!n) return 'ERROR: invalid interface name'; c.s.mode = 'if'; c.s.ctx = n; return ''; });
def(As, 'I', 'nameif <n>', 'Assign name to interface', (a, c) => { c.d.ifs[c.s.ctx].nameif = a[0]; return ''; }, true); def(As, 'I', 'security-level <n>', 'Set security level', (a, c) => { c.d.ifs[c.s.ctx].sec = +a[0]; return ''; }, true);
def(As, 'I', 'ip address <ip> <mask>', 'Set the IP address', (a, c) => { const x = c.d.ifs[c.s.ctx]; if (c.no) { x.ip = null; return ''; } if (!isIp(a[0]) || !isIp(a[1])) return 'ERROR: invalid address'; x.ip = a[0]; x.len = maskToLen(a[1]); return ''; }, true);
def(As, 'I', 'shutdown', 'Shut down the interface', (a, c) => { c.d.ifs[c.s.ctx].up = c.no; return ''; }, true); def(As, 'I', 'description <t...>', 'Interface description', (a, c) => { c.d.ifs[c.s.ctx].desc = a[0]; return ''; }, true);
def(As, 'I', 'speed <x>', 'Speed', () => ''); def(As, 'I', 'duplex <x>', 'Duplex', () => ''); def(As, 'I', 'management-only', 'Management only', () => '');
def(As, 'C', 'route <if> <net> <mask> <gw>', 'Configure a static route', (a, c) => { const x = ifByNameif(c.d, a[0]); if (!x) return 'ERROR: interface "' + a[0] + '" not found'; if (!isIp(a[1]) || !isIp(a[2]) || !isIp(a[3])) return 'ERROR: invalid address'; const len = maskToLen(a[2]); c.d.routes = c.d.routes.filter(r => !(r.net === a[1] && r.len === len)); if (!c.no) c.d.routes.push({ net: a[1], len, nh: a[3], nameif: a[0] }); return ''; }, true);
def(As, 'C', 'route <if> <net> <mask> <gw> <metric>', 'Configure a static route', (a, c) => { const x = ifByNameif(c.d, a[0]); if (!x) return 'ERROR: interface "' + a[0] + '" not found'; const len = maskToLen(a[2]); c.d.routes = c.d.routes.filter(r => !(r.net === a[1] && r.len === len)); if (!c.no) c.d.routes.push({ net: a[1], len, nh: a[3], nameif: a[0] }); return ''; }, true);
function asaAcl(c, name, rule) { const { d, no } = c; const r = rule.split(/\s+/); let act = r.shift(); if (act === 'line') { r.shift(); act = r.shift(); } if (act === 'extended') act = r.shift();
  if (!['permit', 'deny'].includes(act)) return 'ERROR: invalid action'; try { const e = parseAclTokens(r, 'asa'); e.action = act; e.hits = 0; d.acls[name] = d.acls[name] || [];
    if (no) d.acls[name] = d.acls[name].filter(x => aclText(x, 'asa') !== aclText(e, 'asa')); else d.acls[name].push(e); return ''; } catch (err) { return 'ERROR: ' + err.message; } }
def(As, 'C', 'access-list <name> extended <rule...>', 'Extended access list', (a, c) => asaAcl(c, a[0], 'extended ' + a[1]), true); def(As, 'C', 'access-list <name> line <n> extended <rule...>', 'Insert at line', (a, c) => asaAcl(c, a[0], 'extended ' + a[2]), true);
def(As, 'C', 'access-list <name> remark <text...>', 'Access list comment', () => '', true);
def(As, 'C', 'access-group <name> in interface <if>', 'Bind an access-list to an interface', (a, c) => { const x = ifByNameif(c.d, a[1]); if (!x) return 'ERROR: interface "' + a[1] + '" not found'; if (c.no) { delete x.aclIn; return ''; } if (!c.d.acls[a[0]]) return 'ERROR: access-list ' + a[0] + ' does not exist'; x.aclIn = a[0]; return ''; }, true);
def(As, 'C', 'object network <name>', 'Create a network object', (a, c) => { if (c.no) { delete c.d.objects[a[0]]; c.d.nats = c.d.nats.filter(n => n.obj !== a[0]); return ''; } c.d.objects[a[0]] = c.d.objects[a[0]] || { kind: 'host', ip: '0.0.0.0' }; c.s.mode = 'obj'; c.s.ctx = a[0]; return ''; }, true);
def(As, 'O', 'host <ip>', 'Specify a host', (a, c) => { if (!isIp(a[0])) return 'ERROR: invalid address'; c.d.objects[c.s.ctx] = { kind: 'host', ip: a[0] }; return ''; }); def(As, 'O', 'subnet <ip> <mask>', 'Specify a subnet', (a, c) => { if (!isIp(a[0]) || !isIp(a[1])) return 'ERROR: invalid address'; c.d.objects[c.s.ctx] = { kind: 'subnet', ip: a[0], len: maskToLen(a[1]) }; return ''; });
def(As, 'O', 'description <t...>', 'Description', () => '', true);
function asaNat(c, spec, kind, mapped) { const m = /^\((\w+),(\w+)\)$/.exec(spec); if (!m) return 'ERROR: usage: nat (real_if,mapped_if) static|dynamic <ip>|interface'; const { d, s } = c, o = d.objects[s.ctx];
  if (c.no) { d.nats = d.nats.filter(n => n.obj !== s.ctx); return ''; } if (!ifByNameif(d, m[1]) || !ifByNameif(d, m[2])) return 'ERROR: unknown interface in nat'; d.nats = d.nats.filter(n => n.obj !== s.ctx);
  if (kind === 'static') { if (o.kind !== 'host' || !isIp(mapped || '')) return 'ERROR: static NAT needs a host object and a mapped IP'; d.nats.push({ kind: 'static', obj: s.ctx, real: o.ip, mapped, realIf: m[1], mappedIf: m[2] }); } else d.nats.push({ kind: 'dynamic', obj: s.ctx, realIf: m[1], mappedIf: m[2], mapped: mapped || 'interface' }); return ''; }
def(As, 'O', 'nat <spec> static <ip>', 'Static NAT', (a, c) => asaNat(c, a[0], 'static', a[1]), true); def(As, 'O', 'nat <spec> dynamic interface', 'Dynamic PAT to the interface address', (a, c) => asaNat(c, a[0], 'dynamic', 'interface'), true); def(As, 'O', 'nat <spec> dynamic <ip>', 'Dynamic NAT/PAT to an address', (a, c) => asaNat(c, a[0], 'dynamic', a[1]), true);
// ---------- FTD clish + diagnostic CLI ----------
def(Ft, 'K', 'show version', 'Display version', (a, c) => '---------------[ ' + c.d.hostname + ' ]---------------\nModel : Cisco Secure Firewall Threat Defense (SIMULATED) Version 7.4.1 (sim)\nUUID  : 7a1f0000-0000-0000-0000-00000000ftd1\nSnort : 3 (sim)');
def(Ft, 'K', 'show managers', 'Display managers', () => 'Type                    : Manager\nHost                    : 192.168.100.13 (FMC1)\nRegistration            : Completed');
def(Ft, 'K', 'show network', 'Display network settings', (a, c) => '===============[ System Information ]===============\nHostname : ' + c.d.hostname + '\n===============[ management0 ]==================\nAddress : 192.168.100.12 / 255.255.255.0');
def(Ft, 'K', 'show interface ip brief', 'Interface summary', (a, c) => ifBriefAsa(c.d)); def(Ft, 'K', 'show ntp', 'NTP status', () => 'NTP Server : not configured (simulated)');
def(Ft, 'K', 'configure manager add <host> <key>', 'Register to a manager', () => 'Manager successfully configured.'); def(Ft, 'K', 'configure network <x...>', 'Configure management network', () => 'Setting IPv4 network configuration... (simulated)');
def(Ft, 'K', 'ping <ip>', 'Send echo', (a, c) => doPing(c.L, c.d, a[0])); def(Ft, 'K', 'expert', 'Linux shell', () => 'expert is not available in the simulator.');
def(Ft, 'K', 'system support diagnostic-cli', 'Enter the ASA-style diagnostic CLI', (a, c) => { c.s.mode = 'diag'; return 'Attaching to Diagnostic CLI ... Press \'Ctrl+a then d\' to detach.\nType help or \'?\' for a list of available commands.'; });
def(Ft, 'D', 'enable', 'Turn on privileged commands', (a, c) => { c.s.mode = 'diagp'; return ''; });
asaShow(Ft, 'D');
for (let i = Ft.length - 1; i >= 0; i--) if (Ft[i].pat === 'show access-list') Ft.splice(i, 1);
def(Ft, 'D', 'show access-list', 'Access control rules (compiled from FMC policy)', (a, c) => 'access-list CSM_FW_ACL_; ' + c.d.policy.rules.length + ' elements\n' + c.d.policy.rules.map((r, i) => 'access-list CSM_FW_ACL_ line ' + (i + 1) + ' extended ' + (r.action === 'allow' ? 'permit' : 'deny') + ' ' + (r.proto === 'any' ? 'ip' : r.proto) + ' ' + r.srcNet + ' ' + r.dstNet + (r.dport ? ' eq ' + r.dport : '') + ' (hitcnt=' + (r.hits || 0) + ')  [' + r.name + ']').join('\n'));
// ---------- Linux host ----------
function parseUrl(u) { const m = /^(?:(https?):\/\/)?([\d.]+)(?::(\d+))?(\/.*)?$/.exec(u); if (!m) return null; return { ip: m[2], port: m[3] ? +m[3] : m[1] === 'https' ? 443 : 80, path: m[4] || '/' }; }
function tokQ(line) { const t = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m; while ((m = re.exec(line))) t.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]); return t; }
function execRole(L, d, t) {
  const k = t.join(' ').toLowerCase();
  if (d.role === 'ise') { if (/^show version/.test(k)) return 'Cisco Identity Services Engine (SIMULATED)\nVersion : 3.2.0.542 (sim)\nHostname: ise1\nPersonas: Administration, Monitoring, Policy Service'; if (/^show application status/.test(k)) return 'ISE PROCESS NAME                       STATE            PROCESS ID\nDatabase Listener                      running          2101\nApplication Server                     running          3344\nPSC (RADIUS/TACACS)                    running          3398\nM&T Session Database                   running          2155'; }
  if (d.role === 'fmc') { if (/^show version/.test(k)) return '--------------[ fmc1 ]--------------\nModel: Cisco Secure Firewall Management Center (SIMULATED) Version 7.4.1 (sim)'; if (/^show (managed|devices)/.test(k)) return 'Managed devices: 1\n  FTD1  192.168.100.12  Status: Healthy  Policy: ' + (L.dev.FTD1.dirty ? 'OUT OF DATE (deploy pending)' : 'Up to date'); }
  if (d.role === 'esa') { if (/^(status|version)/.test(k)) return 'Cisco Email Security Appliance (SIMULATED) esa1.lab.local\nMessages accepted: ' + L.esa.counters.accepted + '   spam: ' + L.esa.counters.spam + '   virus: ' + L.esa.counters.virus + '   blocked: ' + L.esa.counters.blocked; }
  if (d.role === 'wsa') { if (/^(status|version)/.test(k)) return 'Cisco Secure Web Appliance (SIMULATED) wsa1.lab.local\nProxy: explicit, port 3128 | Requests: ' + L.wsa.counters.total + '  allowed: ' + L.wsa.counters.allowed + '  blocked: ' + L.wsa.counters.blocked + '  malware: ' + L.wsa.counters.malware; }
  return null;
}
function execHost(L, d, s, line) {
  let t = tokQ(line); if (!t.length) return '';
  if (d.role) { const r = execRole(L, d, t); if (r !== null) return r; if (t[0] === 'help' || t[0] === '?') return d.role === 'ise' ? 'show version | show application status ise | ping <ip>' : d.role === 'fmc' ? 'show version | show managed-devices | ping <ip>   (policy is configured in the GUI)' : 'status | version | ping <ip>   (policy is configured in the GUI)'; }
  if (t[0] === 'swaks') { const g = k => { const i = t.indexOf(k); return i > 0 ? t[i + 1] : null; }; const to = g('--to'), from = g('--from') || ('user@' + d.name.toLowerCase() + '.example'), srv = g('--server') || g('-s');
    if (!to || !srv) return 'usage: swaks --to rcpt@lab.local --from you@domain --server <esa-ip> [--header "Subject: hi"] [--body "text"] [--attach file.exe]';
    const hdr = g('--header') || ''; const att = []; t.forEach((w, i) => { if (w === '--attach') att.push(t[i + 1]); });
    const r = S.esaSend(L, d.name, { from, to, subject: hdr.replace(/^Subject:\s*/i, '') || '(no subject)', body: g('--body') || '', attach: att, server: srv });
    const lines = ['=== Trying ' + srv + ':25...']; if (r.disp === 'not-connected') return lines.concat(['*** Error connecting to ' + srv + ':25: ' + (r.why || 'connection failed'), '   (the packet was dropped before reaching the ESA - check NAT + firewall policy)']).join('\n');
    lines.push('=== Connected to ' + srv + '.', '<-  220 esa1.lab.local ESMTP', ' -> EHLO ' + d.name.toLowerCase(), ' -> MAIL FROM:<' + from + '>', ' -> RCPT TO:<' + to + '>'); r.steps.forEach(x => lines.push('    [ESA] ' + x.t));
    lines.push(r.disp.startsWith('delivered') ? '<-  250 2.0.0 Message accepted for delivery (MID ' + r.mid + ')' : r.disp === 'rejected' ? '<** 550 5.7.1 ' + r.why : '<-  250 2.0.0 Message accepted (MID ' + r.mid + ') - ' + r.disp + ': ' + r.why, ' -> QUIT', '<-  221 Bye', '=== Connection closed. Final disposition: ' + r.disp.toUpperCase()); return lines.join('\n'); }
  if (!t.length) return ''; if (t[0] === 'sudo') t.shift(); let a; const x = d.ifs.eth0;
  const M = (spec) => { const r = []; for (let i = 0; i < spec.length; i++) { const sp = spec[i], w = t[i]; if (sp === '*') { r.push(t.slice(i)); return r; } if (w === undefined) return null; if (sp[0] === '<') r.push(w); else if (sp !== w) return null; } return t.length > spec.length ? null : r; };
  if (!d.role && (t[0] === 'help' || t[0] === '?')) return 'swaks --to a@lab.local --server <ip> ... (send test email) | ip addr | ip route | ping <ip> | traceroute <ip> | curl [-A agent] [-x proxy:port] <url> | nmap [-Pn] [-p 22,80] <ip> | ifconfig | arp -n | ss -tln | hostname | uname -a | whoami | clear\nset address: ip addr add 10.1.10.10/24 dev eth0 ; ip route add default via 10.1.10.1';
  if (t[0] === 'hostname') return d.name.toLowerCase(); if (t[0] === 'whoami') return 'lab'; if (t[0] === 'uname') return 'Linux ' + d.name.toLowerCase() + ' 5.15.0-sim #1 SMP x86_64 GNU/Linux'; if (t[0] === 'date') return new Date().toString();
  if (t[0] === 'ifconfig' || (t[0] === 'ip' && /^a/.test(t[1] || '') && !t[2]) || (t[0] === 'ip' && t[1] === '-br')) return t[0] === 'ifconfig' ? 'eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        ' + (x.ip ? 'inet ' + x.ip + '  netmask ' + lenToMask(x.len) : '(no address)') + '\n        ether ' + macOf(d.name, 'eth0').replace(/\./g, ':') : '1: lo: <LOOPBACK,UP> mtu 65536\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST,MULTICAST,UP> mtu 1500\n    ' + (x.ip ? 'inet ' + x.ip + '/' + x.len + ' scope global eth0' : '(no address)');
  if ((t[0] === 'ip' && /^r/.test(t[1] || '') ) || t[0] === 'route') return (d.gw ? 'default via ' + d.gw + ' dev eth0\n' : '') + (x.ip ? n2ip((ip2n(x.ip) & ((0xFFFFFFFF << (32 - x.len)) >>> 0)) >>> 0) + '/' + x.len + ' dev eth0 proto kernel scope link src ' + x.ip : '');
  if (t[0] === 'arp') return 'Address                  HWtype  HWaddress           Iface\n' + segment(L, d.name, 'eth0').eps.map(ep => pad(L.dev[ep.dev].ifs[ep.if].ip || '', 25) + pad('ether', 8) + pad(macOf(ep.dev, ep.if).replace(/\./g, ':'), 20) + 'eth0').join('\n');
  if (t[0] === 'ss' || t[0] === 'netstat') return 'State   Local Address:Port\n' + (d.listen.tcp || []).map(p => 'LISTEN  0.0.0.0:' + p).join('\n');
  if ((a = M(['ip', 'addr', 'add', '<x>', 'dev', '<x>'])) || (a = M(['ip', 'a', 'add', '<x>', 'dev', '<x>']))) { const m = /^([\d.]+)\/(\d+)$/.exec(a[0]); if (!m || !isIp(m[1])) return 'Error: any valid prefix is expected rather than "' + a[0] + '".'; x.ip = m[1]; x.len = +m[2]; return ''; }
  if ((a = M(['ip', 'route', 'add', 'default', 'via', '<x>']))) { if (!isIp(a[0])) return 'Error: invalid gateway'; d.gw = a[0]; return ''; }
  if (t[0] === 'ping') { const ip = t.slice(1).filter(z => !z.startsWith('-') && !/^\d+$/.test(z)).pop(); if (!isIp(ip || '')) return 'ping: usage: ping <ip-address>'; const out = ['PING ' + ip + ' (' + ip + ') 56(84) bytes of data.']; let ok = 0;
    for (let i = 1; i <= 4; i++) { const r = flow(L, d.name, { proto: 'icmp', dst: ip });
      if (r.ok) { ok++; const hops = r.path.slice(0, r.path.indexOf(r.dstDev)).filter(n => ['router', 'ftd'].includes(L.dev[n].type)).length; out.push('64 bytes from ' + ip + ': icmp_seq=' + i + ' ttl=' + (64 - hops) + ' time=' + (1 + hops * 1.3).toFixed(1) + ' ms'); }
      else if (r.kind === 'unreach' || r.kind === 'prohibited') out.push('From ' + (r.hopIp || r.at || 'gateway') + ' icmp_seq=' + i + ' Destination ' + (r.kind === 'prohibited' ? 'Host Prohibited' : 'Host Unreachable')); }
    out.push('--- ' + ip + ' ping statistics ---', '4 packets transmitted, ' + ok + ' received, ' + (100 - ok * 25) + '% packet loss'); return out.join('\n'); }
  if (t[0] === 'traceroute') { if (!isIp(t[1] || '')) return 'Usage: traceroute <ip-address>'; return 'traceroute to ' + t[1] + ', 12 hops max\n' + traceroute(L, d.name, t[1]).map(h => ' ' + h.n + '  ' + (h.ip ? h.ip + '  1.2 ms' : '* * *')).join('\n'); }
  if (t[0] === 'curl') { let ua = '', url = null, proxy = null; for (let i = 1; i < t.length; i++) { if (t[i] === '-A') ua = t[++i] || ''; else if (t[i] === '-x' || t[i] === '--proxy') proxy = t[++i]; else if (!t[i].startsWith('-')) url = t[i]; }
    if (url && !/^https?:\/\//.test(url)) url = 'http://' + url;
    const isIpUrl = url && /^https?:\/\/[\d.]+(:\d+)?(\/.*)?$/.test(url);
    if (proxy || (url && !isIpUrl)) { if (proxy && !/:/.test(proxy)) proxy += ':3128'; const r = S.webGet(L, d.name, { url, proxy }); if (!r.ok && r.kind === 'dns') return 'curl: (6) ' + r.why;
      if (r.ok) return '<html><body><h1>' + r.page + '</h1></body></html>\n[HTTP/1.1 200 OK' + (r.via ? ' via ' + r.via : '') + (r.cat ? ' | category: ' + r.cat : '') + ']';
      if (r.kind === 'blocked' || r.kind === 'malware') return 'HTTP/1.1 403 Forbidden\n<html><body><h1>Access Denied</h1><p>' + r.why + '</p></body></html>';
      if (r.status === 503) return 'HTTP/1.1 503 Service Unavailable  [' + r.why + ']'; return 'curl: (7) Failed to connect: ' + (r.why || 'error'); }
    const u = url && parseUrl(url); if (!u) return 'curl: (6) Could not resolve host';
    const blob = (ua + ' ' + url).toLowerCase(); const sig = BAD.find(b => blob.includes(b)); const r = flow(L, d.name, { proto: 'tcp', dst: u.ip, dport: u.port, sig });
    if (r.ok) return '<html><body><h1>' + (r.page || 'OK') + '</h1></body></html>\n[HTTP/1.1 200 OK from ' + u.ip + ':' + u.port + ']';
    if (r.kind === 'closed') return 'curl: (7) Failed to connect to ' + u.ip + ' port ' + u.port + ': Connection refused';
    if (r.kind === 'unreach' || r.kind === 'prohibited') return 'curl: (7) Failed to connect to ' + u.ip + ' port ' + u.port + ': No route to host';
    return 'curl: (28) Connection timed out after 5001 milliseconds   [' + (r.why || '') + ']'; }
  if (t[0] === 'nmap') { const ip = t.filter(z => isIp(z)).pop(); if (!ip) return 'Usage: nmap [-Pn] [-p 22,80] <ip>'; const pi = t.indexOf('-p'); const ports = pi > 0 ? t[pi + 1].split(',').map(Number) : [21, 22, 23, 25, 53, 80, 110, 443, 3389, 8080];
    const up = t.includes('-Pn') || flow(L, d.name, { proto: 'icmp', dst: ip }).ok; if (!up) return 'Starting Nmap against ' + ip + '\nNote: Host seems down. If it is really up, but blocking our ping probes, try -Pn\nNmap done: 1 IP address (0 hosts up)';
    const rows = []; let f = 0; for (const p of ports) { const r = flow(L, d.name, { proto: 'tcp', dst: ip, dport: p, sig: 'nmap-scan' }); const st = r.ok ? 'open' : r.kind === 'closed' ? 'closed' : 'filtered'; if (st === 'filtered') f++; if (st !== 'closed') rows.push(pad(p + '/tcp', 10) + pad(st, 10)); }
    return 'Starting Nmap against ' + ip + '\nPORT      STATE\n' + (rows.join('\n') || '(all ports closed)') + (f ? '\n(' + f + ' filtered)' : '') + '\nNmap done: 1 IP address (host up)'; }
  return t[0] + ': command not found (type help)';
}
function runLines(L, d, lines) { const s = { mode: 'config', ctx: null }; const out = []; for (const l of lines) { const o = exec(L, d, s, l); if (o && /(^ERROR|^%|Invalid input)/m.test(o)) out.push(l + ' -> ' + o.replace(/\n/g, ' ')); } return out; }
const API = { newSession, prompt, exec, runLines, normIf, help, complete, suggest, REG, macOf };
root.Cli = API; if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
