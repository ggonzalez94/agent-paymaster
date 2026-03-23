import type { GasPriceGuidance, GasPriceOracle } from "./paymaster-service.js";

const DEFAULT_TAIKO_RPC_URL = "https://rpc.mainnet.taiko.xyz";
const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 2_000;
/** Minimum tip to ensure transactions are picked up (0.001 gwei). */
const MIN_PRIORITY_FEE_WEI = 1_000_000n;
/** Default tip when eth_maxPriorityFeePerGas is unavailable (0.01 gwei). */
const DEFAULT_PRIORITY_FEE_WEI = 10_000_000n;

interface RpcGasPriceOracleConfig {
  rpcUrl?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetches gas price data from a chain RPC and caches it briefly.
 *
 * Returns a `GasPriceGuidance` with:
 * - `baseFeePerGas`: current block base fee
 * - `suggestedMaxFeePerGas`: 2 × baseFee + priorityFee (safe buffer for 2 blocks)
 * - `suggestedMaxPriorityFeePerGas`: tip from eth_maxPriorityFeePerGas or default
 */
export class RpcGasPriceOracle implements GasPriceOracle {
  private readonly rpcUrl: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private cachedGuidance: GasPriceGuidance | null = null;
  private cacheExpiresAt = 0;

  constructor(config: RpcGasPriceOracleConfig = {}) {
    this.rpcUrl = config.rpcUrl ?? DEFAULT_TAIKO_RPC_URL;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getGasPriceGuidance(): Promise<GasPriceGuidance | null> {
    if (this.cachedGuidance !== null && Date.now() < this.cacheExpiresAt) {
      return this.cachedGuidance;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const [baseFeeResult, priorityFeeResult] = await Promise.allSettled([
        this.rpcCall("eth_getBlockByNumber", ["latest", false], controller.signal),
        this.rpcCall("eth_maxPriorityFeePerGas", [], controller.signal),
      ]);

      const baseFeeHex = this.extractBaseFee(baseFeeResult);
      if (baseFeeHex === null) {
        return null;
      }

      const baseFee = BigInt(baseFeeHex);
      const priorityFee = this.extractPriorityFee(priorityFeeResult);
      const suggestedMaxFee = baseFee * 2n + priorityFee;

      const guidance: GasPriceGuidance = {
        baseFeePerGas: toHex(baseFee),
        suggestedMaxFeePerGas: toHex(suggestedMaxFee),
        suggestedMaxPriorityFeePerGas: toHex(priorityFee),
        fetchedAt: new Date().toISOString(),
      };

      this.cachedGuidance = guidance;
      this.cacheExpiresAt = Date.now() + this.cacheTtlMs;

      return guidance;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async rpcCall(method: string, params: unknown[], signal: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`RPC returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (body.error !== undefined) {
      throw new Error(`RPC error: ${JSON.stringify(body.error)}`);
    }

    return body.result;
  }

  private extractBaseFee(result: PromiseSettledResult<unknown>): string | null {
    if (result.status !== "fulfilled") {
      return null;
    }

    const block = result.value as Record<string, unknown> | null;
    if (block === null || typeof block !== "object") {
      return null;
    }

    const baseFee = block.baseFeePerGas;
    return typeof baseFee === "string" && baseFee.startsWith("0x") ? baseFee : null;
  }

  private extractPriorityFee(result: PromiseSettledResult<unknown>): bigint {
    if (result.status !== "fulfilled") {
      return DEFAULT_PRIORITY_FEE_WEI;
    }

    const value = result.value;
    if (typeof value !== "string" || !value.startsWith("0x")) {
      return DEFAULT_PRIORITY_FEE_WEI;
    }

    const parsed = BigInt(value);
    return parsed > MIN_PRIORITY_FEE_WEI ? parsed : MIN_PRIORITY_FEE_WEI;
  }
}

const toHex = (value: bigint): `0x${string}` => `0x${value.toString(16)}`;
