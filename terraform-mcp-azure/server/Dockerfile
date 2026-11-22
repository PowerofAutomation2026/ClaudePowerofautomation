# Azure Terraform MCP server. Terraform and the exact provider builds the templates were validated
# against are baked into the image (checksums verified), so nothing is downloaded at run time.
# Base image pinned by digest (python:3.12-slim as of 2026-11-22). Refresh deliberately:
#   docker buildx imagetools inspect python:3.12-slim   -> copy the new index digest here, rebuild, re-test.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

ARG TF_VERSION=1.9.8
ARG TF_SHA256=186e0145f5e5f2eb97cbd785bc78f21bae4ef15119349f6ad4fa535b83b10df8
ARG AZURERM_VERSION=4.81.0
ARG AZURERM_SHA256=79a8d17fefe647040fcb9ee8821a4f09f395427c4fd49493489b9a93a9a1038e
ARG RANDOM_VERSION=3.9.1
ARG RANDOM_SHA256=60b4f8a8ef18f52bf8e19215229dae408bee732825964092db7c989fd2de4097
ENV TF_PROVIDER_DIR=/opt/terraform/providers/registry.terraform.io/hashicorp

RUN set -eux; \
    apt-get update; apt-get install -y --no-install-recommends curl unzip ca-certificates; \
    base=https://releases.hashicorp.com; \
    curl -fsSL "$base/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_amd64.zip" -o /tmp/tf.zip; \
    echo "${TF_SHA256}  /tmp/tf.zip" | sha256sum -c -; \
    unzip -q /tmp/tf.zip terraform -d /usr/local/bin; \
    curl -fsSL "$base/terraform-provider-azurerm/${AZURERM_VERSION}/terraform-provider-azurerm_${AZURERM_VERSION}_linux_amd64.zip" -o /tmp/azurerm.zip; \
    echo "${AZURERM_SHA256}  /tmp/azurerm.zip" | sha256sum -c -; \
    mkdir -p "$TF_PROVIDER_DIR/azurerm/${AZURERM_VERSION}/linux_amd64"; \
    unzip -q /tmp/azurerm.zip -d "$TF_PROVIDER_DIR/azurerm/${AZURERM_VERSION}/linux_amd64"; \
    curl -fsSL "$base/terraform-provider-random/${RANDOM_VERSION}/terraform-provider-random_${RANDOM_VERSION}_linux_amd64.zip" -o /tmp/random.zip; \
    echo "${RANDOM_SHA256}  /tmp/random.zip" | sha256sum -c -; \
    mkdir -p "$TF_PROVIDER_DIR/random/${RANDOM_VERSION}/linux_amd64"; \
    unzip -q /tmp/random.zip -d "$TF_PROVIDER_DIR/random/${RANDOM_VERSION}/linux_amd64"; \
    rm -rf /tmp/*.zip /var/lib/apt/lists/*; \
    apt-get purge -y curl unzip; apt-get autoremove -y

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY terraformrc server.py integrity.json ./
COPY tfmcp ./tfmcp
COPY policies ./policies
COPY templates ./templates
# Fail the build if templates or policies differ from the reviewed manifest (checked again at every start).
RUN python -m tfmcp.integrity verify

RUN useradd --create-home --uid 10001 app && chown -R app /app
USER app
ENV TF_CLI_CONFIG_FILE=/app/terraformrc TF_IN_AUTOMATION=1 TF_INPUT=0 CHECKPOINT_DISABLE=1 \
    PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080
CMD ["python", "server.py"]
