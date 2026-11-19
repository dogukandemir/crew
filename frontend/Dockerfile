FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE=http://127.0.0.1:8787
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build
FROM nginx:1.30-alpine@sha256:3bc3836dc0be3b811f238210360bf8e7ca8a2d0effdae46160bf1f3578710051
# Non-root at runtime with the same numeric identity the other Crew images use.
# nginx needs a writable pid and temp paths, so the main config moves them under
# /tmp; the server block in conf.d is unchanged and listens on 5173.
RUN addgroup -g 10001 -S crew \
 && adduser -u 10001 -G crew -S -D -H crew \
 && mkdir -p /tmp/nginx-client /tmp/nginx-proxy /tmp/nginx-fastcgi /tmp/nginx-uwsgi /tmp/nginx-scgi \
 && chown crew:crew /tmp/nginx-client /tmp/nginx-proxy /tmp/nginx-fastcgi /tmp/nginx-uwsgi /tmp/nginx-scgi \
 && printf '%s\n' \
      'pid /tmp/nginx.pid;' \
      'error_log /dev/stderr warn;' \
      'events { worker_connections 1024; }' \
      'http {' \
      '    include /etc/nginx/mime.types;' \
      '    default_type application/octet-stream;' \
      '    access_log /dev/stdout;' \
      '    client_body_temp_path /tmp/nginx-client;' \
      '    proxy_temp_path /tmp/nginx-proxy;' \
      '    fastcgi_temp_path /tmp/nginx-fastcgi;' \
      '    uwsgi_temp_path /tmp/nginx-uwsgi;' \
      '    scgi_temp_path /tmp/nginx-scgi;' \
      '    include /etc/nginx/conf.d/*.conf;' \
      '}' > /etc/nginx/nginx.conf \
 && chown crew:crew /etc/nginx/nginx.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 5173
USER crew
