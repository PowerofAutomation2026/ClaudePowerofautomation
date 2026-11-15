# CI gate: "safe to change?"

The alert flow rewrites one small row after every judged probe round: setting `ci_status` in the table
`owatch_setting`. Its value is JSON, at most 400 characters:

```json
{"level":"freeze","since":"2026-11-15T08:23:00Z","updated":"2026-11-15T09:13:00Z","round":"2026-11-15T09:10:00Z","failing":2,"confirmed":1,"services":"exchange,teams"}
```

| level | meaning | default gate |
|---|---|---|
| `ok` | nothing failed in the last judged round | go |
| `caution` | something failed once, not yet confirmed | go (stop with `--block-on caution`) |
| `freeze` | a failure is confirmed (N rounds in a row, setting `alert_confirm`) **or sign-in failed at all** | stop |

`since` = when this level began; `updated` = when the row was last written. If `updated` is older than
`--stale-minutes` (default 35 = three 10-minute rounds + margin) the monitor itself is silent. Default: **fail
closed** (`--on-stale fail`); choose `--on-stale pass` if a silent monitor must not block releases.
The row exists only while the alert flow is ON (it needs at least one alert channel configured).

Mechanism: a plain, documented Dataverse Web API read. No extra flow, no HTTP-trigger URL to protect, no premium
connector. The pipeline needs an Entra app with an *application user* in the environment and a security role that
can read `owatch_setting`.

- `gate.mjs` - the gate (Node 18+, no dependencies). Unit-tested, including against the mock Dataverse.
- `github-actions.yml`, `azure-pipelines.yml` - ready-to-copy steps. **Not run on a real tenant.**
- `Test-OutageWatchGate.ps1` - the same in PowerShell. **Not executed** where it was written.
- one-liner (bash + curl + jq), fails on freeze, does not check staleness:

```bash
curl -sf -H "Authorization: Bearer $OUTAGEWATCH_TOKEN" -H "Accept: application/json" \
  "$OUTAGEWATCH_ORG_URL/api/data/v9.2/owatch_settings?\$select=owatch_value&\$filter=owatch_name%20eq%20'ci_status'" \
  | jq -e '.value[0].owatch_value | fromjson | .level != "freeze"' > /dev/null
```

Same-fate: the gate reads from Power Platform. When Dataverse or sign-in is down the read fails and the gate stops
the pipeline (unless `--on-stale pass`). That is usually what you want during a Microsoft outage, but it is not an
independent signal: the host-based Python monitor has its own `--check-freeze` gate for that.
