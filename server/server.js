import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config({ path: new URL(".env", import.meta.url) });

const { default: agentRouter } = await import("./routes/agent.js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/agent", agentRouter);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Visual privacy agent server listening on http://localhost:${PORT}`);
  console.log(
    process.env.MOCK_MODE === "true"
      ? "Mock mode: ON — no API key required, returns simulated actions."
      : "Mock mode: OFF — calling live VLM with ANTHROPIC_API_KEY."
  );
});
