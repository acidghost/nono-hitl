# syntax=docker/dockerfile:1.29.0@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183

# The bundle is the same on every platform, so it builds once on the build host.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS web
WORKDIR /src
COPY internal/webui/package.json internal/webui/bun.lock internal/webui/bunfig.toml internal/webui/tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY internal/webui/src ./src
RUN bun run build

FROM golang:1.27.4-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS builder
RUN apk add --no-cache just
WORKDIR /src
COPY go.mod ./
COPY main.go justfile ./
COPY internal ./internal
COPY --from=web /src/dist ./internal/webui/dist
ARG BUILD_VERSION=0.0.0
ARG BUILD_COMMIT=unknown
ARG TARGETOS=linux
ARG TARGETARCH
# --no-deps: the web stage already built dist/, and this stage has no bun.
RUN just --no-deps version="${BUILD_VERSION}" commit_sha="${BUILD_COMMIT}" build "${TARGETOS}" "${TARGETARCH}" \
    && mv "build/nono-hitl-${TARGETOS}-${TARGETARCH}" /usr/local/bin/nono-hitl

FROM scratch
COPY --from=builder /usr/local/bin/nono-hitl /usr/local/bin/nono-hitl
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/nono-hitl"]
