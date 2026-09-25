FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN mkdir -p /var/lib/opsdeck && chown node:node /var/lib/opsdeck

ENV NODE_ENV=production
ENV OPSDECK_PORT=9095
ENV OPSDECK_BIND_ADDRESS=127.0.0.1
EXPOSE 9095
USER node

CMD ["sh", "-c", "exec node node_modules/vinext/dist/cli.js start --hostname ${OPSDECK_BIND_ADDRESS} --port ${OPSDECK_PORT}"]
