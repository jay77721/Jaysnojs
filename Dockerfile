FROM node:alpine3.20

WORKDIR /tmp

COPY . .

EXPOSE 3000/tcp

RUN apk update && apk upgrade &&\
    apk add --no-cache openssl curl gcompat iproute2 coreutils &&\
    apk add --no-cache bash &&\
    chmod +x index.js &&\
    npm install

# index.js runs the proxy core on 3001-3004, so the gateway must not use those
ENV INNER_PORT=3021
ENV ARGO_PORT=8001

# build stamp, shown by GET /version and GET /healthz
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# healthy means "core up AND tunnel answering" -- /healthz checks both, so a
# silently dead cloudflared no longer shows up as a healthy container
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/healthz | grep -q '"ok":true' || exit 1

CMD ["node", "auth-gateway.js"]
