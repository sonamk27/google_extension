import { Router } from "express";
import { getAgentAction } from "../services/vlmClient.js";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const { task, image, caption, domSummary, viewport } = req.body;
    if (!task) return res.status(400).json({ error: "task is required" });

    // Defensive check: reject any payload that still looks like it contains
    // an unredacted sensitive field. This is a server-side backstop, not the
    // primary defense (that lives client-side) - defense in depth.
    const leaked = (domSummary || []).find((e) => e.sensitive && e.text && e.text !== "[REDACTED]");
    if (leaked) {
      return res.status(400).json({
        error: "Rejected: payload contains an unredacted sensitive field. Client-side redaction must run first."
      });
    }

    const action = await getAgentAction({ task, image, caption, domSummary, viewport });
    res.json({ action });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

export default router;
