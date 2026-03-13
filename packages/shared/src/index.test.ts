import { describe, expect, it } from "vitest";

import {
  buildHealth,
  normalizePaymasterAndData,
  packPaymasterAndData,
  type RpcConfig,
} from "./index.js";

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

  it("packs paymasterAndData with the gas prefixes required on-chain", () => {
    const packed = packPaymasterAndData({
      paymaster: "0x9999999999999999999999999999999999999999",
      paymasterVerificationGasLimit: 0xea60n,
      paymasterPostOpGasLimit: 0xafc8n,
      paymasterData: "0xabcd",
    });

    expect(packed.slice(0, 42)).toBe("0x9999999999999999999999999999999999999999");
    expect(packed.slice(42, 74)).toBe("0000000000000000000000000000ea60");
    expect(packed.slice(74, 106)).toBe("0000000000000000000000000000afc8");
    expect(packed.endsWith("abcd")).toBe(true);
  });

  it("normalizes legacy paymasterAndData into the packed on-chain form", () => {
    const normalized = normalizePaymasterAndData({
      paymasterAndData: "0x9999999999999999999999999999999999999999abcd",
      paymasterVerificationGasLimit: 0xea60n,
      paymasterPostOpGasLimit: 0xafc8n,
    });

    expect(normalized.inputFormat).toBe("legacy");
    expect(normalized.paymasterData).toBe("0xabcd");
    expect(normalized.paymasterAndData.slice(42, 74)).toBe("0000000000000000000000000000ea60");
    expect(normalized.paymasterAndData.slice(74, 106)).toBe("0000000000000000000000000000afc8");
  });

  it("reads gas limits back out of packed paymasterAndData", () => {
    const packed = packPaymasterAndData({
      paymaster: "0x9999999999999999999999999999999999999999",
      paymasterVerificationGasLimit: 0xea60n,
      paymasterPostOpGasLimit: 0xafc8n,
      paymasterData: "0xabcd",
    });

    const normalized = normalizePaymasterAndData({
      paymasterAndData: packed,
    });

    expect(normalized.inputFormat).toBe("packed");
    expect(normalized.paymasterVerificationGasLimit).toBe(0xea60n);
    expect(normalized.paymasterPostOpGasLimit).toBe(0xafc8n);
    expect(normalized.paymasterData).toBe("0xabcd");
  });
});
