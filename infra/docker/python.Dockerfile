# Image for the Python ai-service. Build from the repo root:
#   docker build -f infra/docker/python.Dockerfile .
ARG PYTHON_IMAGE=python:3.12.14-slim-trixie@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9

FROM ghcr.io/astral-sh/uv:0.12.22@sha256:f513a91fc62fe7c17567eee97230dd198e43edb8a9fbecca843714a4358fe1bc AS uv

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
