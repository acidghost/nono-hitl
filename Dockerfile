# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b

FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS builder
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
