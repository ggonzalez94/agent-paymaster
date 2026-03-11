import { describe, expect, it } from "vitest";

import { createApp } from "./index.js";

describe("api", () => {
  it("returns service health", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);

    const payload = await res.json();
    expect(payload.service).toBe("api");
    expect(payload.status).toBe("ok");
  });

  it("returns a quote payload", async () => {
    const res = await createApp().request("/v1/paymaster/quote", {
      method: "POST",
      body: JSON.stringify({ chain: "taikoMainnet" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);

    const payload = await res.json();
    expect(payload.chain).toBe("taikoMainnet");
    expect(payload.supportedTokens).toContain("USDC");
  });
});
