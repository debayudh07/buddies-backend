# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate && npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8000

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY openapi ./openapi

# Optional: mount or inject FIREBASE_SERVICE_ACCOUNT_JSON via env instead of a file
EXPOSE 8000

CMD ["sh", "-c", "npx prisma db push && node dist/index.js"]
