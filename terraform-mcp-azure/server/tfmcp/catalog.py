"""Template catalog: loads ``templates/<name>/template.json`` and validates user variables
against the typed schema (types, enums, ranges, patterns, formats) BEFORE Terraform ever runs.

Schema of one variable (all keys except ``type`` optional)::

    {"type": "string|integer|number|boolean|list|map|object",
     "description": "...", "default": ..., "required": false,
     "enum": [...], "minimum": 0, "maximum": 10,
     "min_length": 1, "max_length": 64, "pattern": "^[a-z]+$",
     "format": "cidr|guid|azure_resource_id|ssh_public_key|ip_or_cidr",
     "resource_type": "Microsoft.Network/virtualNetworks/subnets",   # with format azure_resource_id
     "items": {...},            # list element schema
     "values": {...},           # map value schema
     "key_pattern": "^...$",    # map key pattern
     "min_items": 0, "max_items": 20,
     "properties": {...}, "additional_properties": false}             # object
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import pathlib
import re
from typing import Any

DEPLOYMENT_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,18}[a-z0-9]$")
TEMPLATE_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,40}$")
GUID_RE = re.compile(r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
RESOURCE_ID_RE = re.compile(
    r"^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[-\w.()]{1,90}/providers/"
    r"(?P<type>[A-Za-z0-9.]+(?:/[A-Za-z0-9]+/[^/\s]+)*?/[A-Za-z0-9]+)/[^/\s]+$")
SSH_KEY_RE = re.compile(r"^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]{60,}( [^\n\r]{0,100})?$")
VAR_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

# Variables the server always injects; a template must not redefine them in its schema.
RESERVED_VARIABLES = {"subscription_id", "deployment_name", "resource_group_name", "location", "tags", "environment", "tenant_id"}
_TYPES = {"string", "integer", "number", "boolean", "list", "map", "object"}
_SCHEMA_KEYS = {"type", "description", "default", "required", "enum", "minimum", "maximum", "min_length", "max_length",
                "pattern", "format", "resource_type", "items", "values", "key_pattern", "min_items", "max_items",
                "properties", "additional_properties", "example"}
_FORMATS = {"cidr", "guid", "azure_resource_id", "ssh_public_key", "ip_or_cidr"}


class ValidationError(ValueError):
    """User input does not match the template schema. ``errors`` is a list of plain-language problems."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("Invalid input: " + "; ".join(errors))


class CatalogError(RuntimeError):
    """A template shipped in the image is malformed (a build-time problem, caught by tests)."""


def _resource_type_of(resource_id: str) -> str | None:
    """'/subscriptions/../providers/Microsoft.Network/virtualNetworks/v/subnets/s' -> 'Microsoft.Network/virtualNetworks/subnets'."""
    m = re.match(r"^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/([^/]+)/(.+)$", resource_id)
    if not m:
        return None
    parts = m.group(2).split("/")
    if len(parts) % 2:
        return None
    return m.group(1) + "/" + "/".join(parts[0::2])


def _check_format(fmt: str, value: str, schema: dict, path: str, errors: list[str]) -> None:
    if fmt == "cidr":
        try:
            if "/" not in value:
                raise ValueError
            ipaddress.ip_network(value, strict=True)
        except ValueError:
            errors.append(f"{path}: '{value}' is not a valid CIDR block such as 10.0.0.0/24")
    elif fmt == "ip_or_cidr":
        try:
            ipaddress.ip_network(value, strict=False)
        except ValueError:
            errors.append(f"{path}: '{value}' is not an IP address or CIDR block")
    elif fmt == "guid":
        if not GUID_RE.match(value):
            errors.append(f"{path}: must be a GUID (object or tenant id)")
    elif fmt == "ssh_public_key":
        if not SSH_KEY_RE.match(value.strip()):
            errors.append(f"{path}: must be an SSH PUBLIC key (starts with ssh-ed25519 or ssh-rsa)")
    elif fmt == "azure_resource_id":
        rtype = _resource_type_of(value)
        if rtype is None:
            errors.append(f"{path}: must be a full Azure resource ID (/subscriptions/.../resourceGroups/.../providers/...)")
        elif schema.get("resource_type") and rtype.lower() != schema["resource_type"].lower():
            errors.append(f"{path}: must be the resource ID of a {schema['resource_type']} (got {rtype})")


