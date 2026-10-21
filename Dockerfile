FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 luma && useradd --uid 10001 --gid luma --no-create-home luma
COPY --from=build --chown=luma:luma /app/node_modules ./node_modules
COPY --from=build --chown=luma:luma /app/dist ./dist
COPY --chown=luma:luma package*.json openapi.json ./
USER luma
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
