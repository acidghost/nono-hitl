# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM golang:1.27.1-alpine@sha256:cf6fca6641884b8433441b2b0652976f975e1d0fdd26d177eaaf8596087f3125 AS builder
RUN apk add --no-cache just
WORKDIR /src
COPY go.mod ./
COPY main.go justfile ./
COPY internal ./internal
ARG BUILD_VERSION=0.0.0
ARG BUILD_COMMIT=unknown
ARG TARGETOS=linux
ARG TARGETARCH
RUN just version="${BUILD_VERSION}" commit_sha="${BUILD_COMMIT}" build "${TARGETOS}" "${TARGETARCH}" \
    && mv "build/nono-hitl-${TARGETOS}-${TARGETARCH}" /usr/local/bin/nono-hitl

FROM scratch
COPY --from=builder /usr/local/bin/nono-hitl /usr/local/bin/nono-hitl
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/nono-hitl"]
