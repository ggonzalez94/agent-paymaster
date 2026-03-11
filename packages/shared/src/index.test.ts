import { describe, expect, it } from "vitest";

import { buildHealth, type RpcConfig } from "./index.js";

describe("buildHealth", () => {
  it("returns an ok status for a service", () => {
    const result = buildHealth("api");

    expect(result.service).toBe("api");
    expect(result.status).toBe("ok");
    expect(Date.parse(result.timestamp)).not.toBeNaN();
  });

  it("supports taikoHoodi chain name", () => {
    const config: RpcConfig = {
      chain: "taikoHoodi",
      rpcUrl: "https://rpc.test",
    };

    expect(config.chain).toBe("taikoHoodi");
  });
});
