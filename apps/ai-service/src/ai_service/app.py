import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.trace import Span, TracerProvider
from starlette.routing import Match

log = logging.getLogger("ai_service")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
REDACTED = "[REDACTED]"


def redact_query(span: Span, scope: dict[str, Any]) -> None:
    """Server-request hook: query strings may hold tokens or personal data, so they never reach traces."""
    if not span.is_recording() or not scope.get("query_string"):
        return
    path = str(scope.get("path", ""))
    span.set_attribute("url.query", REDACTED)
    span.set_attribute("http.target", f"{path}?{REDACTED}")
    span.set_attribute("http.url", f"{path}?{REDACTED}")


def request_id_from(header: str | None) -> str:
    """Accept a caller's x-request-id only if it is short and log-safe; otherwise mint one."""
    return header if header and _REQUEST_ID.fullmatch(header) else str(uuid.uuid4())


def _route_template(request: Request) -> str:
    for route in request.app.router.routes:
        match, _ = route.matches(request.scope)
        if match == Match.FULL:
            return str(getattr(route, "path", "unmatched"))
    return "unmatched"


def create_app(tracer_provider: TracerProvider | None = None) -> FastAPI:
    """Build the service. Parsing, extraction and judge endpoints arrive in M6.

    Tracing is wired here (not by auto-instrumentation) so the query-redaction hook is always applied;
    run with OTEL_PYTHON_DISABLED_INSTRUMENTATIONS=fastapi to avoid duplicate spans.
    """
    app = FastAPI(title="PRYSM AI service", docs_url=None, redoc_url=None, openapi_url=None)
    FastAPIInstrumentor.instrument_app(app, server_request_hook=redact_query, tracer_provider=tracer_provider)

    @app.middleware("http")
    async def request_logging(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        request_id = request_id_from(request.headers.get("x-request-id"))
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["x-request-id"] = request_id
        log.info(
            "request completed",
            extra={
                "event": "http_request",
                "request_id": request_id,
                "method": request.method,
                "route": _route_template(request),
                "status_code": response.status_code,
                "duration_ms": round((time.perf_counter() - started) * 1000),
            },
        )
        return response

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        # No downstream dependencies in M0: the service holds no DB credentials by design.
        # On SIGTERM uvicorn stops accepting connections and drains in-flight requests itself.
        return JSONResponse({"status": "ready", "checks": []})

    return app
