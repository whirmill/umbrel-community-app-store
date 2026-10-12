FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /build/renderer
COPY renderer/package*.json ./
RUN npm ci --ignore-scripts
COPY src/content-artifacts.ts /build/src/content-artifacts.ts
RUN npm run protocol && npm prune --omit=dev --ignore-scripts
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG CHROMIUM_VERSION=154.0.8037.92-1~deb12u1
RUN apt-get update && apt-get install -y --no-install-recommends chromium=${CHROMIUM_VERSION} python3 poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /build/renderer/node_modules ./node_modules
COPY --from=build /build/renderer/dist ./dist
COPY renderer/package.json renderer/render.mjs renderer/policy.mjs renderer/worker.py ./
COPY content ./content
USER 1000:1000
CMD ["python3","/app/worker.py"]
