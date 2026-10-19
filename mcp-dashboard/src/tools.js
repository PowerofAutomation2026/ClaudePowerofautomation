import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WIDGET_TYPES } from './store.js';

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

export function createServer(store, urlFor) {
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
