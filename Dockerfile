FROM node:22-alpine

WORKDIR /app

# Instalar dependencias primero (capa cacheada)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copiar código fuente
COPY src/ ./src/
COPY scripts/ ./scripts/

# Usuario no-root por seguridad
RUN addgroup -g 1001 -S nodejs && adduser -S nodeuser -u 1001
USER nodeuser

EXPOSE 3000

# Ejecutar migración y luego el servidor
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]
