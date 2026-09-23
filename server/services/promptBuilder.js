// server/services/promptBuilder.js
// Constructs structured prompt context including sanitized DOM, screen caption, and multi-step action history.

export function buildPrompt({ task, caption, domSummary, viewport, history = [] }) {
  const elementList = (domSummary || [])
    .map(
      (e) =>
        `- id=${e.agentId} tag=${e.tag} role=${e.role || "-"} text="${e.text || ""}" bbox=(${e.bbox.x},${e.bbox.y},${e.bbox.w}x${e.bbox.h})${
          e.sensitive ? " [SENSITIVE-REDACTED]" : ""
        }`
    )
    .join("\n");

  const historySummary =
    history && history.length > 0
      ? history
          .map(
            (h, i) =>
              `- Step ${i + 1}: ${h.action?.type || "unknown"} (targetId: ${h.action?.targetId || "none"}) -> status: ${
                h.execResult ? (h.execResult.ok ? "succeeded" : "failed") : "done"
              }`
          )
          .join("\n")
      : "(no previous steps in this session)";

  return `You are a browser automation agent. You receive a SANITIZED view of a web page: a redacted screenshot (sensitive regions, PII, and faces are blacked out) plus a structured list of interactive elements extracted from the DOM. Sensitive fields (passwords, card numbers, personal identifiers) are marked [SENSITIVE-REDACTED] and their text content is intentionally obscured for user privacy.

User Task: "${task}"

Local Vision Caption: "${caption || "not available"}"
Viewport Dimensions: ${viewport ? `${viewport.w}x${viewport.h}` : "unknown"}

History of previous actions in this task:
${historySummary}

Interactive elements currently visible on screen:
${elementList || "(none detected)"}

Use the submit_action tool to choose the single next best action to advance or complete the user's task. If the goal is satisfied or no safe action remains, submit an action with type "none".`;
}
