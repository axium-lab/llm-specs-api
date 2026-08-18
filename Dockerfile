FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Cloud Run injects PORT; 8080 is its default value.
ENV PORT=8080
EXPOSE 8080

USER bun
CMD ["bun", "src/index.ts"]
