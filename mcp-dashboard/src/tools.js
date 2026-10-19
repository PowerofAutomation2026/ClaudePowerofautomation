import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WIDGET_TYPES } from './store.js';
import { generateDashboardSpec } from './ai.js';
import { compute, AGGS } from './binding.js';
import { Registry } from './sources/index.js';

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e.message ?? String(e) }] });
const guard = (fn) => async (args, extra) => { try { return await fn(args, extra); } catch (e) { return fail(e); } };

// Flat, simple schemas on purpose: Copilot Studio's orchestrator fills these in far more reliably than nested unions.
const widgetFields = {
  type: z.enum(WIDGET_TYPES).describe('kpi = big number, line/bar = chart over labels, pie = share of total, table, text = note/markdown-ish paragraph'),
  title: z.string().describe('Widget heading'),
  widget_id: z.string().optional().describe('Existing widget id to update in place. Omit to create a new widget.'),
  span: z.number().int().min(1).max(4).optional().describe('Grid columns to span (1-4). Default 1 for kpi, 2 for charts, 4 for tables.'),
  subtitle: z.string().optional(),
  value: z.union([z.number(), z.string()]).optional().describe('kpi: the headline number, e.g. 1284 or "98.2"'),
  unit: z.string().optional().describe('kpi/chart unit suffix, e.g. "%", "ms", "$"'),
  delta: z.number().optional().describe('kpi: change vs. previous period, e.g. 4.2 or -1.5'),
  good_direction: z.enum(['up', 'down']).optional().describe('kpi: whether an increase is good (default up). Controls green/red colouring of delta.'),
  labels: z.array(z.string()).optional().describe('line/bar/pie: x-axis labels or slice names'),
  values: z.array(z.number()).optional().describe('line/bar/pie: one number per label (single series)'),
  series_name: z.string().optional().describe('Name for the single series given in "values"'),
  series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })).optional()
    .describe('line/bar: multiple series; each has one number per label. Use instead of "values".'),
  columns: z.array(z.string()).optional().describe('table: column headers'),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional().describe('table: rows of cells matching columns'),
  text: z.string().optional().describe('text widget body'),
};

const defaultSpan = { kpi: 1, line: 2, bar: 2, pie: 2, table: 4, text: 2 };

