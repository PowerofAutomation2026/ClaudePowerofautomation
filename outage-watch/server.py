"""Live dashboard + Prometheus metrics for outage-watch (stdlib only)."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_NUM = {"up": 0, "warning": 1, "suspect": 2, "down": 3, "blocked": 4}
LEVEL_NUM = {"ok": 0, "caution": 1, "freeze": 2}


class Snapshot:
    """Thread-safe latest status, written by the probe loop, read by the server."""

    def __init__(self):
        self._lock, self._data = threading.Lock(), {"updated": None, "level": "ok", "verdict": "starting", "services": {}}

    def update(self, ts, level, verdict, results, published):
        svc = {r["name"]: {"state": published.get(r["name"], r["state"]), "code": r["code"],
                           "ms": r["ms"], "error": r["error"]} for r in results}
        with self._lock:
            self._data = {"updated": ts, "level": level, "verdict": verdict, "services": svc}

    def get(self):
        with self._lock:
            return json.loads(json.dumps(self._data))


def _label(v):
    return str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def metrics_text(d):
    out = ["# TYPE outagewatch_service_state gauge",
           "# HELP outagewatch_service_state 0=up 1=warning 2=suspect 3=down"]
    for n, s in sorted(d["services"].items()):
        out.append(f'outagewatch_service_state{{service="{_label(n)}"}} {STATE_NUM.get(s["state"], 3)}')
    out.append("# TYPE outagewatch_latency_ms gauge")
    for n, s in sorted(d["services"].items()):
        out.append(f'outagewatch_latency_ms{{service="{_label(n)}"}} {s["ms"]}')
    out += ["# TYPE outagewatch_level gauge", f'outagewatch_level {LEVEL_NUM.get(d["level"], 2)}']
    return "\n".join(out) + "\n"


PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>outage-watch</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--card:#f4f5f7;--up:#1a7f37;--warning:#b08800;--suspect:#c25e00;--down:#cf222e}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--card:#1d1f23;--up:#3fb950;--warning:#d4a72c;--suspect:#f0883e;--down:#f85149}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}#v{margin:0 0 16px;opacity:.8}
#g{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.c{background:var(--card);border-radius:8px;padding:12px;border-left:6px solid var(--up)}
.c b{display:block}.s{font-weight:600}
.warning{border-color:var(--warning)}.suspect{border-color:var(--suspect)}.down{border-color:var(--down)}
.lvl{display:inline-block;padding:2px 10px;border-radius:12px;color:#fff;font-weight:600}
.ok{background:var(--up)}.caution{background:var(--warning)}.freeze{background:var(--down)}
</style></head><body>
<h1>Microsoft 365 &amp; Copilot health <span id="l" class="lvl ok">ok</span></h1>
<p id="v"></p><div id="g"></div>
<script>
async function tick(){
  try{
    const d=await (await fetch('status.json',{cache:'no-store'})).json();
    const l=document.getElementById('l');l.textContent=d.level;l.className='lvl '+d.level;
    document.getElementById('v').textContent=d.verdict+(d.updated?'  ·  '+d.updated:'');
    const g=document.getElementById('g');g.replaceChildren();
    for(const [n,s] of Object.entries(d.services).sort()){
      const c=document.createElement('div');c.className='c '+s.state;
      const b=document.createElement('b');b.textContent=n;
      const st=document.createElement('span');st.className='s';st.textContent=s.state;
      const m=document.createElement('div');m.textContent=s.ms+' ms'+(s.code?' · HTTP '+s.code:'')+(s.error?' · '+s.error:'');
      c.append(b,st,m);g.append(c);
    }
  }catch(e){document.getElementById('v').textContent='dashboard cannot reach outage-watch';}
}
tick();setInterval(tick,5000);
</script></body></html>"""


def make_server(snapshot, port, bind="127.0.0.1"):
    class H(BaseHTTPRequestHandler):
        def _send(self, code, body, ctype):
            data = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/":
                self._send(200, PAGE, "text/html; charset=utf-8")
            elif path == "/status.json":
                self._send(200, json.dumps(snapshot.get()), "application/json")
            elif path == "/metrics":
                self._send(200, metrics_text(snapshot.get()), "text/plain; version=0.0.4")
            elif path == "/healthz":
                self._send(200, "ok\n", "text/plain")
            else:
                self._send(404, "not found\n", "text/plain")

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer((bind, port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv
