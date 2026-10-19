import { compute } from './binding.js';

/**
 * Keeps bound widgets fresh. One timer per data source; each tick fetches each (source, query) once and
 * recomputes every widget bound to it. To protect databases, a dashboard is only polled while someone is
 * watching it (unless the registry says pollWithoutViewers), and a viewer joining triggers an immediate refresh.
 */
export class Engine {
  constructor(store, registry) {
    this.store = store; this.registry = registry;
    this.timers = new Map(); this.running = new Set(); this.lastRun = new Map();
    store.on('viewer', (id, count) => { if (count > 0) this.refreshDashboard(id).catch(() => {}); });
  }

  start() { for (const d of this.store.dashboards.values()) for (const w of d.widgets) if (w.binding) this.ensure(w.binding.source); }

  stop() { for (const t of this.timers.values()) clearInterval(t); this.timers.clear(); }

  ensure(source) {
    if (this.timers.has(source) || !this.registry.has(source)) return;
    const t = setInterval(() => this.tick(source), this.registry.refreshSeconds(source) * 1000);
    t.unref?.();
    this.timers.set(source, t);
  }

  bound(source, onlyDashboard) {
    const out = [];
    for (const d of this.store.dashboards.values()) {
      if (onlyDashboard && d.id !== onlyDashboard) continue;
      for (const w of d.widgets) if (w.binding?.source === source) out.push({ d, w });
    }
    return out;
  }

  async tick(source) {
    const all = this.bound(source);
    if (!all.length) { clearInterval(this.timers.get(source)); this.timers.delete(source); return; }
    const targets = this.registry.pollWithoutViewers ? all : all.filter(({ d }) => this.store.viewerCount(d.id) > 0);
    if (targets.length) await this.run(source, targets);
  }

  async refreshDashboard(id) {
    if (Date.now() - (this.lastRun.get(id) ?? 0) < 2000) return;
    this.lastRun.set(id, Date.now());
    const d = this.store.get(id);
    for (const source of new Set(d.widgets.filter((w) => w.binding).map((w) => w.binding.source))) await this.run(source, this.bound(source, id));
  }

  /** Refresh specific widgets now (used right after binding). */
  async refreshWidget(dashboardId, widgetId) {
    const d = this.store.get(dashboardId);
    const w = d.widgets.find((x) => x.id === widgetId);
    if (!w?.binding) return;
    this.ensure(w.binding.source);
    await this.run(w.binding.source, [{ d, w }], true);
  }

  async run(source, targets, throwOnError = false) {
    const key = `${source}:${targets.map((t) => t.w.id).join(',')}`;
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      const cache = new Map();
      for (const { d, w } of targets) {
        const q = w.binding.query ?? '';
        try {
          if (!cache.has(q)) cache.set(q, await this.registry.fetchRows(source, w.binding.query));
          this.apply(d, w, cache.get(q));
        } catch (e) {
          if (throwOnError) throw e;
          this.fail(d, w, e);
        }
      }
    } finally { this.running.delete(key); }
  }

  apply(d, w, rows) {
    const before = JSON.stringify([w.value, w.labels, w.series, w.columns, w.rows, w.error]);
    const data = compute(w.type, w.binding, rows);
    this.store.upsertWidget(d.id, { widget_id: w.id, ...data }, { silent: true });
    delete w.error;
    w.refreshedAt = new Date().toISOString();
    const changed = before !== JSON.stringify([w.value, w.labels, w.series, w.columns, w.rows, w.error]);
    changed ? this.store.touch(d, { kind: 'widget', id: w.id }) : this.store.emit('change', d.id, { kind: 'refresh' });
  }

  fail(d, w, e) {
    w.error = String(e.message).slice(0, 300);
    w.refreshedAt = new Date().toISOString();
    this.store.touch(d, { kind: 'widget', id: w.id });
  }
}
