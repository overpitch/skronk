# The Skronk game server, for hosting online (Fly.io, Render, or anything that runs containers).
# It runs server/main.ts; the game itself stays on GitHub Pages and connects to it.
# Settings come from environment variables: SKRONK_MAP, SKRONK_BOTS, SKRONK_DIFFICULTY, PORT.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY server ./server
COPY public/assets/maps ./public/assets/maps
ENV PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "server/main.ts"]
