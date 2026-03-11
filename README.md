# Agent Paymaster Monorepo

Monorepo scaffold for the Taiko-focused ERC-4337 paymaster and bundler stack.

## Packages

- `@agent-paymaster/api`: Hono API service.
- `@agent-paymaster/bundler`: bundler worker/service skeleton.
- `@agent-paymaster/shared`: shared types and helpers.
- `@agent-paymaster/paymaster-contracts`: Hardhat contracts and tests.

## Requirements

- Node.js 22+
- pnpm 10+

## Quick start

```bash
cp .env.example .env
pnpm install
pnpm lint
pnpm test
pnpm build
```

Run services locally:

```bash
pnpm dev
```

Run contract tests:

```bash
pnpm --filter @agent-paymaster/paymaster-contracts test
```

## Docker

```bash
docker compose up --build
```

## Networks

Hardhat is configured for:

- `taikoMainnet`
- `taikoHekla`
