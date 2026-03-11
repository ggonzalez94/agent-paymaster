export type ChainName = "taikoMainnet" | "taikoHekla" | "taikoHoodi";

export interface RpcConfig {
  chain: ChainName;
  rpcUrl: string;
}

export interface ServiceHealth {
  service: string;
  status: "ok" | "degraded";
  timestamp: string;
}

export const buildHealth = (service: string): ServiceHealth => ({
  service,
  status: "ok",
  timestamp: new Date().toISOString(),
});
