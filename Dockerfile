# Invoice Bridge — production image.
# Render builds this when the service is configured for the Docker runtime.
# (The native Node runtime via render.yaml works too; this Dockerfile is the
# fallback so the build succeeds either way.)
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Default uploads location inside the container. On Render, mount a persistent
# disk here and set UPLOAD_DIR=/uploads in the dashboard so files survive deploys.
RUN mkdir -p /uploads
ENV UPLOAD_DIR=/uploads

EXPOSE 3000

# Run the (idempotent) migration, then start the server. DATABASE_URL must be
# set in the environment for migrate to succeed.
CMD ["sh", "-c", "npm run migrate && npm start"]
