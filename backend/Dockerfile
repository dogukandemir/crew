FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev
ENV CREW_HOST=0.0.0.0 CREW_PORT=8787 CREW_DATA_DIR=/data \
    CREW_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
ENV PATH="/app/.venv/bin:${PATH}"
EXPOSE 8787
VOLUME ["/data"]
CMD ["/app/.venv/bin/python", "-m", "crew", "serve"]
