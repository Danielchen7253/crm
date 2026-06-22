FROM node:22-alpine AS base
WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN corepack enable && pnpm install --frozen-lockfile=false

COPY . .
RUN pnpm --filter @coolfix-crm/api build

EXPOSE 4000
CMD ["pnpm", "--filter", "@coolfix-crm/api", "start"]
