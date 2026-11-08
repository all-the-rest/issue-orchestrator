FROM node:24-bookworm-slim

ENV COREPACK_HOME=/opt/corepack

RUN apt-get update \
  && apt-get install --yes --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@11.23.0 --activate \
  && test "$(COREPACK_ENABLE_NETWORK=0 pnpm --version)" = "11.23.0"

ENV HOME=/tmp/home \
  COREPACK_ENABLE_NETWORK=0 \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  PNPM_CONFIG_STORE_DIR=/pnpm-store/v11

RUN mkdir -p /pnpm-store \
  && test "$(pnpm --version)" = "11.23.0"

WORKDIR /workspace
USER node
