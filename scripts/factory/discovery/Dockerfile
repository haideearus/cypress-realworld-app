# Official node manifest-list digest resolved 2026-11-17. Dependencies follow yarn.lock.
FROM node:22.20.0-bookworm@sha256:915acd9e9b885ead0c620e27e37c81b74c226e0e1c8177f37a60217b6eabb0d7
RUN apt-get update && apt-get install -y --no-install-recommends libgtk-3-0 libgbm1 libnss3 libasound2 libxss1 libxtst6 xauth xvfb && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY source/ /source/
COPY trusted/ /trusted/
ENV COREPACK_HOME=/opt/corepack CYPRESS_CACHE_FOLDER=/opt/cypress YARN_PRODUCTION=false CI=true
RUN corepack enable && corepack prepare yarn@1.22.22 --activate && yarn install --frozen-lockfile --production=false && yarn predev:cognito:ci && yarn test:unit:ci && yarn build:ci && yarn cypress verify && chmod -R a+rX /source /trusted /opt/cypress /opt/corepack
USER 1000:1000
