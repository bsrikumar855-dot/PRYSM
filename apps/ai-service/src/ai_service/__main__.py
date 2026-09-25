import logging

import uvicorn

from ai_service.app import create_app
from ai_service.config import Settings
from ai_service.log_config import configure_logging


def main() -> None:
    """Start the service. Run under `opentelemetry-instrument` for traces, metrics and logs."""
    settings = Settings()
    configure_logging(settings.service_name, settings.log_level)
    logging.getLogger("ai_service").info("starting", extra={"event": "started", "port": settings.port})
    uvicorn.run(
        create_app(),
        host=settings.host,
        port=settings.port,
        log_config=None,
        access_log=False,
        timeout_graceful_shutdown=settings.shutdown_timeout_s,
    )


if __name__ == "__main__":
    main()
