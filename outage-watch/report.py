#!/usr/bin/env python3
"""Incident report from an outage-watch JSONL log (stdlib only).

Turns the raw timeline into per-service incidents with duration, worst state and the
EARLY-WARNING LEAD TIME: how long a `warning`/`suspect` preceded the confirmed `down`.
Use it to compare against Microsoft's post-incident report or to back an SLA claim.
Usage: python3 report.py outagewatch.jsonl [--md out.md]
"""
import argparse
import hashlib
import json
import sys
from datetime import datetime

RANK = {"up": 0, "warning": 1, "suspect": 2, "down": 3, "blocked": 1}


def _t(s):
    return datetime.fromisoformat(s)


def load(path):
    rows = []
    with open(path) as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                _t(r["ts"])
                rows.append(r)
            except (ValueError, KeyError):
                print(f"skipping bad line {i}", file=sys.stderr)
    return sorted(rows, key=lambda r: r["ts"])


def incidents(rows):
    """Per-service runs of non-up published state. Open runs end at the last sample."""
    out, open_ = [], {}
    for r in rows:
        ts = r["ts"]
        pub = r.get("published") or {x["name"]: x["state"] for x in r["results"]}
        maint, msh = r.get("maintenance") or [], r.get("ms_health") or {}
        for name, st in pub.items():
            cur = open_.get(name)
            if st != "up":
                if cur is None:
                    cur = open_[name] = {"service": name, "start": ts, "worst": st, "first_down": None,
                                         "ongoing": True, "maintenance": False, "ms_seen": False, "ms_confirm": None}
                if name in maint:
                    cur["maintenance"] = True
                if name in msh and msh[name] != "unknown":
                    cur["ms_seen"] = True
                    if msh[name].lower() != "serviceoperational" and cur["ms_confirm"] is None:
                        cur["ms_confirm"] = ts
                if RANK[st] > RANK[cur["worst"]]:
                    cur["worst"] = st
                if st == "down" and cur["first_down"] is None:
                    cur["first_down"] = ts
            elif cur is not None:
                cur["end"], cur["ongoing"] = ts, False
                out.append(open_.pop(name))
    last = rows[-1]["ts"] if rows else None
    for cur in open_.values():
        cur["end"] = last
        out.append(cur)
    for i in out:
        i["duration_s"] = int((_t(i["end"]) - _t(i["start"])).total_seconds())
        i["lead_s"] = (int((_t(i["first_down"]) - _t(i["start"])).total_seconds())
                       if i["first_down"] else None)
        # time until Microsoft's own status confirmed it (only if the Graph comparison was on)
        i["ms_confirm_s"] = (int((_t(i["ms_confirm"]) - _t(i["start"])).total_seconds())
                             if i.get("ms_confirm") else None)
    return sorted(out, key=lambda i: i["start"])


GENESIS = "0" * 64


