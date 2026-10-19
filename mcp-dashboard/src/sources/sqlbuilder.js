/**
 * Builds parameterised SELECTs from a structured request. Identifiers are only ever taken from the database
 * catalog (never from agent text) and are quoted; values are always bound parameters.
 */
const NUMERIC = /^(int|integer|bigint|smallint|tinyint|decimal|numeric|float|real|double|money|smallmoney|number|binary_float|binary_double)/i;
const DATE_T = /^(date|datetime|datetime2|smalldatetime|timestamp)/i;
export const TABLE_AGGS = ['sum', 'avg', 'min', 'max', 'count'];
export const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'is_null', 'not_null'];
const OPS = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

export const quote = (dialect, id) => (dialect === 'sqlserver' ? `[${id.replace(/]/g, ']]')}]` : `"${id.replace(/"/g, '""')}"`);

function resolver(info) {
  const map = new Map(info.columns.map((c) => [c.name.toLowerCase(), c]));
  return (name) => {
    const c = map.get(String(name).toLowerCase());
    if (!c) throw new Error(`column "${name}" not found in ${info.schema}.${info.name}. Columns: ${info.columns.map((x) => x.name).join(', ')}`);
    return c;
  };
}

function where(dialect, info, filters = [], params) {
  const col = resolver(info);
  const ph = () => { const n = `p${Object.keys(params).length + 1}`; return [n, dialect === 'sqlserver' ? `@${n}` : `:${n}`]; };
  const bind = (c, raw) => {
    let v = raw;
    if (NUMERIC.test(c.type)) { v = Number(raw); if (!Number.isFinite(v)) throw new Error(`filter value "${raw}" is not a number for column ${c.name}`); }
    const [n, ref] = ph(); params[n] = v;
    return dialect === 'oracle' && DATE_T.test(c.type) && /^\d{4}-\d{2}-\d{2}/.test(String(raw)) ? `TO_DATE(SUBSTR(${ref},1,10),'YYYY-MM-DD')` : ref;
  };
  return filters.map((f) => {
    const c = col(f.column), id = quote(dialect, c.name);
    if (!FILTER_OPS.includes(f.op)) throw new Error(`filter op must be one of: ${FILTER_OPS.join(', ')}`);
    if (f.op === 'is_null') return `${id} IS NULL`;
    if (f.op === 'not_null') return `${id} IS NOT NULL`;
    if (f.value === undefined || f.value === '') throw new Error(`filter on ${c.name} needs a value`);
    if (f.op === 'contains') { const [n, ref] = ph(); params[n] = `%${f.value}%`; return `${id} LIKE ${ref}`; }
    if (f.op === 'in') {
      const vals = String(f.value).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
      return `${id} IN (${vals.map((v) => bind(c, v)).join(', ')})`;
    }
    return `${id} ${OPS[f.op]} ${bind(c, f.value)}`;
  });
}

function assemble(dialect, info, { select, filters, groupBy = [], orderBy = [], limit }) {
  const params = {};
  const conds = where(dialect, info, filters, params);
  const top = dialect === 'sqlserver' && limit ? `TOP (${Math.trunc(limit)}) ` : '';
  const sql = `SELECT ${top}${select.join(', ')} FROM ${quote(dialect, info.schema)}.${quote(dialect, info.name)}` +
    (conds.length ? ` WHERE ${conds.join(' AND ')}` : '') +
    (groupBy.length ? ` GROUP BY ${groupBy.join(', ')}` : '') +
    (orderBy.length ? ` ORDER BY ${orderBy.join(', ')}` : '') +
    (dialect === 'oracle' && limit ? ` FETCH FIRST ${Math.trunc(limit)} ROWS ONLY` : '');
  return { sql, params };
}

export const sampleQuery = (dialect, info) => assemble(dialect, info, { select: info.columns.slice(0, 12).map((c) => quote(dialect, c.name)), limit: 5 });

/** Turn a widget binding into { sql, params, resultBinding } where resultBinding tells compute() how to read the rows. */
export function planBinding(dialect, type, b, info) {
  const col = resolver(info), Q = (n) => quote(dialect, n);
  const filters = b.filters;
  const aggOf = (a) => { const x = a ?? 'sum'; if (!TABLE_AGGS.includes(x)) throw new Error(`agg "${x}" is not supported for tables (use ${TABLE_AGGS.join(', ')}, or a named query)`); return x; };

  if (type === 'kpi') {
    const agg = b.column ? aggOf(b.agg) : 'count';
    const expr = agg === 'count' && !b.column ? 'COUNT(*)' : `${agg.toUpperCase()}(${Q(col(b.column).name)})`;
    return { ...assemble(dialect, info, { select: [`${expr} AS ${Q('value')}`], filters }), resultBinding: { column: 'value', agg: 'first' } };
  }

  if (type === 'table') {
    const cols = (b.columns?.length ? b.columns.map((c) => col(c).name) : info.columns.slice(0, 12).map((c) => c.name)).slice(0, 12);
    const limit = Math.min(b.limit ?? 50, 500);
    const orderBy = b.order_by ? [`${Q(col(b.order_by).name)} ${b.desc ? 'DESC' : 'ASC'}`] : [];
    return { ...assemble(dialect, info, { select: cols.map(Q), filters, orderBy, limit }), resultBinding: { columns: cols, limit } };
  }

  // line | bar | pie
  if (!b.label) throw new Error('"label" is required for charts');
  const label = col(b.label).name;
  const valueCols = (b.values?.length ? b.values : b.column ? [b.column] : []).map((v) => col(v).name);
  const grouped = b.group !== false;
  const agg = valueCols.length ? aggOf(b.agg) : 'count';
  const sort = b.sort ?? (type === 'line' ? 'label' : type === 'pie' ? 'value_desc' : 'none');
  const limit = Math.min(b.limit ?? (type === 'pie' ? 8 : 30), 500);
  const aliases = valueCols.length ? valueCols.map((v) => (v === label ? `${v}_${agg}` : v)) : ['Count'];
  const select = [Q(label), ...(valueCols.length
    ? valueCols.map((v, i) => (grouped ? `${agg.toUpperCase()}(${Q(v)}) AS ${Q(aliases[i])}` : `${Q(v)} AS ${Q(aliases[i])}`))
    : ['COUNT(*) AS ' + Q('Count')])];
  const orderBy = sort === 'value_desc' ? [`${Q(aliases[0])} DESC`] : sort === 'value_asc' ? [`${Q(aliases[0])} ASC`]
    : [`${Q(label)} ${type === 'line' && sort === 'label' ? 'DESC' : 'ASC'}`]; // line: newest N points, compute() re-sorts ascending
  const planned = assemble(dialect, info, { select, filters, groupBy: grouped ? [Q(label)] : [], orderBy, limit });
  return { ...planned, resultBinding: { label, values: aliases, group: false, sort, limit } };
}
