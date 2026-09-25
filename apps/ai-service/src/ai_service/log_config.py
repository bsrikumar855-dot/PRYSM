import json
import logging
from datetime import UTC, datetime
from typing import Any

# Same allowlist as @prysm/platform: anything else passed via `extra=` is dropped and only its key kept,
# so document text, prompts and model output can't leak into logs.
LOG_FIELDS = frozenset(
    {
        "tenant_id",
        "request_id",
        "trace_id",
        "span_id",
        "event",
        "component",
        "method",
        "route",
        "status_code",
        "duration_ms",
        "check",
        "ok",
        "port",
        "version",
    }
)

# Attributes every LogRecord has; never treated as caller-supplied fields.
_RECORD_ATTRS = frozenset(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime", "taskName"}
_OTEL_ATTRS = {"otelTraceID": "trace_id", "otelSpanID": "span_id"}


class JsonFormatter(logging.Formatter):
    """One JSON object per line with the service name and allow-listed fields only."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        """Render a record, dropping non-allow-listed fields."""
        created = datetime.fromtimestamp(record.created, UTC)
        out: dict[str, Any] = {
            "level": record.levelname.lower(),
            "time": created.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "service": self.service,
        }
        dropped: list[str] = []
        for key, value in vars(record).items():
            if key in _OTEL_ATTRS:
                if value and value != "0":
                    out[_OTEL_ATTRS[key]] = value
            elif key in _RECORD_ATTRS or key.startswith("otel"):
                continue
            elif key in LOG_FIELDS:
                out[key] = value
            else:
                dropped.append(key)
        if dropped:
            out["dropped_fields"] = sorted(dropped)
        if record.exc_info and record.exc_info[0] is not None:
            out["err"] = {"type": record.exc_info[0].__name__}
        out["msg"] = record.getMessage()
        return json.dumps(out, default=str)


def configure_logging(service: str, level: str) -> None:
    """Route the root logger (and uvicorn's) through the JSON formatter."""
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter(service))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers = []
        logging.getLogger(name).propagate = True
    # Access logs carry raw paths and query strings; our middleware logs route templates instead.
    logging.getLogger("uvicorn.access").disabled = True
