import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config({ path: new URL(".env", import.meta.url) });

const { default: agentRouter } = await import("./routes/agent.js");

const app = express();

// Configurable CORS protection: allows chrome-extension origins and configured domains
const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigin === "*" ||
        origin === allowedOrigin ||
        origin.startsWith("chrome-extension://")
      ) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked for origin: ${origin}`));
      }
    }
  })
);

// Optional rate limiting middleware
let apiLimiter = (_req, _res, next) => next();
try {
  const { default: rateLimit } = await import("express-rate-limit");
  apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 150,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Rate limit exceeded. Please try again after 15 minutes." }
  });
} catch {
  console.warn(
    "[server] express-rate-limit not installed in server/node_modules yet. Run 'npm install' in server/ to enable rate limiting."
  );
}

app.use(express.json({ limit: "15mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => res.json({}));
app.use("/api/agent", apiLimiter, agentRouter);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Visual privacy agent server listening on http://localhost:${PORT}`);
  console.log(
    process.env.MOCK_MODE === "true"
      ? "Mock mode: ON — no API key required, returns simulated actions."
      : `Mock mode: OFF — calling live VLM with model ${process.env.ANTHROPIC_MODEL || "claude-3-7-sonnet-20250219"}.`
  );
});

export default app;
