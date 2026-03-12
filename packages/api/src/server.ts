import { serve } from "@hono/node-server";

import { createApp, validateConfig } from "./index.js";
import { PersistenceStore } from "./persistence.js";

validateConfig();

const persistence = new PersistenceStore();
const app = createApp({ persistence });
const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);

serve({
  fetch: app.fetch,
  port,
});

console.log(`API listening on :${port}`);
