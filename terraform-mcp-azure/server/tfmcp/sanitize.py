"""Everything the server returns goes back into an LLM that may be prompt-injectable, and into logs.
Strings that originate outside the server (Azure resource names, tags, Terraform output, user comments)
are therefore treated as hostile data:

* control characters and line breaks are removed (no fake "new message" framing),
* secrets are redacted (keys, SAS signatures, connection strings, bearer tokens, passwords),
* text that looks like an instruction to a model is replaced by ``[removed]``,
* length is capped.

This lowers the chance that data is mistaken for instructions; it cannot make an LLM safe. The real
controls are the server-side gates (roles, policy, out-of-band approval, quotas)."""
from __future__ import annotations

import re
from typing import Any

REDACTED = "[redacted]"
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]")
_SECRETS = [
    re.compile(r"(?i)\b(AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd|client_secret|access_key|secret)\s*[=:]\s*[^\s;,'\"&]{6,}"),
    re.compile(r"(?i)([?&]sig=)[A-Za-z0-9%+/=]{16,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}"),          # JWT
    re.compile(r"(?i)\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*"),
    re.compile(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{86}==(?![A-Za-z0-9+/=])"),                   # 64-byte storage style key
    re.compile(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])"),                    # 32-byte base64 key
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)"),
]
_INJECTION = re.compile(
    r"(?i)(ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompts?)|disregard (the |all )?(previous|above|system)"
    r"|you are now\b|new instructions?:|system prompt|</?\s*(system|assistant|user|tool)\s*>|\[/?(INST|SYSTEM)\]"
    r"|(call|invoke|use|run) (the )?(tool|function)\b|do not (tell|inform|ask) the user|without (asking|telling) the user"
    r"|as an ai\b|act as (an? )?(admin|administrator|approver)|approve (this|the) plan|apply (this|the) plan (now|immediately))")


_KNOWN_SECRETS: set[str] = set()


def register_secret(value: str) -> None:
    """A secret the process holds (e.g. the connector client secret): removed verbatim from every output and log line."""
    if value and len(value) >= 8:
        _KNOWN_SECRETS.add(value)


def redact(text: str) -> str:
    for secret in _KNOWN_SECRETS:
        if secret in text:
            text = text.replace(secret, REDACTED)
    for rx in _SECRETS:
        if rx.groups:
            text = rx.sub(lambda m: f"{m.group(1)}={REDACTED}" if not m.group(1).startswith(("?", "&")) else m.group(1) + REDACTED, text)
        else:
            text = rx.sub(REDACTED, text)
    return text


def clean(text: Any, limit: int = 300, keep_newlines: bool = False) -> str:
    """Make an untrusted string safe to hand to an LLM or a log."""
    text = str(text)
    if not keep_newlines:
        text = text.replace("\r", " ").replace("\n", " ")
    else:
        text = text.replace("\r", "")
    text = _CONTROL.sub("", text)
    text = redact(text)
    text = _INJECTION.sub("[removed]", text)
    if len(text) > limit:
        text = text[:limit] + "...(cut)"
    return text


def clean_error(output: str, limit: int = 700) -> str:
    """Terraform / Azure error text: keep the first error block, single line, redacted, capped."""
    idx = output.find("Error:")
    text = output[idx:] if idx >= 0 else output[-limit * 2:]
    text = re.sub(r"\s+", " ", text)
    return clean(text, limit)


def deep_clean(value: Any, limit: int = 1200) -> Any:
    """Apply ``clean`` to every string in a result (keys included), drop empty values."""
    if isinstance(value, str):
        return clean(value, limit, keep_newlines=True)
    if isinstance(value, dict):
        return {clean(k, 80): deep_clean(v, limit) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [deep_clean(v, limit) for v in value]
    return value


def prune(value: Any) -> Any:
    """Token saver: drop None / empty string / empty list / empty dict / False recursively (0 is kept)."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            v = prune(v)
            if v is None or v is False or v == "" or v == [] or v == {}:
                continue
            out[k] = v
        return out
    if isinstance(value, list):
        return [prune(v) for v in value]
    return value
