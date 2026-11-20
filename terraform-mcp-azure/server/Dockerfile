FROM python:3.12-slim
ARG TF_VERSION=1.9.8
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && curl -fsSL https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_amd64.zip -o /tmp/tf.zip \
 && unzip /tmp/tf.zip -d /usr/local/bin && rm -rf /tmp/tf.zip /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
COPY templates ./templates
RUN useradd -m app && mkdir -p /home/app/.tfcache && chown -R app /app /home/app
USER app
ENV TF_IN_AUTOMATION=1 TF_INPUT=0 TF_PLUGIN_CACHE_DIR=/home/app/.tfcache PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "server.py"]
