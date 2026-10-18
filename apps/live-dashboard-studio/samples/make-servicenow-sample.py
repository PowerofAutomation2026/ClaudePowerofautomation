#!/usr/bin/env python3
"""Generate a synthetic ServiceNow-style incident / SLA / team-performance CSV (no real data).

  python3 make-servicenow-sample.py                 -> servicenow-incidents-120k.csv (120,000 rows)
  python3 make-servicenow-sample.py 5000 small.csv  -> any row count / file name

Same seed = same file. Columns follow the ServiceNow incident table names where they exist.
"""
import csv, math, random, sys
from datetime import datetime, timedelta

N = int(sys.argv[1]) if len(sys.argv) > 1 else 120_000
OUT = sys.argv[2] if len(sys.argv) > 2 else 'servicenow-incidents-120k.csv'
rnd = random.Random(20261018)

START, END = datetime(2025, 10, 1), datetime(2026, 10, 18, 17, 0)
REPORT_NOW = END   # incidents opened close to this moment may still be open

# --- teams: (group, member, skill factor <1 = faster, volume weight, first day) ---
TEAM = {
    'Service Desk':        [('Maria Lopez', .82, 1.5, None), ('James Carter', .95, 1.4, None), ('Aisha Khan', .88, 1.3, None), ('Tom Becker', 1.12, 1.1, None), ('Nina Petrova', 1.0, 0.7, datetime(2026, 3, 2))],
    'Network Operations':  [('Luis Fernandez', .9, 1.2, None), ('Grace Okafor', .85, 1.1, None), ('Wei Chen', 1.0, 1.0, None), ('Oliver Smith', 1.25, .9, None)],
    'Application Support': [('Priya Nair', .8, 1.4, None), ('Daniel Wright', .98, 1.3, None), ('Sofia Rossi', 1.05, 1.2, None), ('Kevin Brown', 1.18, 1.0, None), ('Hana Sato', .92, .6, datetime(2026, 4, 6))],
    'Database Admin':      [('Ahmed Hassan', .86, 1.0, None), ('Laura Meyer', .95, 1.0, None), ('Victor Ivanov', 1.15, .8, None)],
    'Infrastructure':      [('Chloe Martin', .9, 1.1, None), ('Ryan Murphy', 1.02, 1.0, None), ('Zoe Adams', 1.1, .9, None)],
    'Security Operations': [('Ethan Cole', .84, 1.0, None), ('Fatima Ali', .93, .9, None)],
}
GROUP_WEIGHT = {'Service Desk': 38, 'Network Operations': 14, 'Application Support': 26, 'Database Admin': 7, 'Infrastructure': 10, 'Security Operations': 5}
GROUP_SPEED = {'Service Desk': .75, 'Network Operations': 1.0, 'Application Support': 1.1, 'Database Admin': 1.3, 'Infrastructure': 1.2, 'Security Operations': 1.0}
GROUP_CATEGORY = {
    'Service Desk': [('Access / Identity', ['Password reset', 'Account locked', 'New access request', 'MFA issue']), ('Hardware', ['Laptop', 'Monitor', 'Printer', 'Peripheral']), ('Software', ['Office suite', 'Browser', 'VPN client', 'Install request'])],
    'Network Operations': [('Network', ['Wi-Fi', 'LAN', 'VPN', 'DNS', 'Firewall'])],
    'Application Support': [('Software', ['ERP', 'CRM', 'HR portal', 'Intranet', 'Line-of-business app']), ('Email', ['Mailbox', 'Calendar', 'Distribution list'])],
    'Database Admin': [('Database', ['Performance', 'Backup / restore', 'Access', 'Replication'])],
    'Infrastructure': [('Hardware', ['Server', 'Storage', 'Virtual machine']), ('Network', ['Data centre link', 'Load balancer'])],
    'Security Operations': [('Security', ['Phishing report', 'Malware', 'Suspicious login', 'Data loss'])],
}
SERVICES = ['Email & Calendar', 'ERP Finance', 'CRM Sales', 'HR Portal', 'Corporate VPN', 'Office Wi-Fi', 'Service Desk Portal', 'Data Warehouse', 'Payroll', 'File Shares', 'Video Conferencing', 'Endpoint Management', 'Identity Platform', 'Customer Website', 'Print Services']
LOCATIONS = ['London', 'Manchester', 'Dublin', 'Berlin', 'Paris', 'Madrid', 'New York', 'Chicago', 'Austin', 'Singapore']
CONTACT = [('Self-service', 34), ('Phone', 26), ('Email', 20), ('Chat', 16), ('Walk-in', 4)]
CLOSE_CODES = [('Solved (Permanently)', 62), ('Solved (Work Around)', 14), ('Closed/Resolved by Caller', 11), ('Duplicate', 6), ('Not Solved (Not Reproducible)', 5), ('Not Solved (Too Costly)', 2)]
PRIORITY = [('1 - Critical', 3), ('2 - High', 12), ('3 - Moderate', 45), ('4 - Low', 40)]
SLA_HOURS = {'1 - Critical': 4, '2 - High': 8, '3 - Moderate': 24, '4 - Low': 72}
MEAN_HOURS = {'1 - Critical': 3.2, '2 - High': 6.5, '3 - Moderate': 17, '4 - Low': 48}
IMPACT_URGENCY = {'1 - Critical': ('1 - High', '1 - High'), '2 - High': ('2 - Medium', '1 - High'), '3 - Moderate': ('2 - Medium', '2 - Medium'), '4 - Low': ('3 - Low', '3 - Low')}
TEMPLATES = ['Cannot log in to {s}', '{s} is very slow', '{s} unavailable for several users', 'Error message when opening {s}', 'Request access to {s}', 'Intermittent disconnects on {s}', '{s}: data looks wrong, please check', 'Unable to print from {s}', 'Need help configuring {s}', '{s} outage, multiple sites affected']

