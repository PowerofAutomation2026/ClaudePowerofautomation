/** POSTs a JSON message when a kpi crosses a threshold (and when it recovers). Point it at a Power Automate HTTP flow, Teams workflow, Slack, etc. */
export class Alerts {
  constructor(store, { url, linkFor, fetchImpl = fetch }) {
    this.url = url;
    if (!url) return;
    store.on('status', async (d, w, from, to) => {
      if (from === undefined && to === 'ok') return; // first reading, nothing to report
      const label = { crit: 'CRITICAL', warn: 'WARNING', ok: 'back to normal' }[to];
      const payload = {
        text: `${label}: "${w.title}" is ${w.value}${w.unit ?? ''} on dashboard "${d.title}"`,
        status: to, previousStatus: from ?? null, widget: w.title, value: w.value, unit: w.unit ?? '',
        dashboard: d.title, url: linkFor(d), at: new Date().toISOString(),
      };
      try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
        if (!r.ok) console.error(`alert webhook returned HTTP ${r.status}`);
      } catch (e) { console.error('alert webhook failed:', e.message); }
    });
  }
}
