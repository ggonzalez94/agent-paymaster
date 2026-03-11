import { serve } from "@hono/node-server";

import { createApp } from "./index.js";

const app = createApp();
const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);

serve({
  fetch: app.fetch,
  port,
});

console.log(`API listening on :${port}`);
