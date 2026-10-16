# Image for the Python ai-service. Build from the repo root:
#   docker build -f infra/docker/python.Dockerfile .
ARG PYTHON_IMAGE=python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

FROM ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336 AS uv

FROM ${PYTHON_IMAGE} AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
# Same path in both stages: the venv's scripts hard-code their interpreter path.
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY apps/ai-service ./apps/ai-service
RUN uv sync --frozen --no-dev --no-editable --package prysm-ai-service

FROM ${PYTHON_IMAGE}
RUN useradd --system --uid 10001 --no-create-home prysm
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1
USER prysm
EXPOSE 8000
CMD ["opentelemetry-instrument", "python", "-m", "ai_service"]
