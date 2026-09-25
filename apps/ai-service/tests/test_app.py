import json
import logging

import pytest
from fastapi.testclient import TestClient

from ai_service.app import create_app, request_id_from


def test_request_id_accepts_safe_and_replaces_unsafe() -> None:
    assert request_id_from("abc-123") == "abc-123"
    assert len(request_id_from('bad id\n{"level":"fatal"}')) == 36
    assert len(request_id_from(None)) == 36


def test_healthz_and_readyz_echo_request_id() -> None:
    client = TestClient(create_app())
    health = client.get("/healthz", headers={"x-request-id": "req-1"})
    assert health.status_code == 200
    assert health.headers["x-request-id"] == "req-1"
    ready = client.get("/readyz")
    assert ready.status_code == 200
    assert ready.json() == {"status": "ready", "checks": []}


def test_request_log_uses_route_template_not_raw_path(caplog: pytest.LogCaptureFixture) -> None:
    app = create_app()

    @app.get("/docs/{doc_id}")
    async def doc(doc_id: str) -> dict[str, str]:
        return {"id": doc_id}

    with caplog.at_level(logging.INFO, logger="ai_service"):
        TestClient(app).get("/docs/secret-doc?token=CANARY", headers={"x-request-id": "req-2"})
    record = caplog.records[-1]
    assert record.__dict__["route"] == "/docs/{doc_id}"
    assert record.__dict__["request_id"] == "req-2"
    assert record.__dict__["status_code"] == 200
    assert "CANARY" not in json.dumps({k: str(v) for k, v in record.__dict__.items()})
