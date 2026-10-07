# The API and the orchestrator in one process (docs/12, milestones M0–M8).
#
#   docker build -t crew-backend ./backend
#   docker run -p 8787:8787 -v crew-data:/data crew-backend
#
# With no provider keys the server still boots and serves the contract; set
# CREW_OFFLINE_LLM=true for the deterministic fake runner, or pass a key for real runs.
FROM python:3.12-slim

# uv, for the same resolution the lockfile was written with.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Dependencies first so a source edit does not re-resolve them.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY src ./src

ENV CREW_HOST=0.0.0.0 \
    CREW_PORT=8787 \
    CREW_DATA_DIR=/data \
    CREW_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173

EXPOSE 8787
VOLUME ["/data"]

CMD ["uv", "run", "--no-dev", "python", "-m", "crew", "serve"]
