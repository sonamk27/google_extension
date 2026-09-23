export function buildPrompt({ task, caption, domSummary, viewport }) {
  const elementList = (domSummary || [])
    .map(
      (e) =>
        `- id=${e.agentId} tag=${e.tag} role=${e.role || "-"} text="${e.text || ""}" bbox=(${e.bbox.x},${e.bbox.y},${e.bbox.w}x${e.bbox.h})${
          e.sensitive ? " [SENSITIVE-REDACTED]" : ""
        }`
    )
    .join("\n");

  return `You are a browser automation agent. You receive a SANITIZED view of a web page: a redacted screenshot (sensitive regions are blacked out) plus a structured list of interactive elements extracted from the DOM. Sensitive fields (passwords, card numbers, etc.) are marked [SENSITIVE-REDACTED] and their text content is intentionally hidden from you - never ask for it or try to infer it.

User's task: "${task}"

Local vision model caption of the screen: "${caption || "not available"}"

Viewport: ${viewport ? `${viewport.w}x${viewport.h}` : "unknown"}

Interactive elements on screen:
${elementList || "(none detected)"}

Decide the single next best UI action to accomplish the task. Respond with ONLY a JSON object, no prose, no markdown fences, in exactly this shape:
{"type": "click" | "scroll" | "type" | "none", "targetId": "<agentId or null>", "value": "<string or null>", "reasoning": "<one short sentence>"}

If the task is already complete or no safe action exists, use {"type": "none", "targetId": null, "value": null, "reasoning": "..."}.`;
}
