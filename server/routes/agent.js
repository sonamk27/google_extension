import { Router } from "express";
import { getAgentAction } from "../services/vlmClient.js";

const router = Router();

// Middleware: Authenticate requests using shared secret header
export function authenticateExtension(req, res, next) {
  const expectedSecret = process.env.EXTENSION_SHARED_SECRET;
  if (expectedSecret) {
    const providedToken = req.headers["x-extension-token"];
    if (!providedToken || providedToken !== expectedSecret) {
      return res.status(401).json({
        error: "Unauthorized: Missing or invalid x-extension-token header."
      });
    }
  }
  next();
}

// Middleware: Validate input payload shapes and boundary limits
export function validatePayload(req, res, next) {
  const { task, image, domSummary, history } = req.body;

  // Task validation
  if (!task || typeof task !== "string" || task.trim().length === 0) {
    return res.status(400).json({ error: "Validation failed: 'task' is required and must be a non-empty string." });
  }
  if (task.length > 1000) {
    return res.status(400).json({ error: "Validation failed: 'task' exceeds maximum length of 1000 characters." });
  }

  // DOM Summary validation
  if (domSummary !== undefined) {
    if (!Array.isArray(domSummary)) {
      return res.status(400).json({ error: "Validation failed: 'domSummary' must be an array." });
    }
    if (domSummary.length > 300) {
      return res.status(400).json({ error: "Validation failed: 'domSummary' exceeds maximum size of 300 elements." });
    }
  }

  // Screenshot image validation
  if (image !== undefined && image !== null) {
    if (typeof image !== "string") {
      return res.status(400).json({ error: "Validation failed: 'image' must be a base64 string." });
    }
    // Cap at approx 12MB base64 string length
    if (image.length > 12 * 1024 * 1024) {
      return res.status(400).json({ error: "Validation failed: 'image' payload exceeds 12MB limit." });
    }
  }

  // History validation
  if (history !== undefined && !Array.isArray(history)) {
    return res.status(400).json({ error: "Validation failed: 'history' must be an array." });
  }

  next();
}

// Middleware: Defense-in-depth leak detector backstop
export function checkSensitiveLeaks(req, res, next) {
  const { domSummary } = req.body;
  const leaked = (domSummary || []).find(
    (e) => e.sensitive && e.text && e.text !== "[REDACTED]"
  );

  if (leaked) {
    return res.status(400).json({
      error: "Rejected: payload contains an unredacted sensitive field. Client-side redaction must run first."
    });
  }

  next();
}

router.post("/", authenticateExtension, validatePayload, checkSensitiveLeaks, async (req, res) => {
  try {
    const { task, image, caption, domSummary, viewport, history } = req.body;
    const action = await getAgentAction({ task, image, caption, domSummary, viewport, history });
    res.json({ action });
  } catch (err) {
    console.error("[agent router] error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

export default router;
