import { buildHealth } from "@agent-paymaster/shared";
import { Hono } from "hono";

export const createApp = (): Hono => {
  const app = new Hono();

  app.get("/health", (c) => c.json(buildHealth("api")));

  app.post("/v1/paymaster/quote", async (c) => {
    const body = await c.req.json().catch(() => ({}));

    return c.json({
      supportedTokens: ["USDC"],
      chain: body.chain ?? "taikoHekla",
      ready: true,
    });
  });

  return app;
};
