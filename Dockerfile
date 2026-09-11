FROM node:24-alpine AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/sistemandrestudio-api/package.json ./apps/sistemandrestudio-api/package.json
COPY packages/application/package.json ./packages/application/package.json
COPY packages/content-engine/package.json ./packages/content-engine/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/evidence/package.json ./packages/evidence/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/sources/package.json ./packages/sources/package.json

RUN npm ci --ignore-scripts

FROM dependencies AS build

COPY . .

RUN npm run build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

COPY --from=dependencies --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist

USER app

EXPOSE 4317

CMD ["node", "dist/apps/sistemandrestudio-api/src/orchestration-server.js"]
