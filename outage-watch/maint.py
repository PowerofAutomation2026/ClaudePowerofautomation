"""Planned maintenance windows for outage-watch (stdlib only).

Config ("maintenance": [...]), one-off or weekly, each with an IANA timezone:
  {"services": ["exchange"], "start": "2026-12-01T22:00", "end": "2026-12-02T02:00", "tz": "Europe/Berlin", "note": "patching"}
  {"services": ["*"], "weekly": {"day": "sun", "start": "02:00", "duration_min": 120}, "tz": "UTC"}
During a window the named services are still probed and logged (flagged "maintenance"),
but they do not raise the freeze level and do not alert.
"""
from datetime import datetime, timedelta, timezone

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _tz(name):
    if name in (None, "UTC", "utc"):
        return timezone.utc
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:
        raise ValueError(f"maintenance: unknown timezone {name!r} (is the system tz database installed?)")


def validate(windows):
    """Raises ValueError; returns a parsed list."""
    if not isinstance(windows, list) or len(windows) > 100:
        raise ValueError("maintenance must be a list of at most 100 windows")
    out = []
    for i, w in enumerate(windows):
        what = f"maintenance[{i}]"
        if not isinstance(w, dict):
            raise ValueError(f"{what}: expected an object")
        svc = w.get("services")
        if not (isinstance(svc, list) and svc and all(isinstance(x, str) for x in svc)):
            raise ValueError(f'{what}.services must be a list of service names (or ["*"])')
        tz = _tz(w.get("tz"))
        note = w.get("note", "")
        if not isinstance(note, str) or len(note) > 200:
            raise ValueError(f"{what}.note must be text up to 200 characters")
        p = {"services": svc, "tz": tz, "note": note}
        try:
            if "weekly" in w:
                k = w["weekly"]
                hh, mm = map(int, k["start"].split(":"))
                p.update(day=DAYS.index(k["day"].lower()[:3]), hh=hh, mm=mm, dur=timedelta(minutes=k["duration_min"]))
                if not (0 <= hh < 24 and 0 <= mm < 60 and 0 < k["duration_min"] <= 7 * 1440):
                    raise ValueError
            else:
                p.update(start=datetime.fromisoformat(w["start"]).replace(tzinfo=tz),
                         end=datetime.fromisoformat(w["end"]).replace(tzinfo=tz))
                if p["end"] <= p["start"]:
                    raise ValueError
        except (KeyError, TypeError, ValueError, AttributeError):
            raise ValueError(f'{what}: need "start"+"end" (ISO local time, end after start) or '
                             '"weekly": {"day": "sun", "start": "02:00", "duration_min": 120}')
        out.append(p)
    return out


def active(windows, names, now=None):
    """{service: note} for services inside a window at `now` (aware datetime, default now UTC)."""
    now = now or datetime.now(timezone.utc)
    hit = {}
    for w in windows or []:
        local = now.astimezone(w["tz"])
        if "day" in w:
            start = local.replace(hour=w["hh"], minute=w["mm"], second=0, microsecond=0) - \
                timedelta(days=(local.weekday() - w["day"]) % 7)
            if start > local:
                start -= timedelta(days=7)
            on = local - start < w["dur"]
        else:
            on = w["start"] <= local < w["end"]
        if on:
            for n in names:
                if "*" in w["services"] or n in w["services"]:
                    hit.setdefault(n, w["note"] or "planned maintenance")
    return hit
