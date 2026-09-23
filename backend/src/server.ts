import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { env } from "./env.js";

const { db, pool } = createDb(env.DATABASE_URL);
const app = await buildApp({ db, corsOrigin: env.CORS_ORIGIN });
app.addHook("onClose", async () => {
  await pool.end();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