def wchoice(pairs):
    items, weights = zip(*pairs)
    return rnd.choices(items, weights)[0]

# weekday / hour weights for incident arrival
HOUR_W = [1, 1, 1, 1, 1, 2, 4, 8, 14, 16, 15, 12, 10, 13, 15, 14, 11, 8, 5, 3, 2, 2, 1, 1]
def opened_at():
    while True:
        day = START + timedelta(days=rnd.random() * (END - START).days)
        w = day.weekday()
        if w >= 5 and rnd.random() > .22: continue          # fewer weekend tickets
        month_bump = 1.25 if day.month in (1, 9) else 1.0    # January and September peaks
        if rnd.random() > min(1, .8 * month_bump): continue
        h = rnd.choices(range(24), HOUR_W)[0]
        t = day.replace(hour=h, minute=rnd.randrange(60), second=rnd.randrange(60), microsecond=0)
        if t < END: return t

def pick_member(group, when):
    pool = [(m, f, w) for (m, f, w, start) in TEAM[group] if start is None or when >= start]
    m = rnd.choices(pool, [p[2] for p in pool])[0]
    return m[0], m[1]

fmt = lambda d: d.strftime('%Y-%m-%d %H:%M:%S') if d else ''
rows = []
opened_times = sorted(opened_at() for _ in range(N))
for i, op in enumerate(opened_times):
    group = rnd.choices(list(GROUP_WEIGHT), list(GROUP_WEIGHT.values()))[0]
    category, subs = rnd.choice(GROUP_CATEGORY[group])
    prio = wchoice(PRIORITY)
    if group == 'Security Operations' and rnd.random() < .12: prio = '2 - High'
    member, skill = pick_member(group, op)
    target = SLA_HOURS[prio]
    hours = rnd.lognormvariate(math.log(MEAN_HOURS[prio] * GROUP_SPEED[group] * skill), .65)
    hours = max(.1, round(hours, 2))
    age_h = (REPORT_NOW - op).total_seconds() / 3600
    state = 'Closed'
    if hours > age_h:                                    # not finished yet at report time
        state = rnd.choices(['In Progress', 'On Hold', 'New'], [60, 25, 15])[0]
    elif age_h - hours < 72 and rnd.random() < .5:       # resolved, waiting for the 3-day auto-close
        state = 'Resolved'
    elif rnd.random() < .004:
        state = 'Cancelled'
    resolved = op + timedelta(hours=hours) if state in ('Closed', 'Resolved') else None
    closed = resolved + timedelta(hours=rnd.uniform(24, 96)) if state == 'Closed' else None
    if closed and closed > REPORT_NOW: closed = REPORT_NOW - timedelta(minutes=rnd.randrange(1, 600)); state = 'Closed'
    closer = ''
    if state == 'Closed':
        closer = member if rnd.random() < .93 else pick_member(group, closed)[0]
    made_sla = ''
    elapsed_pct = ''
    if resolved:
        paused = rnd.random() < .08                      # SLA clock paused (waiting on customer)
        eff = hours * (.55 if paused else 1)
        made_sla = 'true' if eff <= target else 'false'
        elapsed_pct = round(eff / target * 100, 1)
    reassign = min(4, int(rnd.expovariate(1.6)))
    if group == 'Service Desk': reassign = min(4, reassign + (1 if rnd.random() < .25 else 0))
    reopen = 1 if (state == 'Closed' and rnd.random() < .035) else 0
    imp, urg = IMPACT_URGENCY[prio]
    service = rnd.choice(SERVICES)
    short = rnd.choice(TEMPLATES).format(s=service)
    if rnd.random() < .08: short = short + ', please advise, thanks'      # commas in text exercise CSV quoting
    rows.append([
        f'INC{1000001 + i:07d}', fmt(op), fmt(resolved), fmt(closed), prio, state, group, member, closer, category, rnd.choice(subs),
        service, rnd.choice(LOCATIONS), wchoice(CONTACT), imp, urg,
        wchoice(CLOSE_CODES) if state in ('Closed', 'Resolved') else '', made_sla,
        'true' if (prio in ('1 - Critical', '2 - High') and rnd.random() < .35) else 'false',
        hours if resolved else '', target, elapsed_pct, reassign, reopen, 1 if state == 'Closed' else 0, short,
    ])
HEAD = ['Number', 'Opened', 'Resolved', 'Closed', 'Priority', 'State', 'Assignment Group', 'Assigned To', 'Closed By', 'Category', 'Subcategory',
        'Business Service', 'Location', 'Contact Type', 'Impact', 'Urgency', 'Close Code', 'Made SLA', 'Escalated',
        'Resolution Time (hrs)', 'SLA Target (hrs)', 'SLA Elapsed %', 'Reassignment Count', 'Reopen Count', 'Closed Count', 'Short Description']
with open(OUT, 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f); w.writerow(HEAD); w.writerows(rows)

closed = [r for r in rows if r[5] == 'Closed']
by = {}
for r in closed: by[r[8]] = by.get(r[8], 0) + 1
sla = [r for r in rows if r[17] != '']
print(f'{OUT}: {len(rows):,} incidents, {len(closed):,} closed, {len(by)} team members closed tickets')
print('SLA met overall: %.1f%%' % (100 * sum(r[17] == 'true' for r in sla) / len(sla)))
print('Top closers:', ', '.join(f'{k} {v:,}' for k, v in sorted(by.items(), key=lambda kv: -kv[1])[:5]))
