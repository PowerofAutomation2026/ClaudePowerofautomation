import Anthropic from '@anthropic-ai/sdk';
import { WIDGET_TYPES } from './store.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5';
const MAX_DATA_CHARS = 400_000;

// Structured-output schema: Claude must return exactly this shape, so the result always feeds store.upsertWidget.
const str = { type: 'string' };
const nums = { type: 'array', items: { type: 'number' } };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'widgets'],
  properties: {
    title: str,
    description: str,
    widgets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'title'],
        properties: {
          type: { type: 'string', enum: WIDGET_TYPES },
          title: str, subtitle: str, span: { type: 'integer' },
          value: str, unit: str, delta: { type: 'number' }, good_direction: { type: 'string', enum: ['up', 'down'] },
          labels: { type: 'array', items: str }, values: nums, series_name: str,
          series: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'values'], properties: { name: str, values: nums } } },
          columns: { type: 'array', items: str }, rows: { type: 'array', items: { type: 'array', items: str } },
          text: str,
        },
      },
    },
  },
};

const SYSTEM = `You design live dashboards. Turn the request and any raw data into a dashboard definition.
- Compute every number from the data provided; never invent figures. If the data cannot support a widget, leave it out.
- Lead with 3-4 "kpi" widgets for the headline numbers, then charts, then a "table" for detail, and an optional short "text" insight.
- Use "line" for trends over time, "bar" for comparisons, "pie" only for shares of a whole with at most 6 slices.
- kpi "value" is a string such as "1284" or "92.4"; set unit (%, $, ms) and delta only when the data supports a comparison.
- For line/bar/pie, labels and values (or every series) must have the same length. Tables: at most 50 rows, all cells strings.
- Keep titles short. Span: kpi 1, charts 2, table 4, text 2.`;

let client;

/** Ask Claude to design a dashboard. Returns { title, description, widgets }. */
export async function generateDashboardSpec({ prompt, data, existing }) {
  client ??= new Anthropic(); // resolves ANTHROPIC_API_KEY / auth profile from the environment
  const parts = [`Request:\n${prompt}`];
  if (data) parts.push(`Raw data (may be CSV, JSON or plain text):\n${String(data).slice(0, MAX_DATA_CHARS)}`);
  if (existing) parts.push(`This updates an existing dashboard. Current definition, for continuity:\n${JSON.stringify(existing)}`);

  let res;
  try {
    res = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: parts.join('\n\n') }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic authentication failed: set a valid ANTHROPIC_API_KEY on the MCP server.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached; try again shortly.');
    if (e instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${e.status}: ${e.message}`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to build this dashboard.');
  if (res.stop_reason === 'max_tokens') throw new Error('The dashboard was too large to generate; ask for fewer widgets or less data.');
  const block = res.content.find((b) => b.type === 'text');
  if (!block) throw new Error('Claude returned no dashboard definition.');
  return JSON.parse(block.text);
}
