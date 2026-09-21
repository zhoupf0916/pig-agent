FROM node:24-bookworm-slim AS base
WORKDIR /app
FROM base AS cloud
COPY cloud.mjs ./
COPY web ./web
COPY admin ./admin
USER node
CMD ["node","cloud.mjs"]
FROM base AS gateway
COPY gateway.mjs ./
USER node
CMD ["node","gateway.mjs"]
FROM base AS worker
COPY worker.mjs ./
CMD ["node","worker.mjs"]
FROM base AS runner
RUN apt-get update && apt-get install -y --no-install-recommends python3 git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir /workspace && chown node:node /workspace
COPY runner.mjs ./
COPY skills ./skills
USER node
CMD ["node","runner.mjs"]
