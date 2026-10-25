// SCOR Lab Simulator - device command lines (IOS-like routers, ASA-like firewall, FTD basic CLI, Linux hosts)
(function (root) {
'use strict';
const S = root.Sim;
const { flow, traceroute, packetTracer, parseAclTokens, aclText, isIp, maskToLen, lenToMask, n2ip, ip2n, routeLookup, ifByNameif } = S;
const LONG = n => n.replace(/^Gi/, 'GigabitEthernet');
const BAD = ['sqlmap', 'nikto', 'masscan', 'metasploit', 'union select', '../../etc/passwd', '<script>'];
function normIf(d, s) {
  if (d.type === 'host') return /^eth0$/i.test(s) ? 'eth0' : null;
  const m = /^g(?:i|ig|iga|igab|igabit|igabitethernet)?\s*(\d+\/\d+)$/i.exec(s); const n = m ? 'Gi' + m[1] : null;
  return n && d.ifs[n] ? n : null;
}
function M(t, spec) {      // prefix-matching command matcher; '<x>' = one arg, '<*>' = rest
  const a = []; for (let i = 0; i < spec.length; i++) { const s = spec[i], w = t[i];
    if (s === '<*>') { a.push(t.slice(i)); return a; }
    if (w === undefined) return null;
    if (s[0] === '<') a.push(w); else if (!s.startsWith(w.toLowerCase())) return null; }
  return t.length > spec.length ? null : a;
}
const pad = (s, n) => String(s).padEnd(n);
function newSession(d) { return { mode: d.type === 'host' ? 'host' : d.type === 'ftd' ? 'ftd' : 'user', ctx: null }; }
function prompt(d, s) {
  const h = d.hostname;
  if (d.type === 'host') return 'lab@' + d.name.toLowerCase() + ':~$ ';
  if (d.type === 'ftd') return '> ';
  const asa = d.type === 'asa';
  return h + ({ user: '>', priv: '#', config: '(config)#', if: '(config-if)#', acl: '(config-ext-nacl)#', obj: '(config-network-object)#' }[s.mode]);
}
function pingLine(r) { return r.ok ? '!' : r.kind === 'prohibited' || r.kind === 'unreach' ? 'U' : '.'; }
function doPing(L, d, dst, fromNameif) {
  if (!isIp(dst)) return '% Unrecognized host or address';
  const res = []; for (let i = 0; i < 5; i++) res.push(flow(L, d.name, { proto: 'icmp', dst }));
  const ok = res.filter(r => r.ok).length;
  return 'Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ' + dst + ', timeout is 2 seconds:\n' + res.map(pingLine).join('') + '\nSuccess rate is ' + ok * 20 + ' percent (' + ok + '/5)' + (ok ? ', round-trip min/avg/max = 1/2/4 ms' : '');
}
function doTrace(L, d, dst) {
  if (!isIp(dst)) return '% Unrecognized host or address';
  return 'Type escape sequence to abort.\nTracing the route to ' + dst + '\n' + traceroute(L, d.name, dst).map(h => ' ' + h.n + ' ' + (h.ip ? h.ip + (h.done ? '  4 msec' : '  2 msec') : '* * *')).join('\n');
}
function ifBrief(d, asa) {
  const rows = Object.values(d.ifs).map(x => pad(LONG(x.name), 24) + pad(x.ip || 'unassigned', 16) + pad('YES manual', 12) + pad(x.up ? 'up' : 'administratively down', 24) + (x.up && x.ip ? 'up' : 'down'));
  return pad('Interface', 24) + pad('IP-Address', 16) + pad('OK? Method', 12) + pad('Status', 24) + 'Protocol\n' + rows.join('\n');
}
function routeText(d, asa) {
  const out = ['Codes: C - connected, S - static, * - candidate default']; const lines = [];
  for (const x of Object.values(d.ifs)) if (x.up && x.ip) { const net = n2ip((ip2n(x.ip) & ((0xFFFFFFFF << (32 - x.len)) >>> 0)) >>> 0); lines.push('C    ' + net + (asa ? ' ' + lenToMask(x.len) : '/' + x.len) + ' is directly connected, ' + (asa ? x.nameif : x.name)); }
  let gw = null;
  for (const r of d.routes) { lines.push('S' + (r.len === 0 ? '*' : ' ') + '   ' + r.net + (asa ? ' ' + lenToMask(r.len) + ' [1/0] via ' + r.nh + ', ' + r.nameif : '/' + r.len + ' [1/0] via ' + r.nh)); if (r.len === 0) gw = r.nh; }
  out.push(gw ? 'Gateway of last resort is ' + gw + ' to network 0.0.0.0' : 'Gateway of last resort is not set'); return out.concat(lines).join('\n');
}
function aclShow(d, name, style) {
  const names = name ? [name] : Object.keys(d.acls); if (!names.length || (name && !d.acls[name])) return name ? '% No such access list' : '';
  return names.map(n => (style === 'asa' ? 'access-list ' + n + '; ' + d.acls[n].length + ' elements\n' + d.acls[n].map((e, i) => 'access-list ' + n + ' line ' + (i + 1) + ' extended ' + aclText(e, 'asa') + ' (hitcnt=' + (e.hits || 0) + ')').join('\n')
    : 'Extended IP access list ' + n + '\n' + d.acls[n].map((e, i) => '    ' + (i + 1) * 10 + ' ' + aclText(e, 'ios') + (e.hits ? ' (' + e.hits + ' matches)' : '')).join('\n'))).join('\n');
}
function runCfg(d) {
  const asa = d.type === 'asa', o = [];
  if (asa) o.push(': Saved', 'ASA Version 9.20(1)'); else o.push('Building configuration...', 'version 15.9');
  o.push('hostname ' + d.hostname, '!');
  for (const x of Object.values(d.ifs)) {
    o.push('interface ' + LONG(x.name)); if (asa) { o.push(' nameif ' + x.nameif, ' security-level ' + x.sec); }
    o.push(x.ip ? ' ip address ' + x.ip + ' ' + lenToMask(x.len) : ' no ip address');
    if (!asa && x.aclIn) o.push(' ip access-group ' + x.aclIn + ' in'); if (!asa && x.aclOut) o.push(' ip access-group ' + x.aclOut + ' out');
    o.push(x.up ? ' no shutdown' : ' shutdown', '!'); }
  if (asa) { for (const [k, ob] of Object.entries(d.objects)) { o.push('object network ' + k, ob.kind === 'host' ? ' host ' + ob.ip : ' subnet ' + ob.ip + ' ' + lenToMask(ob.len));
      for (const n of d.nats.filter(n => n.obj === k)) o.push(' nat (' + n.realIf + ',' + n.mappedIf + ') ' + n.kind + ' ' + (n.mapped === 'interface' ? 'interface' : n.mapped)); o.push('!'); } }
  for (const [k, es] of Object.entries(d.acls)) { if (asa) es.forEach(e => o.push('access-list ' + k + ' extended ' + aclText(e, 'asa'))); else { o.push('ip access-list extended ' + k); es.forEach(e => o.push(' ' + aclText(e, 'ios'))); o.push('!'); } }
  if (asa) for (const x of Object.values(d.ifs)) if (x.aclIn) o.push('access-group ' + x.aclIn + ' in interface ' + x.nameif);
  for (const r of d.routes) o.push(asa ? 'route ' + r.nameif + ' ' + r.net + ' ' + lenToMask(r.len) + ' ' + r.nh + ' 1' : 'ip route ' + r.net + ' ' + lenToMask(r.len) + ' ' + r.nh);
  return o.join('\n');
}
function connText(d) {
  if (!d.conns.length) return '0 in use, 0 most used';
  const nm = k => d.ifs[k].nameif;
  return d.conns.length + ' in use\n' + d.conns.map(c => c.proto.toUpperCase() + ' ' + nm(c.out.if) + ' ' + c.out.dst + ':' + (c.proto === 'icmp' ? 0 : c.out.dport) + ' ' + nm(c.in.if) + ' ' + c.in.src + ':' + (c.proto === 'icmp' ? 0 : c.in.sport) + ', flags UIO, hits ' + c.hits).join('\n');
}
function xlateText(d) {
  if (!d.xlates.length) return '0 in use, 0 most used';
  const out = []; for (const x of d.xlates) { if (x.real.split(':')[0] !== x.mapped.split(':')[0]) out.push((x.proto === 'icmp' ? 'ICMP' : x.proto.toUpperCase()) + ' PAT/NAT from ' + x.real.split(':')[0] + ' to ' + x.mapped.split(':')[0]); if (x.realDst !== x.mappedDst) out.push('Static NAT (untranslate) ' + x.mappedDst + ' -> ' + x.realDst); }
  return d.xlates.length + ' in use\n' + out.join('\n');
}
function ptText(L, d, a) {
  const [ni, proto, sip, sp, dip, dp] = a;
  if (!ifByNameif(d, ni)) return '% Invalid input interface name: ' + ni;
  if (!['tcp', 'udp', 'icmp'].includes(proto) || !isIp(sip) || !isIp(dip)) return '% Usage: packet-tracer input <nameif> tcp|udp <sip> <sport> <dip> <dport>';
  const r = packetTracer(L, d.name, ni, { proto, src: sip, sport: +sp, dst: dip, dport: +dp });
  const lines = r.trace.map((t, i) => 'Phase: ' + (i + 1) + '\n' + 'Info: ' + t.t + '\n');
  const ok = r.o.st === 'delivered' || (r.o.st !== 'drop' && r.o.st !== 'noroute');
  return lines.join('\n') + '\nResult:\ninput-interface: ' + ni + '\naction: ' + (r.o.st === 'drop' || r.o.st === 'noroute' ? 'drop\nDrop-reason: ' + r.o.why : 'allow');
}

// ---------- IOS-like router ----------
function execRouter(L, d, s, line) {
  const t = line.trim().split(/\s+/).filter(Boolean); if (!t.length) return '';
  let a;
  if (line.trim() === '?') return s.mode === 'user' ? 'enable  ping  traceroute  show  exit' : s.mode === 'priv' ? 'configure  show  ping  traceroute  write  copy  exit' : s.mode === 'config' ? 'hostname  interface  ip  access-list  no  do  end  exit' : s.mode === 'if' ? 'ip address | ip access-group | shutdown | no shutdown | description | exit' : 'permit | deny | no | exit';
  if (M(t, ['end'])) { s.mode = 'priv'; return ''; }
  if (M(t, ['exit'])) { s.mode = s.mode === 'if' || s.mode === 'acl' ? 'config' : s.mode === 'config' ? 'priv' : s.mode === 'priv' ? 'user' : 'user'; return ''; }
  if (s.mode === 'user') {
    if (M(t, ['enable'])) { s.mode = 'priv'; return ''; }
    if ((a = M(t, ['ping', '<x>']))) return doPing(L, d, a[0]);
    if ((a = M(t, ['traceroute', '<x>']))) return doTrace(L, d, a[0]);
    if (M(t, ['show', '<*>'])) { s.mode = 'user'; return '% Access denied - type "enable" first'; }
    return '% Invalid input detected at \'^\' marker.';
  }
  if (s.mode === 'priv' || (t[0] === 'do' && (t.shift(), true))) {
    if (M(t, ['configure', 'terminal']) || M(t, ['conf', 't'])) { s.mode = 'config'; return 'Enter configuration commands, one per line.  End with CNTL/Z.'; }
    if (M(t, ['show', 'ip', 'interface', 'brief'])) return ifBrief(d);
    if (M(t, ['show', 'running-config']) || M(t, ['show', 'run'])) return runCfg(d);
    if (M(t, ['show', 'ip', 'route'])) return routeText(d);
    if (M(t, ['show', 'access-lists']) || M(t, ['show', 'access-list'])) return aclShow(d, null, 'ios') || '(none)';
    if ((a = M(t, ['show', 'access-lists', '<x>']))) return aclShow(d, a[0], 'ios');
    if ((a = M(t, ['ping', '<x>']))) return doPing(L, d, a[0]);
    if ((a = M(t, ['traceroute', '<x>']))) return doTrace(L, d, a[0]);
    if (M(t, ['write', '<*>']) || M(t, ['copy', '<*>'])) return 'Building configuration...\n[OK]';
    if (s.mode === 'priv') return '% Invalid input detected at \'^\' marker.';
  }
  const no = t[0] === 'no' ? (t.shift(), true) : false;
  if (s.mode === 'config') {
    if ((a = M(t, ['hostname', '<x>']))) { d.hostname = a[0]; return ''; }
    if ((a = M(t, ['interface', '<*>']))) { const n = normIf(d, a[0].join('')); if (!n) return '% Invalid interface'; s.mode = 'if'; s.ctx = n; return ''; }
    if ((a = M(t, ['ip', 'route', '<x>', '<x>', '<x>']))) { if (!isIp(a[0]) || !isIp(a[1]) || !isIp(a[2])) return '% Invalid address'; const len = maskToLen(a[1]);
      d.routes = d.routes.filter(r => !(r.net === a[0] && r.len === len)); if (!no) d.routes.push({ net: a[0], len, nh: a[2] }); return ''; }
    if ((a = M(t, ['ip', 'access-list', 'extended', '<x>']))) { if (no) { delete d.acls[a[0]]; return ''; } d.acls[a[0]] = d.acls[a[0]] || []; s.mode = 'acl'; s.ctx = a[0]; return ''; }
    if ((a = M(t, ['access-list', '<x>', '<*>']))) { try { const e = parseAclTokens(a[1].slice(1), 'ios'); e.action = a[1][0]; e.hits = 0; if (!['permit', 'deny'].includes(e.action)) throw new Error('% Invalid action'); (d.acls[a[0]] = d.acls[a[0]] || []).push(e); return ''; } catch (e) { return e.message; } }
    return '% Invalid input detected at \'^\' marker.';
  }
  if (s.mode === 'if') {
    const x = d.ifs[s.ctx];
    if ((a = M(t, ['ip', 'address', '<x>', '<x>']))) { if (!isIp(a[0]) || !isIp(a[1])) return '% Invalid address'; x.ip = a[0]; x.len = maskToLen(a[1]); return ''; }
    if (no && M(t, ['ip', 'address'])) { x.ip = null; return ''; }
    if ((a = M(t, ['ip', 'access-group', '<x>', '<x>']))) { const dir = a[1] === 'out' ? 'aclOut' : 'aclIn'; if (no) delete x[dir]; else x[dir] = a[0]; return ''; }
    if (M(t, ['shutdown'])) { x.up = no ? true : false; return ''; }
    if (M(t, ['description', '<*>'])) return '';
    return '% Invalid input detected at \'^\' marker.';
  }
  if (s.mode === 'acl') {
    if (/^\d+$/.test(t[0])) t.shift();
    try { const e = parseAclTokens(t.slice(1), 'ios'); e.action = t[0]; if (!['permit', 'deny'].includes(e.action)) return '% Invalid input detected at \'^\' marker.'; e.hits = 0;
      if (no) { d.acls[s.ctx] = d.acls[s.ctx].filter(x => aclText(x, 'ios') !== aclText(e, 'ios')); } else d.acls[s.ctx].push(e); return ''; } catch (e) { return e.message; }
  }
  return '';
}

// ---------- ASA-like firewall ----------
function execAsa(L, d, s, line) {
  const t = line.trim().split(/\s+/).filter(Boolean); if (!t.length) return ''; let a;
  if (line.trim() === '?') return 'show  ping  packet-tracer  configure  clear  write  exit';
  if (M(t, ['end'])) { s.mode = 'priv'; return ''; }
  if (M(t, ['exit'])) { s.mode = s.mode === 'if' || s.mode === 'obj' ? 'config' : s.mode === 'config' ? 'priv' : 'user'; return ''; }
  if (s.mode === 'user') { if (M(t, ['enable'])) { s.mode = 'priv'; return ''; } if ((a = M(t, ['ping', '<*>']))) { /* fallthrough below */ } else return 'ERROR: % Invalid input - try "enable"'; }
  if (s.mode === 'priv' || s.mode === 'user' || t[0] === 'do') {
    if (t[0] === 'do') t.shift();
    if (M(t, ['configure', 'terminal']) || M(t, ['conf', 't'])) { s.mode = 'config'; return ''; }
    if (M(t, ['show', 'interface', 'ip', 'brief'])) return ifBrief(d, true);
    if (M(t, ['show', 'running-config']) || M(t, ['show', 'run'])) return runCfg(d);
    if (M(t, ['show', 'route'])) return routeText(d, true);
    if ((a = M(t, ['show', 'access-list', '<x>']))) return aclShow(d, a[0], 'asa');
    if (M(t, ['show', 'access-list'])) return aclShow(d, null, 'asa') || '(no access-lists)';
    if (M(t, ['show', 'xlate'])) return xlateText(d);
    if (M(t, ['show', 'conn']) || M(t, ['show', 'connection'])) return connText(d);
    if (M(t, ['show', 'nat'])) return d.nats.length ? d.nats.map((n, i) => (i + 1) + ' (' + n.realIf + ') to (' + n.mappedIf + ') source ' + n.kind + ' ' + n.obj + ' ' + n.mapped).join('\n') : '(no nat)';
    if ((a = M(t, ['packet-tracer', 'input', '<*>']))) return ptText(L, d, a[0].length === 5 ? [a[0][0], a[0][1], a[0][2], a[0][3], a[0][4], '0'] : a[0]);
    if ((a = M(t, ['ping', '<*>']))) { const ip = a[0][a[0].length - 1]; return doPing(L, d, ip); }
    if (M(t, ['clear', 'xlate']) || M(t, ['clear', 'conn'])) { d.conns.length = 0; d.xlates.length = 0; return 'Cleared.'; }
    if (M(t, ['clear', 'access-list', '<*>'])) { Object.values(d.acls).forEach(es => es.forEach(e => e.hits = 0)); return ''; }
    if (M(t, ['write', '<*>']) || M(t, ['copy', '<*>'])) return 'Building configuration...\n[OK]';
    if (s.mode !== 'config') return 'ERROR: % Invalid input detected';
  }
  const no = t[0] === 'no' ? (t.shift(), true) : false;
  if (s.mode === 'config') {
    if ((a = M(t, ['hostname', '<x>']))) { d.hostname = a[0]; return ''; }
    if ((a = M(t, ['interface', '<*>']))) { const n = normIf(d, a[0].join('')); if (!n) return 'ERROR: invalid interface'; s.mode = 'if'; s.ctx = n; return ''; }
    if ((a = M(t, ['route', '<x>', '<x>', '<x>', '<x>', '<*>']))) { const x = ifByNameif(d, a[0]); if (!x) return 'ERROR: unknown interface ' + a[0]; const len = maskToLen(a[2]);
      d.routes = d.routes.filter(r => !(r.net === a[1] && r.len === len)); if (!no) d.routes.push({ net: a[1], len, nh: a[3], nameif: a[0] }); return ''; }
    if ((a = M(t, ['access-list', '<x>', '<*>']))) { const r = a[1]; if (r[0] === 'line') r.splice(0, 2); if (r[0] !== 'extended') return 'ERROR: only extended ACLs supported'; r.shift();
      try { const e = parseAclTokens(r.slice(1), 'asa'); e.action = r[0]; if (!['permit', 'deny'].includes(e.action)) throw new Error('ERROR: invalid action'); e.hits = 0;
        if (no) d.acls[a[0]] = (d.acls[a[0]] || []).filter(x => aclText(x, 'asa') !== aclText(e, 'asa')); else (d.acls[a[0]] = d.acls[a[0]] || []).push(e); return ''; } catch (e) { return e.message; } }
    if ((a = M(t, ['access-group', '<x>', 'in', 'interface', '<x>']))) { const x = ifByNameif(d, a[1]); if (!x) return 'ERROR: unknown interface'; if (no) delete x.aclIn; else { if (!d.acls[a[0]]) return 'ERROR: access-list ' + a[0] + ' does not exist'; x.aclIn = a[0]; } return ''; }
    if ((a = M(t, ['object', 'network', '<x>']))) { if (no) { delete d.objects[a[0]]; d.nats = d.nats.filter(n => n.obj !== a[0]); return ''; } d.objects[a[0]] = d.objects[a[0]] || { kind: 'host', ip: '0.0.0.0' }; s.mode = 'obj'; s.ctx = a[0]; return ''; }
    if (M(t, ['same-security-traffic', '<*>'])) return '';
    return 'ERROR: % Invalid input detected';
  }
  if (s.mode === 'if') {
    const x = d.ifs[s.ctx];
    if ((a = M(t, ['nameif', '<x>']))) { x.nameif = a[0]; return ''; }
    if ((a = M(t, ['security-level', '<x>']))) { x.sec = +a[0]; return ''; }
    if ((a = M(t, ['ip', 'address', '<x>', '<x>']))) { if (!isIp(a[0]) || !isIp(a[1])) return 'ERROR: invalid address'; x.ip = a[0]; x.len = maskToLen(a[1]); return ''; }
    if (M(t, ['shutdown'])) { x.up = no; if (!no) x.up = false; return ''; }
    return 'ERROR: % Invalid input detected';
  }
  if (s.mode === 'obj') {
    const o = d.objects[s.ctx];
    if ((a = M(t, ['host', '<x>']))) { if (!isIp(a[0])) return 'ERROR: invalid address'; d.objects[s.ctx] = { kind: 'host', ip: a[0] }; return ''; }
    if ((a = M(t, ['subnet', '<x>', '<x>']))) { if (!isIp(a[0]) || !isIp(a[1])) return 'ERROR: invalid address'; d.objects[s.ctx] = { kind: 'subnet', ip: a[0], len: maskToLen(a[1]) }; return ''; }
    if ((a = M(t, ['nat', '<x>', '<x>', '<*>']))) {
      const m = /^\((\w+),(\w+)\)$/.exec(a[0]); if (!m) return 'ERROR: usage: nat (real_if,mapped_if) static|dynamic <ip>|interface';
      if (no) { d.nats = d.nats.filter(n => n.obj !== s.ctx); return ''; }
      if (!ifByNameif(d, m[1]) || !ifByNameif(d, m[2])) return 'ERROR: unknown interface in nat';
      d.nats = d.nats.filter(n => n.obj !== s.ctx);
      if (a[1] === 'static') { if (o.kind !== 'host' || !isIp(a[2][0] || '')) return 'ERROR: static NAT needs a host object and a mapped IP'; d.nats.push({ kind: 'static', obj: s.ctx, real: o.ip, mapped: a[2][0], realIf: m[1], mappedIf: m[2] }); }
      else if (a[1] === 'dynamic') d.nats.push({ kind: 'dynamic', obj: s.ctx, realIf: m[1], mappedIf: m[2], mapped: a[2][0] || 'interface' });
      else return 'ERROR: static or dynamic expected'; return '';
    }
    return 'ERROR: % Invalid input detected';
  }
  return '';
}

// ---------- FTD basic CLI ----------
function execFtd(L, d, s, line) {
  const t = line.trim().split(/\s+/).filter(Boolean); if (!t.length) return ''; let a;
  if (M(t, ['show', 'interface', 'ip', 'brief']) || M(t, ['show', 'interface'])) return ifBrief(d);
  if (M(t, ['show', 'route'])) return routeText(d);
  if (M(t, ['show', 'conn']) || M(t, ['show', 'connection'])) return connText(d);
  if (M(t, ['show', 'xlate'])) return xlateText(d);
  if ((a = M(t, ['ping', '<x>']))) return doPing(L, d, a[0]);
  if (M(t, ['?'])) return 'show interface ip brief | show route | show conn | show xlate | ping <ip>\nPolicy is configured from FMC (use the FMC GUI tab).';
  return 'This is the FTD clish. Configure policy, interfaces and NAT in FMC (GUI tab). Type ? for CLI commands.';
}

// ---------- Linux host ----------
function parseUrl(u) { const m = /^(?:(https?):\/\/)?([\d.]+)(?::(\d+))?(\/.*)?$/.exec(u); if (!m) return null; return { ip: m[2], port: m[3] ? +m[3] : m[1] === 'https' ? 443 : 80, path: m[4] || '/' }; }
function execHost(L, d, s, line) {
  let t = line.trim().split(/\s+/).filter(Boolean); if (!t.length) return ''; if (t[0] === 'sudo') t.shift(); let a;
  const x = d.ifs.eth0;
  if (M(t, ['help']) || M(t, ['?'])) return 'ip addr | ip route | ping <ip> | traceroute <ip> | curl [-A agent] <url> | nmap [-Pn] [-p 22,80] <ip> | hostname | clear\nset address: ip addr add 10.1.10.10/24 dev eth0 ; ip route add default via 10.1.10.1';
  if (t[0] === 'hostname') return d.name.toLowerCase();
  if (t[0] === 'ip' && /^a/.test(t[1] || '') && !t[2]) return '1: lo: <LOOPBACK,UP>\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST,MULTICAST,UP> mtu 1500\n    ' + (x.ip ? 'inet ' + x.ip + '/' + x.len + ' brd scope global eth0' : '(no address)');
  if (t[0] === 'ip' && /^r/.test(t[1] || '') && !t[2]) return (d.gw ? 'default via ' + d.gw + ' dev eth0\n' : '') + (x.ip ? n2ip((ip2n(x.ip) & ((0xFFFFFFFF << (32 - x.len)) >>> 0)) >>> 0) + '/' + x.len + ' dev eth0 proto kernel scope link src ' + x.ip : '');
  if ((a = M(t, ['ip', 'addr', 'add', '<x>', 'dev', '<x>'])) || (a = M(t, ['ip', 'a', 'add', '<x>', 'dev', '<x>']))) { const m = /^([\d.]+)\/(\d+)$/.exec(a[0]); if (!m || !isIp(m[1])) return 'Error: invalid prefix'; x.ip = m[1]; x.len = +m[2]; return ''; }
  if ((a = M(t, ['ip', 'route', 'add', 'default', 'via', '<x>']))) { if (!isIp(a[0])) return 'Error: invalid gateway'; d.gw = a[0]; return ''; }
  if ((a = M(t, ['ping', '<*>']))) { const ip = a[0].filter(z => !z.startsWith('-') && !/^\d+$/.test(z)).pop(); if (!isIp(ip || '')) return 'ping: unknown host'; const out = ['PING ' + ip + ' (' + ip + ') 56(84) bytes of data.']; let ok = 0;
    for (let i = 1; i <= 4; i++) { const r = flow(L, d.name, { proto: 'icmp', dst: ip });
      if (r.ok) { ok++; const hops = r.path.slice(0, r.path.indexOf(r.dstDev)).filter(n => ['router', 'ftd'].includes(L.dev[n].type)).length; out.push('64 bytes from ' + ip + ': icmp_seq=' + i + ' ttl=' + (64 - hops) + ' time=' + (1 + hops * 1.3).toFixed(1) + ' ms'); }
      else if (r.kind === 'unreach' || r.kind === 'prohibited') out.push('From ' + (r.hopIp || r.at || 'gateway') + ' icmp_seq=' + i + ' Destination ' + (r.kind === 'prohibited' ? 'Host Prohibited' : 'Host Unreachable')); }
    out.push('--- ' + ip + ' ping statistics ---', '4 packets transmitted, ' + ok + ' received, ' + (100 - ok * 25) + '% packet loss'); return out.join('\n'); }
  if ((a = M(t, ['traceroute', '<x>']))) { if (!isIp(a[0])) return 'traceroute: unknown host'; return 'traceroute to ' + a[0] + ', 12 hops max\n' + traceroute(L, d.name, a[0]).map(h => ' ' + h.n + '  ' + (h.ip ? h.ip + '  1.2 ms' : '* * *')).join('\n'); }
  if (t[0] === 'curl') { let ua = '', url = null; for (let i = 1; i < t.length; i++) { if (t[i] === '-A') ua = t[++i] || ''; else if (!t[i].startsWith('-')) url = t[i]; }
    const u = url && parseUrl(url); if (!u) return 'curl: (6) Could not resolve host (use an IP address, e.g. curl http://203.0.113.10)';
    const blob = (ua + ' ' + url).toLowerCase(); const sig = BAD.find(b => blob.includes(b));
    const r = flow(L, d.name, { proto: 'tcp', dst: u.ip, dport: u.port, sig });
    if (r.ok) return '<html><body><h1>' + (r.page || 'OK') + '</h1></body></html>\n[HTTP/1.1 200 OK from ' + u.ip + ':' + u.port + ']';
    if (r.kind === 'closed') return 'curl: (7) Failed to connect to ' + u.ip + ' port ' + u.port + ': Connection refused';
    if (r.kind === 'unreach' || r.kind === 'prohibited') return 'curl: (7) Failed to connect to ' + u.ip + ' port ' + u.port + ': No route to host';
    return 'curl: (28) Connection timed out after 5001 milliseconds   [' + (r.why || '') + ']'; }
  if (t[0] === 'nmap') { const ip = t.filter(z => isIp(z)).pop(); if (!ip) return 'Usage: nmap [-Pn] [-p 22,80] <ip>'; const pi = t.indexOf('-p'); const ports = pi > 0 ? t[pi + 1].split(',').map(Number) : [21, 22, 23, 25, 53, 80, 110, 443, 3389, 8080];
    const up = t.includes('-Pn') || flow(L, d.name, { proto: 'icmp', dst: ip }).ok; if (!up) return 'Starting Nmap...\nNote: Host seems down. If it is really up, but blocking our ping probes, try -Pn\nNmap done: 1 IP address (0 hosts up)';
    const rows = [], cnt = { f: 0 }; for (const p of ports) { const r = flow(L, d.name, { proto: 'tcp', dst: ip, dport: p, sig: 'nmap-scan' }); const st = r.ok ? 'open' : r.kind === 'closed' ? 'closed' : 'filtered'; if (st === 'filtered') cnt.f++; if (st !== 'closed') rows.push(pad(p + '/tcp', 10) + pad(st, 10)); }
    return 'Starting Nmap against ' + ip + '\nPORT      STATE\n' + (rows.join('\n') || '(all ports closed)') + (cnt.f ? '\n(' + cnt.f + ' filtered ports hidden/listed above)' : '') + '\nNmap done: 1 IP address (host up)'; }
  return t[0] + ': command not found (type help)';
}

function exec(L, d, s, line) {
  const out = d.type === 'host' ? execHost(L, d, s, line) : d.type === 'router' ? execRouter(L, d, s, line) : d.type === 'asa' ? execAsa(L, d, s, line) : d.type === 'ftd' ? execFtd(L, d, s, line) : 'No CLI';
  return out;
}
function runLines(L, d, lines) {   // used by GUIs: run config lines in a fresh config session
  const s = { mode: 'config', ctx: null }; const out = [];
  for (const l of lines) { const o = exec(L, d, s, l); if (o && /^(ERROR|%)/.test(o)) out.push(l + ' -> ' + o); }
  return out;
}
const API = { newSession, prompt, exec, runLines, normIf };
root.Cli = API; if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
