# syntax=docker/dockerfile:1
# Image de production du backend Kwizora (issue #27) — déploiement Coolify.
# Node 20 : même version majeure que la CI (.github/workflows/ci.yml).

# --- 1. Build : dépendances complètes + compilation TypeScript -------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# --- 2. Dépendances de production uniquement -------------------------------
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

# --- 3. Image finale ---------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app
# Fichiers appartenant à root, en lecture seule pour l'utilisateur d'exécution
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Utilisateur non-root fourni par l'image officielle Node (uid 1000)
USER node
# HTTP et WebSocket (Socket.io) sur le même port
EXPOSE 3001
# Sonde légère, sans Supabase (src/health). fetch est natif dans Node 20.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
