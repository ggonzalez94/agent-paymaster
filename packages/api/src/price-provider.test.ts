import { describe, expect, it, vi } from "vitest";

import {
  ChainlinkOracleSource,
  CoinbaseOracleSource,
  CompositePriceProvider,
  KrakenOracleSource,
  type OracleSource,
} from "./price-provider.js";

const makeSource = (name: string, value: bigint, calls: { count: number }): OracleSource => ({
  name,
  async getObservation() {
    calls.count += 1;
    return {
      source: name,
      usdcPerEthMicros: value,
      observedAtMs: Date.UTC(2026, 2, 12),
    };
  },
});

describe("CompositePriceProvider", () => {
  it("uses Chainlink when it agrees with the market quorum", async () => {
    const chainlinkCalls = { count: 0 };
    const coinbaseCalls = { count: 0 };
    const krakenCalls = { count: 0 };

    const provider = new CompositePriceProvider({
      primary: makeSource("chainlink", 3_000_000_000n, chainlinkCalls),
      fallbacks: [
        makeSource("coinbase", 3_001_000_000n, coinbaseCalls),
        makeSource("kraken", 2_999_000_000n, krakenCalls),
      ],
      maxPrimaryDeviationBps: 75,
      cacheTtlMs: 15_000,
      nowMs: () => Date.UTC(2026, 2, 12),
    });

    await expect(provider.getUsdcPerEthMicros("taikoMainnet")).resolves.toBe(3_000_000_000n);
    expect(chainlinkCalls.count).toBe(1);
    expect(coinbaseCalls.count).toBe(1);
    expect(krakenCalls.count).toBe(1);
  });

  it("falls back to the median of Coinbase and Kraken when Chainlink is unavailable", async () => {
    const provider = new CompositePriceProvider({
      primary: {
        name: "chainlink",
        async getObservation() {
          throw new Error("chainlink stale");
        },
      },
      fallbacks: [
        makeSource("coinbase", 3_001_000_000n, { count: 0 }),
        makeSource("kraken", 2_999_000_000n, { count: 0 }),
      ],
      nowMs: () => Date.UTC(2026, 2, 12),
    });

    await expect(provider.getUsdcPerEthMicros("taikoMainnet")).resolves.toBe(3_000_000_000n);
  });

  it("fails closed when fewer than two fresh sources are available", async () => {
    const provider = new CompositePriceProvider({
      primary: makeSource("chainlink", 3_000_000_000n, { count: 0 }),
      fallbacks: [
        {
          name: "coinbase",
          async getObservation() {
            throw new Error("coinbase timeout");
          },
        },
      ],
      nowMs: () => Date.UTC(2026, 2, 12),
    });

    await expect(provider.getUsdcPerEthMicros("taikoMainnet")).rejects.toThrow(
      "Oracle quorum unavailable",
    );
  });

  it("fails closed when Chainlink deviates too far from the market median", async () => {
    const provider = new CompositePriceProvider({
      primary: makeSource("chainlink", 3_200_000_000n, { count: 0 }),
      fallbacks: [
        makeSource("coinbase", 3_000_000_000n, { count: 0 }),
        makeSource("kraken", 3_000_000_000n, { count: 0 }),
      ],
      maxPrimaryDeviationBps: 75,
      nowMs: () => Date.UTC(2026, 2, 12),
    });

    await expect(provider.getUsdcPerEthMicros("taikoMainnet")).rejects.toThrow("deviated");
  });

  it("caches resolved prices for the configured ttl", async () => {
    let now = Date.UTC(2026, 2, 12);
    const chainlinkCalls = { count: 0 };

    const provider = new CompositePriceProvider({
      primary: makeSource("chainlink", 3_000_000_000n, chainlinkCalls),
      fallbacks: [
        makeSource("coinbase", 3_001_000_000n, { count: 0 }),
        makeSource("kraken", 2_999_000_000n, { count: 0 }),
      ],
      cacheTtlMs: 15_000,
      nowMs: () => now,
    });

    await expect(provider.getUsdcPerEthMicros("taikoMainnet")).resolves.toBe(3_000_000_000n);
    now += 10_000;
    await expect(provider.getUsdcPerEthMicros("taikoMainnet")).resolves.toBe(3_000_000_000n);

    expect(chainlinkCalls.count).toBe(1);
  });
});

describe("ChainlinkOracleSource", () => {
  it("computes ETH/USDC from ETH/USD and USDC/USD feeds", async () => {
    const readFeed = vi.fn(async (feedAddress: `0x${string}`) => {
      if (feedAddress === "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419") {
        return {
          answer: 3_000n * 10n ** 8n,
          decimals: 8,
          updatedAtMs: Date.UTC(2026, 2, 12) - 60_000,
        };
      }

      return {
        answer: 1n * 10n ** 8n,
        decimals: 8,
        updatedAtMs: Date.UTC(2026, 2, 12) - 60_000,
      };
    });

    const source = new ChainlinkOracleSource({
      readFeed,
      nowMs: () => Date.UTC(2026, 2, 12),
    });

    await expect(source.getObservation("taikoMainnet")).resolves.toMatchObject({
      source: "chainlink",
      usdcPerEthMicros: 3_000_000_000n,
    });
  });
});

describe("CoinbaseOracleSource", () => {
  it("parses ticker responses into a USDC per ETH quote", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.includes("ETH-USD")
        ? { price: "3000.00", time: "2026-03-12T00:00:00.000Z" }
        : { price: "1.0000", time: "2026-03-12T00:00:01.000Z" };

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    });

    const source = new CoinbaseOracleSource({
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(source.getObservation("taikoMainnet")).resolves.toMatchObject({
      source: "coinbase",
      usdcPerEthMicros: 3_000_000_000n,
    });
  });
});

describe("KrakenOracleSource", () => {
  it("parses public ticker responses into a USDC per ETH quote", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.includes("ETHUSD")
        ? {
            error: [],
            result: {
              XETHZUSD: {
                c: ["3000.0"],
              },
            },
          }
        : {
            error: [],
            result: {
              USDCUSD: {
                c: ["1.0"],
              },
            },
          };

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    });

    const source = new KrakenOracleSource({
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(source.getObservation("taikoMainnet")).resolves.toMatchObject({
      source: "kraken",
      usdcPerEthMicros: 3_000_000_000n,
    });
  });
});
