# 密文中继服务器镜像：只转发，不解密，不存储
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=10686
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY index.js relay.js actions.json ./

USER node
EXPOSE 10686
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "index.js"]
