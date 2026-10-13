# ---- build ----
FROM node:22-slim AS build
WORKDIR /app

# Prisma на slim-образі потребує openssl
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
# Локальний бінарник, а не npx: npx тягне Prisma 7, де url у schema.prisma
# не підтримується, і збірка падає з P1012
RUN ./node_modules/.bin/prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Скрипт скидання демо-стенду (cron kort-demo-reset) збирається окремим tsc у dist-scripts:
# tsx у runtime-образі немає (devDependencies), а rootDir основної збірки — src, тож
# CMD і dist/index.js це не зачіпає. Запуск: node dist-scripts/scripts/demo-stand-reset.js
COPY scripts/demo-stand-reset.ts scripts/demo-online.ts scripts/plans-init.ts ./scripts/
COPY tsconfig.scripts.json ./
RUN npm run build:scripts

# ---- runtime ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# prisma лежить у dependencies, а не devDependencies — саме щоб пережити
# --omit=dev і дати запустити migrate deploy на старті контейнера
RUN npm ci --omit=dev

COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-scripts ./dist-scripts
COPY prisma ./prisma

# Не запускаємо від root
USER node
EXPOSE 3000

# Міграції застосовуються при старті: деплой не потребує ручних команд.
# Знову локальний бінарник, не npx.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/index.js"]
