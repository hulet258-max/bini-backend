# Production image for EasyPanel / Docker
FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source
COPY src ./src

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

# Lightweight healthcheck (EasyPanel / orchestrators can also probe /api/health)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["npm", "start"]
