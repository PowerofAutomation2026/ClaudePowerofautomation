# outage-watch: stdlib-only Python, no pip install needed.
FROM python:3.13-slim
RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin outagewatch \
    && mkdir -p /data /app && chown outagewatch /data
WORKDIR /app
COPY outagewatch.py server.py report.py alerts.py maint.py store.py graphhealth.py \
     dashboard.html login.html status.html drills.example.json config.example.json ./
USER outagewatch
WORKDIR /data
# Tokens come from the environment (see docker-compose.yml / env file), never from the image.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python3", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3).status == 200 else 1)"]
# Inside the container the app must listen on 0.0.0.0; the app refuses that without a token,
# and docker-compose.yml publishes the port on the host's 127.0.0.1 only.
ENTRYPOINT ["python3", "/app/outagewatch.py"]
CMD ["--serve", "8080", "--bind", "0.0.0.0", "--log", "/data/outagewatch.jsonl", "--db", "/data/outagewatch.db", \
     "--freeze-file", "/data/freeze.json", "--alert-state", "/data/alerts-state.json"]
