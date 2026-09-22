FROM node:24-bookworm-slim AS base
WORKDIR /app
FROM base AS cloud
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils python3 && rm -rf /var/lib/apt/lists/*
COPY cloud.mjs scheduler.mjs ./
COPY web ./web
COPY admin ./admin
COPY skills ./skills
USER node
CMD ["node","cloud.mjs"]
FROM base AS gateway
COPY gateway.mjs ./
USER node
CMD ["node","gateway.mjs"]
FROM base AS worker
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap python3 git ripgrep ca-certificates libseccomp2 && rm -rf /var/lib/apt/lists/* && mkdir -p /app/data/worker-outbox && chown -R node:node /app/data
COPY worker.mjs runner.mjs ./
COPY tools-helper.mjs /usr/local/lib/pig-tools-helper.mjs
COPY skills ./skills
USER node
CMD ["node","worker.mjs"]
