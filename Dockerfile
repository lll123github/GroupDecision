ARG RUST_IMAGE=rust:1.99.1-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim

FROM ${RUST_IMAGE} AS builder
WORKDIR /build

ARG CARGO_REGISTRY_MIRROR=https://rsproxy.cn/index/
ENV CARGO_BUILD_JOBS=2 CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_TIMEOUT=60

COPY Cargo.toml Cargo.lock ./
COPY src/ ./src/
RUN mkdir -p .cargo && \
    if [ -n "$CARGO_REGISTRY_MIRROR" ]; then \
      printf '[source.crates-io]\nreplace-with = "container-mirror"\n[source.container-mirror]\nregistry = "sparse+%s"\n' "$CARGO_REGISTRY_MIRROR" > .cargo/config.toml; \
    fi
RUN --mount=type=cache,id=groupdecision-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=groupdecision-git,target=/usr/local/cargo/git \
    cargo build --release --locked && \
    mkdir -p /out && \
    cp target/release/group-decision /out/group-decision && \
    strip /out/group-decision

FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /app

RUN mkdir -p /app/data && chown 10001:10001 /app/data
COPY --from=builder /out/group-decision /usr/local/bin/group-decision
COPY static/ ./static/
COPY --chmod=0755 scripts/container-healthcheck.sh /usr/local/bin/groupdecision-healthcheck

ENV DTRP_ROOT=/app \
    DTRP_BIND=0.0.0.0:18760 \
    DTRP_DATABASE=/app/data/decisions.sqlite3 \
    DTRP_SECURE_COOKIE=0

USER 10001:10001
EXPOSE 18760
STOPSIGNAL SIGINT
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD ["/usr/local/bin/groupdecision-healthcheck"]
ENTRYPOINT ["/usr/local/bin/group-decision"]