export function createServer(store, urlFor, { generate = generateDashboardSpec, sources = new Registry({}), engine = null } = {}) {
  const server = new McpServer(
    { name: 'live-dashboard', version: '1.0.0' },
    {
      instructions:
        'Build and update live dashboards. Typical flow: build_dashboard (one call, with widgets) -> give the user the returned "url". ' +
        'The page updates in real time, so to refresh numbers call upsert_widget with the widget_id, or append_point for streaming series. ' +
        'Always share the full url with the user; never invent one.',
    },
  );

  const view = (d, extra) => ({
    id: d.id, title: d.title, url: urlFor(d, extra), updatedAt: d.updatedAt,
    widgets: d.widgets.map((w) => ({ id: w.id, type: w.type, title: w.title })),
  });

  server.registerTool('build_dashboard', {
    title: 'Build a live dashboard',
    description: 'Create a dashboard with all its widgets in a single call and return the shareable live url. Prefer this over create_dashboard + many upsert_widget calls.',
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      widgets: z.array(z.object(widgetFields)).min(1).max(30),
    },
  }, guard(({ title, description, widgets }, extra) => {
    const d = store.create({ title, description });
    try {
      for (const w of widgets) store.upsertWidget(d.id, { ...w, span: w.span ?? defaultSpan[w.type] });
    } catch (e) { store.delete(d.id); throw e; }
    return text(view(d, extra));
  }));

  server.registerTool('generate_dashboard', {
    title: 'Generate a dashboard with Claude',
    description: 'Describe the dashboard you want and optionally paste raw data (CSV, JSON or text). This server asks Claude (Anthropic) to design the dashboard, computes the KPIs/charts/tables from the data, and returns the live url. ' +
      'Pass dashboard_id to regenerate an existing dashboard in place, so its link stays the same.',
    inputSchema: {
      prompt: z.string().describe('What the dashboard should show, e.g. "Weekly sales by region with top 10 customers"'),
      data: z.string().optional().describe('Raw data to base it on: CSV, JSON or plain text'),
      dashboard_id: z.string().optional().describe('Existing dashboard to rebuild in place'),
    },
  }, guard(async ({ prompt, data, dashboard_id }, extra) => {
    const old = dashboard_id ? store.get(dashboard_id) : null;
    const spec = await generate({ prompt, data, existing: old && { title: old.title, widgets: old.widgets.map(({ id, ...w }) => w) } });
    const d = old ?? store.create({ title: spec.title, description: spec.description });
    const before = old ? structuredClone(old.widgets) : [];
    try {
      if (old) { old.widgets = []; store.update(d.id, { title: spec.title, description: spec.description }); }
      for (const w of spec.widgets) store.upsertWidget(d.id, { ...w, span: w.span ?? defaultSpan[w.type] });
    } catch (e) {
      if (old) { old.widgets = before; store.update(d.id, {}); } else store.delete(d.id);
      throw e;
    }
    return text(view(d, extra));
  }));

  server.registerTool('list_datasources', {
    title: 'List data sources',
    description: 'List the data sources the server admin has connected (CSV, Excel, SQL Server, Oracle, Power Automate flows) with their named queries. Use bind_widget to make a widget auto-refresh from one.',
    inputSchema: {},
  }, guard(() => text(sources.list().length ? sources.list() : 'No data sources are configured on this server (see datasources.example.json).')));

  server.registerTool('describe_datasource', {
    title: 'Preview a data source',
    description: 'Fetch a data source now and return its column names, row count and the first 5 rows, so you can choose columns for bind_widget.',
    inputSchema: { source: z.string(), query: z.string().optional().describe('Named query (SQL Server / Oracle / flow sources)') },
  }, guard(async ({ source, query }) => {
    const rows = await sources.fetchRows(source, query);
    return text({ rowCount: rows.length, columns: Object.keys(rows[0] ?? {}), sample: rows.slice(0, 5) });
  }));

  server.registerTool('bind_widget', {
    title: 'Bind a widget to a live data source',
    description: 'Create (or update, with widget_id) a widget whose data comes from a configured data source and refreshes automatically while the dashboard is open. ' +
      'kpi: column + agg. line/bar/pie: label column + values column(s) + agg (rows are grouped by label). table: columns, order_by, limit. Call describe_datasource first to see the column names.',
    inputSchema: {
      dashboard_id: z.string(), widget_id: z.string().optional(),
      type: z.enum(['kpi', 'line', 'bar', 'pie', 'table']), title: z.string(),
      source: z.string().describe('Data source name from list_datasources'),
      query: z.string().optional().describe('Named query, required when the source has several'),
      column: z.string().optional().describe('kpi: column to aggregate'),
      agg: z.enum(AGGS).optional().describe('sum (default), avg, min, max, count, first, last'),
      label: z.string().optional().describe('line/bar/pie: column for x-axis labels or slice names'),
      values: z.array(z.string()).optional().describe('line/bar/pie: one or more numeric columns'),
      group: z.boolean().optional().describe('line/bar/pie: group rows by label and aggregate (default true)'),
      sort: z.enum(['none', 'label', 'value_desc', 'value_asc']).optional(),
      limit: z.number().int().min(1).max(500).optional().describe('Max points/rows to show'),
      columns: z.array(z.string()).optional().describe('table: columns to show (default all, max 12)'),
      order_by: z.string().optional().describe('table: column to sort by'), desc: z.boolean().optional(),
      unit: z.string().optional(), subtitle: z.string().optional(), span: z.number().int().min(1).max(4).optional(),
    },
  }, guard(async (a, extra) => {
    const { dashboard_id, widget_id, type, title, source, query, unit, subtitle, span, ...mapping } = a;
    store.get(dashboard_id);
    const binding = { source, ...(query && { query }), ...Object.fromEntries(Object.entries(mapping).filter(([, v]) => v !== undefined)) };
    const rows = await sources.fetchRows(source, query);
    if (!rows.length) throw new Error('The data source returned no rows, so there is nothing to chart yet.');
    const data = compute(type, binding, rows); // validates the column mapping with a readable error
    const w = store.upsertWidget(dashboard_id, { widget_id, type, title, unit, subtitle, span: span ?? defaultSpan[type], ...data, good_direction: undefined }, { silent: true });
    w.binding = binding; w.refreshedAt = new Date().toISOString(); delete w.error;
    const d = store.get(dashboard_id);
    store.touch(d, { kind: 'widget', id: w.id });
    engine?.ensure(source);
    return text({ widget_id: w.id, url: urlFor(d, extra), refreshEverySeconds: sources.refreshSeconds(source), preview: data });
  }));

  server.registerTool('refresh_now', {
    title: 'Refresh bound widgets now',
    description: 'Re-read the data sources for every bound widget on a dashboard immediately, instead of waiting for the next automatic refresh.',
    inputSchema: { dashboard_id: z.string() },
  }, guard(async ({ dashboard_id }) => {
    if (!engine) throw new Error('Data sources are not enabled on this server.');
    engine.lastRun.delete(dashboard_id);
    await engine.refreshDashboard(dashboard_id);
    return text('refreshed');
  }));

  server.registerTool('create_dashboard', {
    title: 'Create an empty dashboard',
    description: 'Create an empty dashboard and return its live url. Add widgets with upsert_widget.',
    inputSchema: { title: z.string(), description: z.string().optional() },
  }, guard((a, extra) => text(view(store.create(a), extra))));

  server.registerTool('list_dashboards', {
    title: 'List dashboards',
    description: 'List existing dashboards with their ids, live urls and widgets.',
    inputSchema: {},
  }, guard((_a, extra) => text(store.list().map((d) => view(d, extra)))));

  server.registerTool('get_dashboard', {
    title: 'Get a dashboard',
    description: 'Return the full current content of a dashboard (all widget data).',
    inputSchema: { dashboard_id: z.string() },
  }, guard(({ dashboard_id }, extra) => {
    const d = store.get(dashboard_id);
    return text({ ...view(d, extra), description: d.description, widgets: d.widgets });
  }));

  server.registerTool('upsert_widget', {
    title: 'Add or update a widget',
    description: 'Add a widget, or update one in place by passing its widget_id. Only the fields you pass change. Viewers see the update instantly.',
    inputSchema: { dashboard_id: z.string(), ...widgetFields, type: widgetFields.type.optional(), title: z.string().optional() },
  }, guard(({ dashboard_id, ...w }, extra) => {
    const existing = w.widget_id && store.get(dashboard_id).widgets.some((x) => x.id === w.widget_id);
    const widget = store.upsertWidget(dashboard_id, { ...w, span: w.span ?? (existing ? undefined : defaultSpan[w.type]) });
    if (widget.binding && ['value', 'labels', 'values', 'series', 'columns', 'rows'].some((k) => w[k] !== undefined)) delete widget.binding; // static data replaces a live binding
    return text({ widget_id: widget.id, url: urlFor(store.get(dashboard_id), extra) });
  }));

  server.registerTool('append_point', {
    title: 'Append a live data point',
    description: 'Push one new point onto a line or bar widget (e.g. a new reading every minute). Oldest points roll off past max_points. New series names are created automatically.',
    inputSchema: {
      dashboard_id: z.string(), widget_id: z.string(),
      label: z.string().describe('x-axis label for the new point, e.g. a timestamp'),
      values: z.record(z.number()).describe('Map of series name -> value, e.g. {"Requests": 120}'),
      max_points: z.number().int().min(2).max(500).optional().describe('Keep only the newest N points (default 60)'),
    },
  }, guard(({ dashboard_id, widget_id, label, values, max_points }) => {
    const w = store.appendPoint(dashboard_id, widget_id, label, values, max_points);
    return text({ widget_id: w.id, points: w.labels.length });
  }));

  server.registerTool('remove_widget', {
    title: 'Remove a widget',
    description: 'Delete one widget from a dashboard.',
    inputSchema: { dashboard_id: z.string(), widget_id: z.string() },
  }, guard(({ dashboard_id, widget_id }) => { store.removeWidget(dashboard_id, widget_id); return text('removed'); }));

  server.registerTool('update_dashboard', {
    title: 'Rename a dashboard',
    description: 'Change a dashboard title or description.',
    inputSchema: { dashboard_id: z.string(), title: z.string().optional(), description: z.string().optional() },
  }, guard(({ dashboard_id, ...patch }, extra) => text(view(store.update(dashboard_id, patch), extra))));

  server.registerTool('delete_dashboard', {
    title: 'Delete a dashboard',
    description: 'Permanently delete a dashboard and its public link.',
    inputSchema: { dashboard_id: z.string() },
  }, guard(({ dashboard_id }) => { store.delete(dashboard_id); return text('deleted'); }));

  return server;
}
