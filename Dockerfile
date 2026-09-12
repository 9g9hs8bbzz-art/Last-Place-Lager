# An alternative to Railway's Nixpacks builder, for hosts that want a container.
# Produces one image that serves both the API and the web client.
FROM node:22-slim AS build
WORKDIR /app
# OpenSSL is needed by the database client.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app ./
# Uploaded ticket images live here. Mount a volume at this path so they
# survive a redeploy.
RUN mkdir -p /app/apps/api/uploads
EXPOSE 8080
CMD ["npm", "start"]
