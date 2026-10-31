# Optional: run the whole shop (frontend + API) in a container for local development or
# self-hosting. Vercel does NOT use this file; it deploys from vercel.json instead.
FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# Create/update tables and store photos, then start the server.
CMD ["sh", "-c", "node backend/scripts/migrate.js && node backend/scripts/seed.js && node backend/server.js"]
