# syntax=docker/dockerfile:1

# --- Etapa 1: build ---
# Necesitamos todas las deps (incluidas devDependencies como tsc y vite)
# para poder compilar el server y buildear el cliente.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Etapa 2: runtime ---
# Imagen final liviana: solo dependencias de producción + dist/ compilado.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
