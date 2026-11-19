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

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD ss -ltn | grep -q ':8001' || exit 1

CMD ["node", "auth-gateway.js"]
