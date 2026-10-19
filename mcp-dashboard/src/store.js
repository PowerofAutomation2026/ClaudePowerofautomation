import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const WIDGET_TYPES = ['kpi', 'line', 'bar', 'pie', 'table', 'text'];
const MAX_POINTS = 500;
const MAX_ROWS = 500;

const rid = (n = 6) => randomBytes(n).toString('hex');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : null);

/** In-memory dashboards with debounced JSON persistence and change events for live viewers. */
export class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.dashboards = new Map();
    this.timer = null;
    if (file) this.load();
  }

  load() {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const d of data.dashboards ?? []) this.dashboards.set(d.id, d);
    } catch { /* first run */ }
  }

  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ dashboards: [...this.dashboards.values()] }));
        renameSync(tmp, this.file);
      } catch (e) { console.error('persist failed:', e.message); }
    }, 300);
    this.timer.unref?.();
  }

  touch(d, change) {
    d.updatedAt = new Date().toISOString();
    this.save();
    this.emit('change', d.id, change);
  }

  viewers = new Map();
  viewerCount(id) { return this.viewers.get(id) ?? 0; }
  viewerJoin(id) { const n = this.viewerCount(id) + 1; this.viewers.set(id, n); this.emit('viewer', id, n); }
  viewerLeave(id) { const n = Math.max(0, this.viewerCount(id) - 1); n ? this.viewers.set(id, n) : this.viewers.delete(id); this.emit('viewer', id, n); }

  create({ title, description = '' }) {
    const d = {
      id: rid(5), token: rid(12), title: String(title).slice(0, 120), description: String(description).slice(0, 500),
      widgets: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this.dashboards.set(d.id, d);
    this.save();
    return d;
  }

  get(id) {
    const d = this.dashboards.get(id);
    if (!d) throw new Error(`Dashboard "${id}" not found. Call list_dashboards to see valid ids.`);
    return d;
  }

  list() { return [...this.dashboards.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }

  update(id, patch) {
    const d = this.get(id);
    if (patch.title) d.title = String(patch.title).slice(0, 120);
    if (patch.description !== undefined) d.description = String(patch.description).slice(0, 500);
    this.touch(d, { kind: 'meta' });
    return d;
  }

  delete(id) {
    this.get(id);
    this.dashboards.delete(id);
    this.save();
    this.emit('change', id, { kind: 'deleted' });
  }

  /** Create or merge a widget. Omitted fields keep their current value when the widget already exists. */
  upsertWidget(id, input, { silent = false } = {}) {
    const d = this.get(id);
    const existing = input.widget_id ? d.widgets.find((w) => w.id === input.widget_id) : null;
    const type = input.type ?? existing?.type;
    if (!WIDGET_TYPES.includes(type)) throw new Error(`type must be one of: ${WIDGET_TYPES.join(', ')}`);
    const w = existing ?? { id: input.widget_id || rid(3), type, title: '' };
    w.type = type;
    if (input.title !== undefined) w.title = String(input.title).slice(0, 120);
    if (input.span !== undefined) w.span = Math.min(4, Math.max(1, Math.round(input.span)));
    if (input.subtitle !== undefined) w.subtitle = String(input.subtitle).slice(0, 200);

    if (type === 'kpi') {
      if (input.value !== undefined) w.value = input.value;
      if (input.unit !== undefined) w.unit = String(input.unit).slice(0, 12);
      if (input.delta !== undefined) w.delta = num(input.delta);
      if (input.good_direction !== undefined) w.goodDirection = input.good_direction;
      if (w.value === undefined) throw new Error('kpi widgets need "value"');
    } else if (type === 'text') {
      if (input.text !== undefined) w.text = String(input.text).slice(0, 4000);
      if (w.text === undefined) throw new Error('text widgets need "text"');
    } else if (type === 'table') {
      if (input.columns !== undefined) w.columns = input.columns.map(String);
      if (input.rows !== undefined) w.rows = input.rows.slice(-MAX_ROWS).map((r) => r.map((c) => (c ?? '')));
      if (!w.columns?.length) throw new Error('table widgets need "columns"');
      w.rows ??= [];
    } else {
      // line | bar | pie share the labels + series model
      if (input.series !== undefined || input.values !== undefined || input.labels !== undefined) {
        const labels = input.labels ?? w.labels ?? [];
        let series = input.series;
        if (!series && input.values) series = [{ name: input.series_name ?? w.series?.[0]?.name ?? w.title ?? 'Value', values: input.values }];
        series ??= w.series ?? [];
        for (const s of series) {
          if (s.values.length !== labels.length) {
            throw new Error(`series "${s.name}" has ${s.values.length} values but there are ${labels.length} labels; they must match`);
          }
        }
        w.labels = labels.map(String).slice(-MAX_POINTS);
        w.series = series.map((s) => ({ name: String(s.name), values: s.values.map(num).slice(-MAX_POINTS) }));
      }
      if (!w.series?.length) throw new Error(`${type} widgets need "labels" and "values" (or "series")`);
      if (input.unit !== undefined) w.unit = String(input.unit).slice(0, 12);
    }
    if (!existing) d.widgets.push(w);
    if (!silent) this.touch(d, { kind: 'widget', id: w.id });
    return w;
  }

  /** Append one live point to a line/bar widget. `values` maps series name -> number. */
  appendPoint(id, widgetId, label, values, maxPoints = 60) {
    const d = this.get(id);
    const w = d.widgets.find((x) => x.id === widgetId);
    if (!w) throw new Error(`Widget "${widgetId}" not found in dashboard ${id}`);
    if (!['line', 'bar'].includes(w.type)) throw new Error('append_point only works on line or bar widgets');
    w.labels ??= []; w.series ??= [];
    for (const name of Object.keys(values)) {
      if (!w.series.some((s) => s.name === name)) w.series.push({ name, values: new Array(w.labels.length).fill(null) });
    }
    w.labels.push(String(label));
    for (const s of w.series) s.values.push(num(values[s.name]));
    const cap = Math.min(MAX_POINTS, Math.max(2, maxPoints));
    if (w.labels.length > cap) {
      const drop = w.labels.length - cap;
      w.labels.splice(0, drop);
      for (const s of w.series) s.values.splice(0, drop);
    }
    this.touch(d, { kind: 'widget', id: w.id });
    return w;
  }

  removeWidget(id, widgetId) {
    const d = this.get(id);
    const i = d.widgets.findIndex((w) => w.id === widgetId);
    if (i < 0) throw new Error(`Widget "${widgetId}" not found in dashboard ${id}`);
    d.widgets.splice(i, 1);
    this.touch(d, { kind: 'widget-removed', id: widgetId });
  }
}
