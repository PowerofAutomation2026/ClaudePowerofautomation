// SCOR Lab Simulator - GUI toolkit shared by all product GUIs (shell, widgets, CLI page)
(function (root) {
'use strict';
const K = root.GUIK = {};
K.A = () => root.App; K.S = root.Sim; K.C = root.Cli; K.L = () => root.App.L; K.NS = {};
K.clone = o => JSON.parse(JSON.stringify(o));
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) { if (k === 'class') e.className = attrs[k]; else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]); }
  for (const c of kids.flat(3)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
K.h = h;
K.sel = (opts, v) => h('select', {}, opts.map(o => Array.isArray(o) ? h('option', { value: o[0], selected: o[0] === v }, o[1]) : h('option', { value: o, selected: o === v }, o)));
K.inp = (v, ph, w) => h('input', { value: v == null ? '' : v, placeholder: ph || '', style: w ? 'width:' + w : '' });
K.tbl = (head, rows) => h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, head.map(x => h('th', {}, x)))), h('tbody', {}, rows));
K.btn = (t, f, cls) => h('button', { class: 'pb ' + (cls || ''), onclick: f }, t);
K.chk = (v, f) => { const c = h('input', { type: 'checkbox' }); c.checked = !!v; if (f) c.addEventListener('change', () => f(c.checked)); return c; };
K.row = (...k) => h('div', { class: 'prow' }, k);
K.panel = (title, ...k) => h('div', { class: 'ppanel' }, title ? h('div', { class: 'phead' }, title) : null, h('div', { class: 'pbody' }, k));
K.note = t => h('p', { class: 'pnote' }, t);
K.pre = t => h('pre', { class: 'ppre' }, t);
K.badge = (t, cls) => h('span', { class: 'pbadge ' + (cls || '') }, t);
K.tiles = arr => h('div', { class: 'ptiles' }, arr.map(([k, v]) => h('div', { class: 'ptile' }, h('b', {}, v), h('span', {}, k))));
K.bars = (items, empty) => { const max = Math.max(1, ...items.map(i => i[1])); return items.length ? h('div', { class: 'pbars' }, items.map(([k, v]) => h('div', { class: 'pbar' }, h('span', { class: 'bl' }, k), h('span', { class: 'bt' }, h('i', { style: 'width:' + Math.max(3, v / max * 100) + '%' })), h('span', { class: 'bv' }, v)))) : K.note(empty || 'No data yet.'); };
K.cliOut = (d, c) => K.A().cliOut(d, c);
K.field = (label, el) => h('label', { class: 'pfield' }, h('span', {}, label), el);
K.chips = (arr, onRemove) => arr.length ? arr.map((x, i) => h('span', { class: 'chip' }, x, onRemove ? h('button', { class: 'x', onclick: () => onRemove(i) }, '✕') : null)) : h('span', { class: 'dim' }, '(none)');
// multi-select list with optional free-text entries; returns element with .get()
K.multi = (opts, selected, o) => {
  o = o || {}; const sel = new Set(selected || []), box = h('div', { class: 'pmulti' }), extra = [];
  const list = h('div', { class: 'pmlist' }); const draw = () => { list.innerHTML = ''; [...opts, ...extra.filter(x => !opts.includes(x))].forEach(x => list.append(h('label', {}, K.chk(sel.has(x), v => v ? sel.add(x) : sel.delete(x)), ' ' + x))); };
  draw(); box.append(list);
  if (o.custom) { const t = K.inp('', o.custom, '150px'); box.append(h('div', { class: 'prow' }, t, K.btn('Add', () => { const v = t.value.trim(); if (v) { extra.push(v); sel.add(v); t.value = ''; draw(); } }))); }
  box.get = () => [...sel]; return box;
};
// ---------- shell ----------
K.shell = function (o) {
  const NS = K.NS, A = K.A, st = NS[o.key] = NS[o.key] || { m: o.nav[0].id, s: o.nav[0].pages[0].id };
  let mn = o.nav.find(x => x.id === st.m); if (!mn && !st.m.startsWith('_')) { st.m = o.nav[0].id; mn = o.nav[0]; }
  if (mn && !mn.pages.find(p => p.id === st.s)) st.s = mn.pages[0].id;
  const go = (m, s) => { st.m = m; st.s = s || (o.nav.find(x => x.id === m) || { pages: [{ id: '' }] }).pages[0].id; A().refreshWins(); };
  const special = st.m.startsWith('_');
  const hdr = h('div', { class: 'phdr' }, h('div', { class: 'pbrand' }, h('b', {}, o.brand), o.sub ? h('span', {}, o.sub) : null),
    o.layout === 'left' ? null : h('div', { class: 'pmenu' }, o.nav.map(m => h('button', { class: !special && st.m === m.id ? 'on' : '', onclick: () => go(m.id) }, m.label))),
    h('div', { class: 'pright' }, o.right ? o.right(go) : null));
  const pg = (m, p) => h('div', { class: 'pcrumb' }, m, p ? ' › ' + p.label : '', p && p.tag ? K.badge(p.tag, 'cfgonly') : null);
  let body; const content = () => o.page(st.m, st.s, go);
  if (o.layout === 'toptabs') {
    body = h('div', { class: 'pmain' }, special ? null : h('div', { class: 'ptabs' }, mn.pages.map(p => h('button', { class: st.s === p.id ? 'on' : '', onclick: () => go(st.m, p.id) }, p.label))),
      special ? null : pg(mn.label, mn.pages.find(p => p.id === st.s)), h('div', { class: 'pcontent' }, content()));
  } else {
    const groups = o.layout === 'topleft' ? (mn ? [mn] : []) : o.nav;
    const tree = h('div', { class: 'ptree' }, groups.map(g => h('div', { class: 'tgrp' }, o.layout === 'left' ? h('div', { class: 'tgh' }, g.label) : null, g.pages.map(p => h('div', { class: 'tnode' + (st.m === g.id && st.s === p.id ? ' on' : ''), onclick: () => go(g.id, p.id) }, p.label)))));
    body = h('div', { class: 'psplit' }, tree, h('div', { class: 'pmain' }, special ? null : pg(mn.label, mn.pages.find(p => p.id === st.s)), h('div', { class: 'pcontent' }, content())));
  }
  return h('div', { class: 'prod ' + o.cls }, hdr, body, o.status ? h('div', { class: 'pstat' }, o.status) : null);
};
// ---------- CLI inside the GUI ----------
K.cliPage = function (d, title) {
  const A = K.A, C = K.C, L = K.L(), key = 'cli' + d.name, st = K.NS[key] = K.NS[key] || { s: C.newSession(d), out: [], hist: [], hi: 0 };
  const out = h('pre', { class: 'ppre cli' }), pr = h('span', { class: 'clip' }, C.prompt(d, st.s)), inp = h('input', { class: 'cliin', spellcheck: 'false', placeholder: 'type a command  (?  help,  Tab  completes)' });
  const draw = () => { out.textContent = st.out.slice(-200).join('\n'); out.scrollTop = out.scrollHeight; pr.textContent = C.prompt(d, st.s); };
  const echo = t => st.out.push(C.prompt(d, st.s) + t);
  const run = () => { const line = inp.value; echo(line); inp.value = ''; if (line.trim()) { st.hist.push(line); st.hi = st.hist.length; } const r = C.exec(K.L(), d, st.s, line); if (r) st.out.push(r); draw(); A().afterCfg(); };
  inp.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') run();
    else if (ev.key === '?') { ev.preventDefault(); echo(inp.value + '?'); st.out.push(C.help(K.L(), d, st.s, inp.value)); draw(); }
    else if (ev.key === 'Tab') { ev.preventDefault(); const r = C.complete(K.L(), d, st.s, inp.value); if (r.line !== undefined) inp.value = r.line; if (r.options && r.options.length > 1) { echo(inp.value); st.out.push(r.options.join('   ')); draw(); } }
    else if (ev.key === 'ArrowUp') { if (st.hi > 0) inp.value = st.hist[--st.hi]; ev.preventDefault(); }
    else if (ev.key === 'ArrowDown') { inp.value = st.hi < st.hist.length - 1 ? st.hist[++st.hi] : ''; ev.preventDefault(); }
  });
  draw(); if (!st.out.length) { st.out.push((title || 'Command line interface') + ' - same commands as the device console. Type "enable" first for privileged commands.'); draw(); }
  return K.panel(title || 'Command Line Interface', out, h('div', { class: 'prow' }, pr, inp, K.btn('Send', run, 'pri')), K.note('Anything the GUI cannot do can be configured here. Changes are live.'));
};
K.toolsPane = function (d) {
  const t = K.inp('10.1.1.1', 'target IP', '130px'), out = K.pre('Run ping or traceroute from this device.');
  const run = c => { K.A().setAnim(null); out.textContent = K.cliOut(d, c + ' ' + t.value); K.A().afterTool(); };
  return K.panel('Ping / Traceroute', K.row('Target IP', t, K.btn('Ping', () => run('ping'), 'pri'), K.btn('Traceroute', () => run('traceroute'))), out);
};
K.wild = len => K.S.n2ip((~K.S.ip2n(K.S.lenToMask(len))) >>> 0);
K.pick = (obj, keys) => { const r = {}; keys.forEach(k => r[k] = obj[k]); return r; };
})(window);
