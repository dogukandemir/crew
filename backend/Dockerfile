FROM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 # 3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.0@sha256:cdc6093146eb3ff6a40107b38f008b789e050e77ad87865e381d9917da55a168 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev
# Non-root at runtime. `crew` is uid/gid 10001 in every Crew image: the API and
# the sandbox broker share it because the broker creates /sandbox-auth/token with
# mode 0600 and the API reads that file. /data and /workspaces are created here
# with that ownership so a fresh named volume inherits it on first mount; a
# volume created by an earlier root-running installation needs a one-time chown
# (docs/DEPLOYING.md).
RUN groupadd --gid 10001 crew \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin crew \
 && mkdir -p /data /workspaces \
 && chown crew:crew /data /workspaces
ENV CREW_HOST=0.0.0.0 CREW_PORT=8787 CREW_DATA_DIR=/data \
    CREW_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 \
    HOME=/home/crew \
    PYTHONDONTWRITEBYTECODE=1
ENV PATH="/app/.venv/bin:${PATH}"
EXPOSE 8787
VOLUME ["/data"]
USER crew
CMD ["/app/.venv/bin/python", "-m", "crew", "serve"]
