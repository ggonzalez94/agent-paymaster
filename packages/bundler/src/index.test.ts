import { describe, expect, it } from "vitest";

import { BundlerService } from "./index.js";

describe("BundlerService", () => {
  it("returns health payload", () => {
    const service = new BundlerService();
    const result = service.getHealth();

    expect(result.service).toBe("bundler");
    expect(result.status).toBe("ok");
  });
});
