FROM oven/bun:1-alpine
WORKDIR /app

COPY package.json bun.lock ./
COPY include/gss/package.json ./include/gss/package.json
RUN bun install

COPY . .

EXPOSE 5001
CMD ["bun", "run", "start"]
