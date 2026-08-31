# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

FROM golang:1.26.6-alpine@sha256:af8d6740070b8906d12eae1c3e3ea0957fb63f492051ea05e354c38ef9fe88df AS builder
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
