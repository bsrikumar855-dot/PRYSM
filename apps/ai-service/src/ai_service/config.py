from typing import Literal

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Service settings from the environment; invalid values stop the process at startup."""

    service_name: str = "ai-service"
    host: str = "0.0.0.0"  # noqa: S104 - binds inside the container; the host maps it to 127.0.0.1 in dev
    port: int = 8000
    log_level: Literal["critical", "error", "warning", "info", "debug"] = "info"
    shutdown_timeout_s: int = 30
