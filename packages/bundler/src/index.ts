import { buildHealth } from "@agent-paymaster/shared";

export class BundlerService {
  getHealth() {
    return buildHealth("bundler");
  }
}

if (process.env.NODE_ENV !== "test") {
  const port = Number.parseInt(process.env.BUNDLER_PORT ?? "3001", 10);
  const service = new BundlerService();

  console.log(`Bundler service bootstrap on :${port}`);
  console.log(JSON.stringify(service.getHealth()));
}