def _chain_hash(rec):
    body = {k: v for k, v in rec.items() if k != "hash"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def verify(path, expect_head=None):
    """Check the log's hash chain. Returns {"ok", "chained", "legacy", "head", "problems": [(line, text)]}.

    Detects edited records (hash mismatch) and deleted / inserted / reordered records (broken
    prev link). Legacy lines written before chaining existed are allowed only BEFORE the chain
    starts. Cutting records off the END is only detectable with expect_head (a head hash you
    stored somewhere outside this host)."""
    problems, chained, legacy, expected, head = [], 0, 0, GENESIS, None
    with open(path, "rb") as f:
        for i, raw in enumerate(f, 1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
                h = rec.get("hash") if isinstance(rec, dict) else None
            except ValueError:
                rec, h = None, None
            if not isinstance(h, str):
                if chained:
                    problems.append((i, "unchained or unreadable line inside the chain (inserted or damaged)"))
                else:
                    legacy += 1
                expected = hashlib.sha256(raw).hexdigest()
                continue
            chained += 1
            if _chain_hash(rec) != h:
                problems.append((i, "record content does not match its hash (edited)"))
            if rec.get("prev") != expected:
                problems.append((i, "does not link to the line before it (record deleted, inserted or reordered here)"))
            expected = head = h
    if expect_head and head != expect_head:
        problems.append((0, "head hash differs from the anchored value (log truncated or rewritten)"))
    return {"ok": not problems, "chained": chained, "legacy": legacy, "head": head, "problems": problems}


def chain_badge(v):
    if v is None:
        return ""
    if not v["chained"]:
        return "Log integrity: NOT CHAINED (legacy log, cannot be verified)."
    if not v["ok"]:
        return (f"Log integrity: CHAIN BROKEN at line {v['problems'][0][0]} "
                f"({len(v['problems'])} problem(s)). Do not rely on this timeline as evidence.")
    note = f" {v['legacy']} older unchained line(s) precede the chain." if v["legacy"] else ""
    return (f"Log integrity: chain verified, {v['chained']} records, head `{v['head']}`.{note} "
            "This shows the log was not edited piecemeal; it is only a trustworthy timestamp if "
            "that head hash was also stored outside this host.")


def markdown(rows, inc, chain=None):
    lines = ["# outage-watch incident report", ""]
    if chain is not None:
        lines += [chain_badge(chain), ""]
    if not rows:
        return "\n".join(lines + ["No samples in log."]) + "\n"
    lines += [f"Window: {rows[0]['ts']} to {rows[-1]['ts']} ({len(rows)} samples)", ""]
    if not inc:
        return "\n".join(lines + ["No incidents. All services stayed up."]) + "\n"
    lines += ["| Service | Start (UTC) | Duration | Worst | Early-warning lead | Microsoft status confirmed after | Status |",
              "|---|---|---|---|---|---|---|"]
    for i in inc:
        lead = f"{i['lead_s']}s" if i["lead_s"] is not None else "n/a (never down)"
        ms = (f"{i['ms_confirm_s']}s" if i.get("ms_confirm_s") is not None else
              "never during the incident (DIVERGENCE)" if i.get("ms_seen") else "not compared")
        lines.append(f"| {i['service']} | {i['start']} | {i['duration_s']}s | {i['worst']} | {lead} | {ms} | "
                     f"{'ONGOING' if i['ongoing'] else 'resolved'}{' (planned maintenance)' if i.get('maintenance') else ''} |")
    downs = [i for i in inc if i["lead_s"] is not None]
    if downs:
        lines += ["", f"Confirmed outages: {len(downs)}. Median early-warning lead: "
                      f"{sorted(i['lead_s'] for i in downs)[len(downs) // 2]}s."]
    lines += ["", "Note: times are sample times, so durations are accurate to the probe interval."]
    return "\n".join(lines) + "\n"


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("log")
    p.add_argument("--md", help="write report to this file instead of stdout")
    p.add_argument("--sla", action="store_true", help="add an uptime / SLA table (24h, 7d, 30d, p50/p95)")
    p.add_argument("--db", help="with --sla: read the SQLite store instead of streaming the JSONL log")
    p.add_argument("--csv", metavar="FILE", help="with --sla: also write the SLA table as CSV")
    p.add_argument("--include-maintenance", action="store_true", help="with --sla: count maintenance samples too")
    p.add_argument("--verify", action="store_true", help="only check the log's hash chain (exit 1 if broken)")
    p.add_argument("--expect-head", metavar="HASH", help="with --verify: the head hash you anchored elsewhere")
    a = p.parse_args(argv)
    try:
        chain = verify(a.log, a.expect_head)
    except OSError as e:
        print(f"cannot read log: {e}", file=sys.stderr)
        return 2
    if a.verify:
        for line, text in chain["problems"]:
            print(f"BROKEN at {'line ' + str(line) if line else 'head'}: {text}")
        print(f"{'OK' if chain['ok'] else 'FAILED'}: {chain['chained']} chained record(s), {chain['legacy']} legacy line(s), head {chain['head']}")
        if chain["ok"] and not chain["chained"]:
            print("note: nothing to verify, this log has no hash chain")
        return 0 if chain["ok"] else 1
    rows = load(a.log)
    text = markdown(rows, incidents(rows), chain)
    if a.sla or a.csv:
        import os, store, tempfile
        tmp = None
        if a.db:
            db = store.connect(a.db)
        else:                                   # stream the log into a throwaway on-disk store
            fd, tmp = tempfile.mkstemp(suffix=".db")
            os.close(fd)
            db = store.connect(tmp)
            store.import_jsonl(db, a.log)
        now = _t(rows[-1]["ts"]).timestamp() if rows else None      # windows end at the last sample
        data = store.sla(db, now, not a.include_maintenance)
        db.close()
        if tmp:
            os.unlink(tmp)
        text += "\n" + store.sla_markdown(data, not a.include_maintenance)
        if a.csv:
            with open(a.csv, "w", newline="") as f:
                f.write(store.sla_csv(data))
    if a.md:
        open(a.md, "w").write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
