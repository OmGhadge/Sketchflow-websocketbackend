FROM node:18

WORKDIR /app

# Copy the whole monorepo
COPY . .

# Move into the websocket-backend app directory
WORKDIR /app/apps/websocket-backend

RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

RUN pnpm build

EXPOSE 8080

CMD ["pnpm", "start"] 