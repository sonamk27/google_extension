import { buildPrompt } from "./promptBuilder.js";

const MOCK_MODE = process.env.MOCK_MODE === "true";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

function mockAction({ domSummary, task }) {
  const firstClickable = (domSummary || []).find(
    (e) => ["a", "button"].includes(e.tag) && !e.sensitive
  );
  if (firstClickable) {
    return {
      type: "click",
      targetId: firstClickable.agentId,
      value: null,
      reasoning: `Mock mode: no live VLM configured, picking the first non-sensitive clickable element as a stand-in action for "${task}".`
    };
  }
  return {
    type: "none",
    targetId: null,
    value: null,
    reasoning: "Mock mode: no suitable non-sensitive element found on screen."
  };
}

export async function getAgentAction(context) {
  if (MOCK_MODE || !API_KEY) {
    return mockAction(context);
  }

  const prompt = buildPrompt(context);
  const content = [{ type: "text", text: prompt }];

  if (context.image) {
    const base64 = context.image.split(",")[1];
    content.unshift({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: base64 }
    });
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data.content?.find((c) => c.type === "text")?.text || "{}";
  const cleaned = text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return { type: "none", targetId: null, value: null, reasoning: "Could not parse model response as JSON." };
  }
}