def validate_value(schema: dict, value: Any, path: str, errors: list[str]) -> Any:
    """Validate ``value`` against ``schema``; returns the (possibly defaulted) value."""
    typ = schema["type"]
    if typ == "string":
        if not isinstance(value, str):
            errors.append(f"{path}: must be text")
            return value
        if "min_length" in schema and len(value) < schema["min_length"]:
            errors.append(f"{path}: must be at least {schema['min_length']} characters")
        if "max_length" in schema and len(value) > schema["max_length"]:
            errors.append(f"{path}: must be at most {schema['max_length']} characters")
        if "pattern" in schema and not re.fullmatch(schema["pattern"], value):
            errors.append(f"{path}: '{value}' does not match the required pattern {schema['pattern']}")
        if "format" in schema:
            _check_format(schema["format"], value, schema, path, errors)
    elif typ in ("integer", "number"):
        ok = isinstance(value, int) and not isinstance(value, bool)
        if typ == "number":
            ok = ok or isinstance(value, float)
        if not ok:
            errors.append(f"{path}: must be {'a whole number' if typ == 'integer' else 'a number'}")
            return value
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: must be >= {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: must be <= {schema['maximum']}")
    elif typ == "boolean":
        if not isinstance(value, bool):
            errors.append(f"{path}: must be true or false")
            return value
    elif typ == "list":
        if not isinstance(value, list):
            errors.append(f"{path}: must be a list")
            return value
        if len(value) < schema.get("min_items", 0):
            errors.append(f"{path}: needs at least {schema['min_items']} item(s)")
        if "max_items" in schema and len(value) > schema["max_items"]:
            errors.append(f"{path}: at most {schema['max_items']} item(s) allowed")
        value = [validate_value(schema["items"], v, f"{path}[{i}]", errors) for i, v in enumerate(value)]
    elif typ == "map":
        if not isinstance(value, dict):
            errors.append(f"{path}: must be an object (name -> value)")
            return value
        if len(value) < schema.get("min_items", 0):
            errors.append(f"{path}: needs at least {schema['min_items']} entry(ies)")
        if "max_items" in schema and len(value) > schema["max_items"]:
            errors.append(f"{path}: at most {schema['max_items']} entries allowed")
        key_re = schema.get("key_pattern", r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$")
        out = {}
        for k, v in value.items():
            if not isinstance(k, str) or not re.fullmatch(key_re, k):
                errors.append(f"{path}: key '{k}' does not match {key_re}")
            out[k] = validate_value(schema["values"], v, f"{path}.{k}", errors)
        value = out
    elif typ == "object":
        if not isinstance(value, dict):
            errors.append(f"{path}: must be an object")
            return value
        value = _validate_object(schema.get("properties", {}), value, path, errors)
    if "enum" in schema and value not in schema["enum"] and not isinstance(value, (list, dict)):
        errors.append(f"{path}: must be one of {schema['enum']} (got {value!r})")
    return value


def _validate_object(properties: dict, values: dict, path: str, errors: list[str]) -> dict:
    out: dict[str, Any] = {}
    prefix = f"{path}." if path else ""
    for name in sorted(set(values) - set(properties)):
        errors.append(f"{prefix}{name}: is not a supported setting. Supported: {sorted(properties)}")
    for name, schema in properties.items():
        if name in values and values[name] is not None:
            out[name] = validate_value(schema, values[name], f"{prefix}{name}", errors)
        elif schema.get("required"):
            errors.append(f"{prefix}{name}: is required ({schema.get('description', schema['type'])})")
        elif "default" in schema:
            out[name] = schema["default"]
    return out


def check_schema(schema: Any, where: str) -> None:
    """Sanity-check a schema definition itself (run at load time and in tests)."""
    if not isinstance(schema, dict) or schema.get("type") not in _TYPES:
        raise CatalogError(f"{where}: needs a 'type' of {sorted(_TYPES)}")
    unknown = set(schema) - _SCHEMA_KEYS
    if unknown:
        raise CatalogError(f"{where}: unknown schema keys {sorted(unknown)}")
    if "format" in schema and schema["format"] not in _FORMATS:
        raise CatalogError(f"{where}: unknown format {schema['format']}")
    if "pattern" in schema:
        re.compile(schema["pattern"])
    if schema["type"] == "list":
        check_schema(schema.get("items"), f"{where}.items")
    if schema["type"] == "map":
        check_schema(schema.get("values"), f"{where}.values")
    if schema["type"] == "object":
        for k, v in schema.get("properties", {}).items():
            check_schema(v, f"{where}.{k}")
    if "default" in schema:
        errs: list[str] = []
        validate_value({k: v for k, v in schema.items() if k != "default"}, schema["default"], where, errs)
        if errs:
            raise CatalogError(f"{where}: default does not satisfy its own schema: {errs}")
    if schema.get("required") and "default" in schema:
        raise CatalogError(f"{where}: a variable cannot be both required and have a default")


class Catalog:
    def __init__(self, template_dir: pathlib.Path | str) -> None:
        self.dir = pathlib.Path(template_dir)
        self._templates: dict[str, dict] = {}
        for p in sorted(self.dir.iterdir()):
            if not p.is_dir() or p.name.startswith(("_", ".")):
                continue
            self._templates[p.name] = self._load(p)
        if not self._templates:
            raise CatalogError(f"no templates found in {self.dir}")

    def _load(self, path: pathlib.Path) -> dict:
        name = path.name
        if not TEMPLATE_NAME_RE.match(name):
            raise CatalogError(f"template folder name '{name}' is invalid")
        try:
            spec = json.loads((path / "template.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise CatalogError(f"template '{name}': template.json unreadable: {e}") from e
        for key in ("version", "title", "description", "category", "variables"):
            if key not in spec:
                raise CatalogError(f"template '{name}': template.json is missing '{key}'")
        if not re.fullmatch(r"\d+\.\d+\.\d+", str(spec["version"])):
            raise CatalogError(f"template '{name}': version must be semantic (1.0.0)")
        for var, schema in spec["variables"].items():
            if not VAR_NAME_RE.match(var):
                raise CatalogError(f"template '{name}': bad variable name '{var}'")
            if var in RESERVED_VARIABLES:
                raise CatalogError(f"template '{name}': '{var}' is injected by the server and cannot be in the schema")
            check_schema(schema, f"{name}.{var}")
        digest = hashlib.sha256()
        for f in sorted(path.rglob("*")):
            if f.is_file():
                digest.update(f.relative_to(path).as_posix().encode())
                digest.update(f.read_bytes())
        spec["name"] = name
        spec["content_hash"] = digest.hexdigest()[:16]
        return spec

    def names(self) -> list[str]:
        return list(self._templates)

    def get(self, name: str) -> dict:
        if not isinstance(name, str) or name not in self._templates:
            raise ValidationError([f"Unknown template '{name}'. Choose from: {self.names()}"])
        return self._templates[name]

    def path(self, name: str) -> pathlib.Path:
        self.get(name)
        return self.dir / name

    def common_file(self) -> pathlib.Path:
        return self.dir / "_common" / "common.tf"

    def describe(self, name: str | None = None, allowed: list[str] | None = None) -> list[dict]:
        out = []
        for n, spec in self._templates.items():
            if name and n != name:
                continue
            if allowed is not None and n not in allowed:
                continue
            out.append({k: spec[k] for k in ("name", "version", "title", "description", "category", "variables")
                        if k in spec} | {k: spec[k] for k in ("security_defaults", "outputs", "notes") if k in spec})
        return out

    def summary(self, allowed: list[str] | None = None) -> list[dict]:
        out = []
        for n, spec in self._templates.items():
            if allowed is not None and n not in allowed:
                continue
            req = [k for k, v in spec["variables"].items() if v.get("required")]
            out.append({"name": n, "version": spec["version"], "title": spec["title"], "category": spec["category"],
                        "description": spec["description"], "required_variables": req,
                        "optional_variables": [k for k in spec["variables"] if k not in req]})
        return out

    def validate_variables(self, template: str, variables: dict | None) -> dict:
        spec = self.get(template)
        if variables is None:
            variables = {}
        if not isinstance(variables, dict):
            raise ValidationError(["variables must be an object of name -> value"])
        errors: list[str] = []
        out = _validate_object(spec["variables"], variables, "", errors)
        if errors:
            raise ValidationError(errors)
        return out


def validate_deployment_name(name: Any) -> str:
    if not isinstance(name, str) or not DEPLOYMENT_NAME_RE.match(name) or "--" in name:
        raise ValidationError(["deployment_name must be 3-20 characters: lowercase letters, digits and single hyphens, "
                               "starting with a letter (example: payments-api)"])
    return name


def validate_tags(tags: Any) -> dict[str, str]:
    if tags is None:
        return {}
    errors = []
    if not isinstance(tags, dict) or len(tags) > 15:
        raise ValidationError(["tags must be an object with at most 15 entries"])
    for k, v in tags.items():
        if not isinstance(k, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,62}", k):
            errors.append(f"tag name '{k}' is invalid")
        if not isinstance(v, str) or len(v) > 256 or re.search(r"[<>%&\\?/\x00-\x1f]", v):
            errors.append(f"tag '{k}' has an invalid value")
    if errors:
        raise ValidationError(errors)
    return dict(tags)
