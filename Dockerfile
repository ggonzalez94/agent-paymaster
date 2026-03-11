FROM node:22-alpine

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs .prettierrc.json .prettierignore ./
COPY packages ./packages

RUN pnpm install --no-frozen-lockfile

EXPOSE 3000

CMD ["pnpm", "--filter", "@agent-paymaster/api", "dev"]
