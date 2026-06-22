FROM node:22-alpine AS base
WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN corepack enable && pnpm install --frozen-lockfile=false

COPY . .
RUN pnpm --filter @coolfix-crm/web build

EXPOSE 3000
CMD ["pnpm", "--filter", "@coolfix-crm/web", "start"]
