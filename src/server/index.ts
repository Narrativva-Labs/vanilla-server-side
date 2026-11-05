import { createApp } from "./app.js";
import { configFromEnv } from "./config.js";
const config = configFromEnv();
const app = createApp(config);
await app.listen({ host: config.host, port: config.port });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void app.close();
  });
console.log(`Tracker listening on port ${config.port}`);
