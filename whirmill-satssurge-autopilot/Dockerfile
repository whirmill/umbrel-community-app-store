FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY scripts/pi-scoped-stop-patch.* ./scripts/
COPY tsconfig.json ./
COPY src ./src
COPY content ./content
COPY lnd-proto ./lnd-proto
COPY web ./web
COPY vite.config.ts tsconfig.frontend.json components.json ./
RUN npm run build && npm prune --omit=dev --ignore-scripts
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends util-linux python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./
COPY --from=build /app/content ./content
COPY --from=build /app/lnd-proto ./lnd-proto
COPY scripts/*.py scripts/schema-targets.json ./scripts/
COPY scripts/app-control-node-probe.cjs ./scripts/
COPY --from=build /app/public ./public
USER 1000:1000
EXPOSE 8080
CMD ["python3","scripts/app_launcher.py"]
