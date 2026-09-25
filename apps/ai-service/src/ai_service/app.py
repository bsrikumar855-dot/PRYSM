import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from starlette.routing import Match

log = logging.getLogger("ai_service")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def request_id_from(header: str | None) -> str:
    """Accept a caller's x-request-id only if it is short and log-safe; otherwise mint one."""
    return header if header and _REQUEST_ID.fullmatch(header) else str(uuid.uuid4())


def _route_template(request: Request) -> str:
    for route in request.app.router.routes:
        match, _ = route.matches(request.scope)
        if match == Match.FULL:
            return str(getattr(route, "path", "unmatched"))
    return "unmatched"


def create_app() -> FastAPI:
    """Build the service. Parsing, extraction and judge endpoints arrive in M6."""
    app = FastAPI(title="PRYSM AI service", docs_url=None, redoc_url=None, openapi_url=None)

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
