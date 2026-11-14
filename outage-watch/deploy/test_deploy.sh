#!/usr/bin/env bash
# Tests for deploy.sh. Runs a REAL user-mode deployment into a temp dir (no service install).
#   ./deploy/test_deploy.sh            (takes a few minutes: the deploy runs the unit tests as a gate)
# Kept out of `python -m unittest` on purpose: the deploy itself runs that suite.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D="$HERE/deploy.sh"
TMP="$(mktemp -d)"
PORT="${TEST_PORT:-18980}"
ID="0a1b2c3d-1111-2222-3333-444455556666"
ID2="ffffffff-1111-2222-3333-444455556666"
PASS=0; FAIL=0
ROOT_FLAG=(); [ "$(id -u)" -eq 0 ] && ROOT_FLAG=(--allow-root)
check() { if "${@:2}"; then PASS=$((PASS + 1)); echo "  pass  $1"; else FAIL=$((FAIL + 1)); echo "  FAIL  $1"; fi; }
cleanup() { "$D" --env-id "$ID" --state-dir "$TMP" --uninstall --purge >/dev/null 2>&1; [ -n "${BLOCKER:-}" ] && kill "$BLOCKER" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

echo "== GUID validator: hostile input must be rejected before anything is touched"
check "accepts a lower-case GUID" "$D" --validate-guid "$ID" >/dev/null
check "accepts an upper-case GUID" "$D" --validate-guid "0A1B2C3D-AAAA-BBBB-CCCC-DDDDEEEEFFFF" >/dev/null
while IFS= read -r bad; do
  if "$D" --validate-guid "$bad" >/dev/null 2>&1; then FAIL=$((FAIL + 1)); printf '  FAIL  accepted hostile input: %q\n' "$bad"; else PASS=$((PASS + 1)); fi
  out="$("$D" --env-id "$bad" --state-dir "$TMP/hostile" --yes --dry-run 2>&1)"; code=$?
  if [ "$code" -ne 2 ] || [ -e "$TMP/hostile" ]; then FAIL=$((FAIL + 1)); printf '  FAIL  deploy did not refuse: %q (exit %s)\n' "$bad" "$code"; else PASS=$((PASS + 1)); fi
done <<'HOSTILE'
../../etc/passwd
0a1b2c3d-1111-2222-3333-44445555666
0a1b2c3d-1111-2222-3333-4444555566667
0a1b2c3d-1111-2222-3333-44445555666g
zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz
0a1b2c3d111122223333444455556666
0a1b2c3d-1111-2222-3333-444455556666; rm -rf /
0a1b2c3d-1111-2222-3333-444455556666 
 0a1b2c3d-1111-2222-3333-444455556666
0a1b2c3d-1111-2222-3333-44445555666'
"0a1b2c3d-1111-2222-3333-444455556666"
`id`-1111-2222-3333-444455556666
$(id)a-1111-2222-3333-444455556666
0a1b2c3d-1111-2222-3333-4444555566６６
０a1b2c3d-1111-2222-3333-444455556666
0a1b2c3d‐1111‐2222‐3333‐444455556666
0a1b2c3d-1111-2222-3333/444455556666
{0a1b2c3d-1111-2222-3333-444455556666}
------------------------------------
0a1b2c3d-1111-2222-3333-444455556666%0a
*
HOSTILE
check "rejects an empty value" bash -c '! "$0" --validate-guid "" >/dev/null 2>&1' "$D"
check "rejects a GUID with a trailing newline" bash -c '! "$0" --validate-guid "$1"$'"'"'\n'"'"' >/dev/null 2>&1' "$D" "$ID"
check "no ID + non-interactive = exit 2" bash -c '"$0" --yes --state-dir "$1" </dev/null >/dev/null 2>&1; [ $? -eq 2 ]' "$D" "$TMP"
check "bad --port refused" bash -c '"$0" --env-id "$1" --port "80;id" --dry-run >/dev/null 2>&1; [ $? -eq 2 ]' "$D" "$ID"
check "bad --bind refused" bash -c '"$0" --env-id "$1" --bind "0.0.0.0 --x" --dry-run >/dev/null 2>&1; [ $? -eq 2 ]' "$D" "$ID"

echo "== dry run changes nothing"
OUT="$("$D" --env-id "$ID" --state-dir "$TMP" --port "$PORT" --no-service --yes --dry-run "${ROOT_FLAG[@]}" 2>&1)"; CODE=$?
check "dry run exits 0" [ "$CODE" -eq 0 ]
check "dry run created nothing" [ -z "$(ls -A "$TMP")" ]
check "dry run prints the numbered plan" bash -c 'grep -q "^\[8\] Summary" <<<"$1" && grep -q "dry-run: would" <<<"$1"' _ "$OUT"
check "OUTAGEWATCH_ENV_ID is accepted" bash -c 'OUTAGEWATCH_ENV_ID="$1" "$0" --state-dir "$2" --no-service --yes --dry-run '"${ROOT_FLAG[*]}"' >/dev/null 2>&1' "$D" "$ID" "$TMP"

echo "== real user-mode deploy (runs the unit-test gate; this takes a while)"
OUT="$("$D" --env-id "$ID" --state-dir "$TMP" --port "$PORT" --no-service --yes "${ROOT_FLAG[@]}" 2>&1)"; CODE=$?
echo "$OUT" | sed 's/^/    | /'
S="$TMP/$ID"
check "deploy exits 0" [ "$CODE" -eq 0 ]
check "config generated with the environment probe" grep -q "make.powerapps.com/environments/$ID/home" "$S/config.json"
check "config carries the deployment label" grep -q '"label": "outagewatch-0a1b2c3d"' "$S/config.json"
MODE="$(stat -c %a "$S/outagewatch.env" 2>/dev/null || stat -f %Lp "$S/outagewatch.env")"
check "token file is mode 600" [ "$MODE" = "600" ]
check "two different tokens of 32+ chars" bash -c '[ "$(grep -cE "^OUTAGEWATCH_(ADMIN|VIEWER)_TOKEN=.{32,}$" "$1")" -eq 2 ] && [ "$(grep TOKEN= "$1" | cut -d= -f2 | sort -u | wc -l)" -eq 2 ]' _ "$S/outagewatch.env"
ADMIN="$(grep '^OUTAGEWATCH_ADMIN_TOKEN=' "$S/outagewatch.env" | cut -d= -f2)"; VIEWER="$(grep '^OUTAGEWATCH_VIEWER_TOKEN=' "$S/outagewatch.env" | cut -d= -f2)"
check "tokens are not in the deploy output" bash -c '! grep -qF "$2" <<<"$1" && ! grep -qF "$3" <<<"$1"' _ "$OUT" "$ADMIN" "$VIEWER"
check "tokens are not in any log or state file except the env file" bash -c '! grep -rlF -e "$2" -e "$3" "$1" | grep -v "outagewatch.env$" | grep -q .' _ "$S" "$ADMIN" "$VIEWER"
check "tokens are not in the process arguments" bash -c '! tr "\0" " " </proc/"$(cat "$1")"/cmdline | grep -qF -e "$2" -e "$3"' _ "$S/outagewatch.pid" "$ADMIN" "$VIEWER"
check "unit-test gate ran" grep -qE "^Ran [0-9]+ tests" "$S/unittest.out"
check "gate result was OK" grep -q "^OK" "$S/unittest.out"
code() { python3 - "$@" <<'PY'
import sys, urllib.request, urllib.error
url, tok, post = sys.argv[1], sys.argv[2], sys.argv[3] == "post"
h = {"Authorization": "Bearer " + tok} if tok else {}
if post: h["Content-Type"] = "application/json"
try:
    print(urllib.request.urlopen(urllib.request.Request(url, data=b"{}" if post else None, headers=h), timeout=5).status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception:
    print(0)
PY
}
B="http://127.0.0.1:$PORT"
check "app is running and /healthz is 200" [ "$(code "$B/healthz" "" get)" = "200" ]
check "status.json refused without token (401)" [ "$(code "$B/status.json" "" get)" = "401" ]
check "status.json ok with viewer token" [ "$(code "$B/status.json" "$VIEWER" get)" = "200" ]
check "POST /api/test rejected without token" bash -c 'c="$1"; [ "$c" = "401" ] || [ "$c" = "403" ]' _ "$(code "$B/api/test" "" post)"
check "POST /api/test rejected with the viewer token" [ "$(code "$B/api/test" "$VIEWER" post)" = "401" ]
check "POST /api/test works with the admin token" [ "$(code "$B/api/test" "$ADMIN" post)" = "200" ]
check "staff page /status is served" [ "$(code "$B/status" "" get)" = "200" ]
check "metrics carry the deployment label" bash -c 'python3 - "$1" "$2" <<PY | grep -q "outagewatch_info{deployment=\"outagewatch-0a1b2c3d\"} 1"
import sys, urllib.request
print(urllib.request.urlopen(urllib.request.Request(sys.argv[1] + "/metrics", headers={"Authorization": "Bearer " + sys.argv[2]})).read().decode())
PY' _ "$B" "$VIEWER"
check "deploy.log exists and has no secrets" bash -c '[ -s "$1" ] && ! grep -qF -e "$2" -e "$3" "$1"' _ "$S/deploy.log" "$ADMIN" "$VIEWER"

echo "== failure rolls back what the run created (port already in use)"
OUT2="$("$D" --env-id "$ID2" --state-dir "$TMP" --port "$PORT" --no-service --yes --skip-live-test "${ROOT_FLAG[@]}" 2>&1)"; CODE2=$?
check "second deploy on a busy port fails" [ "$CODE2" -ne 0 ]
check "its new state directory was removed" [ ! -e "$TMP/$ID2" ]
check "it says what was left behind" grep -q "Left behind" <<<"$OUT2"
check "the first deployment is untouched and still running" [ "$(code "$B/healthz" "" get)" = "200" ]

echo "== re-run is an upgrade: tokens, config and data are kept"
PID1="$(cat "$S/outagewatch.pid")"; LINES1="$(wc -l <"$S/data/outagewatch.jsonl")"
"$D" --env-id "$ID" --state-dir "$TMP" --port "$PORT" --no-service --yes --skip-live-test "${ROOT_FLAG[@]}" >/dev/null 2>&1; CODE3=$?
check "re-run exits 0" [ "$CODE3" -eq 0 ]
check "admin token unchanged" grep -qF "OUTAGEWATCH_ADMIN_TOKEN=$ADMIN" "$S/outagewatch.env"
check "process was replaced" [ "$(cat "$S/outagewatch.pid")" != "$PID1" ]
sleep 3
check "chain log kept and still verifies" bash -c '[ "$(wc -l <"$1/data/outagewatch.jsonl")" -ge "$2" ] && python3 "$3/../report.py" "$1/data/outagewatch.jsonl" --verify >/dev/null' _ "$S" "$LINES1" "$HERE"

echo "== uninstall"
PID2="$(cat "$S/outagewatch.pid")"
"$D" --env-id "$ID" --state-dir "$TMP" --uninstall >/dev/null 2>&1
check "process stopped" bash -c '! kill -0 "$1" 2>/dev/null' _ "$PID2"
check "port closed" [ "$(code "$B/healthz" "" get)" = "0" ]
check "data kept without --purge" [ -s "$S/data/outagewatch.jsonl" ]
"$D" --env-id "$ID" --state-dir "$TMP" --uninstall --purge >/dev/null 2>&1
check "--purge removed the state directory" [ ! -e "$S" ]

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
