/**
 * Route Optimization service — Farmhouse (Saha Group) ideation prototype.
 *
 * Serves the REST API and the dashboard (static files in /public).
 */

import express from "express";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import apiRouter from "./routes/api.js";
import { assertConnectivity, initSchema } from "./db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
// Static handler serves everything in /public, including the driver view
// (public/driver.html, added in task 14) — no extra wiring is needed for it.
app.use(express.static(PUBLIC_DIR));

app.use("/api", apiRouter);

// Central error handler.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

/**
 * Start listening, falling back to the next port if one is already in use.
 * This avoids a hard crash (EADDRINUSE) when port 3000 is taken by another
 * process. Set PORT to force a specific port and disable the fallback.
 */
function startServer(port, attemptsLeft = 10) {
  const server = app.listen(port, () => {
    console.log(`Route Optimization service running at http://localhost:${port}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0 && !process.env.PORT) {
      console.warn(`Port ${port} is in use, trying ${port + 1}...`);
      startServer(port + 1, attemptsLeft - 1);
    } else if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${port} is already in use. Set a free port with e.g. PORT=4000 npm start`
      );
      process.exit(1);
    } else {
      throw err;
    }
  });
}

/**
 * Boot-time database bootstrap: verify Postgres is reachable (failing loudly and
 * exiting non-zero when it is not — see pool.assertConnectivity) and apply the
 * idempotent schema. This runs ONLY when the server is started directly (see the
 * main-module guard below), so importing this module for tests never forces a DB
 * connection or a process exit, and the pure test suite runs without Postgres.
 */
async function bootstrapDatabase() {
  await assertConnectivity(); // exits the process with a clear message if unreachable
  await initSchema(); // CREATE ... IF NOT EXISTS — safe to run on every boot
}

// Only bootstrap the DB and start listening when this file is run directly
// (`node src/server.js`), not when it is imported (e.g. by integration tests
// that mount `app` themselves).
const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  bootstrapDatabase()
    .then(() => startServer(Number(PORT)))
    .catch((err) => {
      console.error("[startup] database bootstrap failed:", err.message || err);
      process.exit(1);
    });
}

export default app;
