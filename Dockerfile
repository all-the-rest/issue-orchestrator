FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
ENV ISSUE_ORCHESTRATOR_HOME=/var/lib/issue-orchestrator
WORKDIR /opt/issue-orchestrator
RUN apt-get update && apt-get install --no-install-recommends --yes git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /build/dist ./dist
COPY --from=build --chown=node:node /build/package.json ./package.json
COPY --chown=node:node docker/worker.sh /usr/local/bin/issue-orchestrator-worker
RUN chmod 0555 /usr/local/bin/issue-orchestrator-worker \
  && mkdir -p /var/lib/issue-orchestrator \
  && chown -R node:node /var/lib/issue-orchestrator /opt/issue-orchestrator
USER node
ENTRYPOINT ["/usr/local/bin/issue-orchestrator-worker"]
