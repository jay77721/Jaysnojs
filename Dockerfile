# syntax=docker/dockerfile:1

# Binaries are baked in: nothing is downloaded at boot any more, so a dead
# third-party mirror can no longer keep the container from starting.
FROM alpine:3.20 AS binaries
ARG TARGETARCH
# optional egress proxy for local builds (CI leaves these empty)
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY
ARG XRAY_VER=26.11.9
ARG CFD_VER=2026.11.1
RUN apk add --no-cache curl unzip ca-certificates && \
    case "$TARGETARCH" in \
      amd64) XZIP=Xray-linux-64.zip; CFD=cloudflared-linux-amd64 ;; \
      arm64) XZIP=Xray-linux-arm64-v8a.zip; CFD=cloudflared-linux-arm64 ;; \
      *) echo "unsupported arch $TARGETARCH"; exit 1 ;; \
    esac && \
    curl -fL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 -o /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VER}/${XZIP}" && \
    unzip -q /tmp/xray.zip xray -d /out && chmod +x /out/xray && \
    curl -fL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 -o /out/cloudflared "https://github.com/cloudflare/cloudflared/releases/download/${CFD_VER}/${CFD}" && \
    chmod +x /out/xray /out/cloudflared && \
    /out/xray version | head -1

FROM node:alpine3.20

RUN apk add --no-cache curl ca-certificates

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY auth-gateway.js index.js ./
COPY --from=binaries /out/xray /usr/local/bin/xray
COPY --from=binaries /out/cloudflared /usr/local/bin/cloudflared

ENV INNER_PORT=3021
ENV ARGO_PORT=8001
ENV FILE_PATH=./tmp
ENV PROTOCOLS=vless,vmess,trojan
ENV TRANSPORTS=ws,httpupgrade

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

EXPOSE 3000/tcp

# healthy means "core up AND tunnel answering" -- /healthz checks both
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/healthz | grep -q '"ok":true' || exit 1

CMD ["node", "auth-gateway.js"]
