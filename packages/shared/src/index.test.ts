import { describe, expect, it } from "vitest";

import { buildHealth } from "./index.js";

describe("buildHealth", () => {
  it("returns an ok status for a service", () => {
    const result = buildHealth("api");

    expect(result.service).toBe("api");
    expect(result.status).toBe("ok");
    expect(Date.parse(result.timestamp)).not.toBeNaN();
  });
});
