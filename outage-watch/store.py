"""Compact SQLite mirror of the probe log for long-range uptime / SLA queries (stdlib sqlite3).

The hash-chained JSONL stays the evidence log. This database is a convenience copy that can be
deleted and rebuilt (`import_jsonl`), with a retention limit so it stays small. Queries are
aggregated inside SQLite, so a 30-day view never loads the raw history into Python.
"""
import json
import sqlite3
import time
from datetime import datetime

WINDOWS = (("24h", 86400), ("7d", 7 * 86400), ("30d", 30 * 86400))
ANSWERED = ("up", "warning")


def connect(path):
    db = sqlite3.connect(path, timeout=10, check_same_thread=False)
    db.execute("CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, service TEXT NOT NULL, "
               "state TEXT NOT NULL, ms INTEGER NOT NULL, maint INTEGER NOT NULL DEFAULT 0)")
    db.execute("CREATE INDEX IF NOT EXISTS samples_svc_ts ON samples (service, ts)")
    db.commit()
    return db


def _epoch(ts):
    return int(datetime.fromisoformat(ts).timestamp())


def add_round(db, ts, results, published, maint=()):
    t = _epoch(ts)
    db.executemany("INSERT INTO samples VALUES (?,?,?,?,?)",
                   [(t, r["name"], published.get(r["name"], r["state"]), int(r["ms"]), int(r["name"] in maint))
                    for r in results])
    db.commit()


def purge(db, retention_days, now=None):
    cur = db.execute("DELETE FROM samples WHERE ts < ?", (int((now or time.time()) - retention_days * 86400),))
    db.commit()
    return cur.rowcount


def import_jsonl(db, path):
    """Stream a JSONL log into the store, one line at a time. Returns rows read."""
    n = 0
    with open(path) as f:
        for line in f:
            try:
                r = json.loads(line)
                add = [(_epoch(r["ts"]), x["name"], (r.get("published") or {}).get(x["name"], x["state"]),
                        int(x["ms"]), int(x["name"] in (r.get("maintenance") or []))) for x in r["results"]
                       if x["state"] != "unconfigured"]
            except (ValueError, KeyError, TypeError):
                continue
            db.executemany("INSERT INTO samples VALUES (?,?,?,?,?)", add)
            n += 1
    db.commit()
    return n


def _pct(db, svc, since, q, extra):
    n = db.execute(f"SELECT COUNT(*) FROM samples WHERE service=? AND ts>=? AND state IN ('up','warning'){extra}",
                   (svc, since)).fetchone()[0]
    if not n:
        return None
    row = db.execute(f"SELECT ms FROM samples WHERE service=? AND ts>=? AND state IN ('up','warning'){extra} "
                     "ORDER BY ms LIMIT 1 OFFSET ?", (svc, since, min(n - 1, int(q * n)))).fetchone()
    return row[0]


def sla(db, now=None, exclude_maintenance=True):
    """{service: {window: {"uptime": % or None, "samples": n, "p50": ms, "p95": ms, "maint": n}}}.

    uptime = answered probes (up or warning) / probes that count. Blocked probes never count
    (your own proxy refused them); maintenance samples are left out when exclude_maintenance.
    It is the share of PROBE ROUNDS answered, so its resolution is the probe interval."""
    now = int(now or time.time())
    extra = " AND maint=0" if exclude_maintenance else ""
    out = {}
    for label, span in WINDOWS:
        since = now - span
        if exclude_maintenance:
            q = ("SELECT service, SUM(CASE WHEN maint=0 AND state IN ('up','warning') THEN 1 ELSE 0 END), "
                 "SUM(CASE WHEN maint=0 AND state != 'blocked' THEN 1 ELSE 0 END), SUM(maint) "
                 "FROM samples WHERE ts>=? GROUP BY service")
        else:
            q = ("SELECT service, SUM(CASE WHEN state IN ('up','warning') THEN 1 ELSE 0 END), "
                 "SUM(CASE WHEN state != 'blocked' THEN 1 ELSE 0 END), SUM(maint) "
                 "FROM samples WHERE ts>=? GROUP BY service")
        rows = db.execute(q, (since,)).fetchall()
        for svc, ok, total, m in rows:
            out.setdefault(svc, {})[label] = {
                "uptime": round(100.0 * ok / total, 3) if total else None, "samples": total or 0, "maint": m or 0,
                "p50": _pct(db, svc, since, 0.5, extra), "p95": _pct(db, svc, since, 0.95, extra)}
    return out


def sla_csv(data):
    lines = ["service,window,uptime_percent,samples,maintenance_samples,p50_ms,p95_ms"]
    for svc in sorted(data):
        for label, _ in WINDOWS:
            w = data[svc].get(label)
            if w:
                name = '"' + svc.replace('"', '""') + '"'
                if svc[:1] in "=+-@":                      # do not let a service name become a spreadsheet formula
                    name = '"\'' + name[1:]
                lines.append(",".join([name, label] + ["" if w[k] is None else str(w[k])
                                                        for k in ("uptime", "samples", "maint", "p50", "p95")]))
    return "\n".join(lines) + "\n"


def sla_markdown(data, exclude_maintenance=True):
    lines = ["## Uptime / SLA", "",
             "Share of probe rounds answered (up or warning). Blocked probes are not counted"
             + ("; samples inside maintenance windows are excluded." if exclude_maintenance else "; maintenance samples are INCLUDED."),
             "", "| Service | " + " | ".join(f"{l} uptime | {l} p50/p95 ms" for l, _ in WINDOWS) + " |",
             "|---|" + "---|---|" * len(WINDOWS)]
    for svc in sorted(data):
        cells = []
        for label, _ in WINDOWS:
            w = data[svc].get(label)
            cells += ["n/a", "n/a"] if not w or w["uptime"] is None else \
                [f"{w['uptime']:.3f}% ({w['samples']})", f"{w['p50']}/{w['p95']}" if w["p50"] is not None else "n/a"]
        lines.append(f"| {svc.replace('|', '/')} | " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"
