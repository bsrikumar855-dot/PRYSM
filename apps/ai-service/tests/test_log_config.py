import json
import logging
import sys

from ai_service.log_config import JsonFormatter

CANARY = "CANARY-PAN-ABCDE1234F"


def _render(**extra: object) -> dict[str, object]:
    record = logging.makeLogRecord({"msg": "call", "levelname": "INFO", "levelno": logging.INFO, **extra})
    rendered: dict[str, object] = json.loads(JsonFormatter("ai-service").format(record))
    return rendered


def test_keeps_allow_listed_fields() -> None:
    out = _render(request_id="r1", tenant_id="t1", event="x")
    assert out["service"] == "ai-service"
    assert out["level"] == "info"
    assert out["request_id"] == "r1"
    assert out["tenant_id"] == "t1"
    assert out["msg"] == "call"
    assert str(out["time"]).endswith("Z")


def test_drops_payload_fields_and_never_writes_their_values() -> None:
    record = logging.makeLogRecord({"msg": "call", "prompt": CANARY, "document_text": CANARY, "request_id": "r1"})
    line = JsonFormatter("ai-service").format(record)
    assert CANARY not in line
    assert json.loads(line)["dropped_fields"] == ["document_text", "prompt"]


def test_maps_otel_trace_context_and_skips_empty_ids() -> None:
    out = _render(otelTraceID="abc", otelSpanID="0", otelServiceName="svc")
    assert out["trace_id"] == "abc"
    assert "span_id" not in out
    assert "dropped_fields" not in out


def test_errors_log_type_only() -> None:
    try:
        raise ValueError(CANARY)
    except ValueError:
        record = logging.makeLogRecord({"msg": "failed", "exc_info": sys.exc_info()})
    line = JsonFormatter("ai-service").format(record)
    assert json.loads(line)["err"] == {"type": "ValueError"}
    assert CANARY not in line
