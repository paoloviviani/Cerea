# syntax=docker/dockerfile:1
# cerea-sandbox: the sandbox manager and its Docker socket proxy (ADR 0115). No dependencies to
# install: Node runs the TypeScript sources directly. Two commands, one image:
#   node src/manager/main.ts        node src/socket-proxy/main.ts
# Build from the repository root:  docker build -t cerea-sandbox sandbox/
FROM node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG VERSION=0.1.0
LABEL org.opencontainers.image.title="cerea-sandbox" \
      org.opencontainers.image.description="Cerea sandbox manager and Docker socket proxy" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /var/lib/sandbox && chown node:node /var/lib/sandbox
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "src/manager/main.ts"]
