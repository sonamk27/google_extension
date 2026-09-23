import { buildPrompt } from "./promptBuilder.js";

const MOCK_MODE = process.env.MOCK_MODE === "true";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-3-7-sonnet-20250219";

export const ACTION_TOOLS = [
  {
    name: "submit_action",
    description: "Submit the single next UI action to execute on the webpage to achieve the task.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["click", "scroll", "type", "none"],
          description: "The type of UI action to take"
        },
        targetId: {
          type: ["string", "null"],
          description: "The agentId of the target element (required for 'click' and 'type', null for 'scroll' or 'none')"
        },
        value: {
          type: ["string", "null"],
          description: "The text to type for 'type' action, or null if not applicable"
        },
        reasoning: {
          type: "string",
          description: "One short sentence explaining why this action was chosen"
        }
      },
      required: ["type", "targetId", "value", "reasoning"]
    }
  }
];

function mockAction({ domSummary, task, history = [] }) {
  // If we already performed actions in mock mode, simulate sequential progress or completion
  const interactedTargets = new Set(
    history.map((h) => h.action?.targetId).filter(Boolean)
  );

  const availableInteractive = (domSummary || []).filter(
    (e) => !e.sensitive && !interactedTargets.has(e.agentId)
  );

  // If there's an input field not yet filled, simulate typing
  const firstInput = availableInteractive.find((e) => ["input", "textarea"].includes(e.tag));
  if (firstInput && history.length === 0) {
    return {
      type: "type",
      targetId: firstInput.agentId,
      value: "demo@test.com",
      reasoning: `Mock mode: typing into input element #${firstInput.agentId} to satisfy task "${task}".`
    };
  }

  // If there's a button or link not yet clicked, simulate clicking
  const firstClickable = availableInteractive.find((e) => ["button", "a"].includes(e.tag));
  if (firstClickable) {
    return {
      type: "click",
      targetId: firstClickable.agentId,
      value: null,
      reasoning: `Mock mode: clicking element #${firstClickable.agentId} (${firstClickable.text || firstClickable.tag}) for task "${task}".`
    };
  }

  return {
    type: "none",
    targetId: null,
    value: null,
    reasoning: "Mock mode: all available interactive elements processed or task completed."
  };
}

export async function getAgentAction(context) {
  if (MOCK_MODE || !API_KEY) {
    return mockAction(context);
  }

  const prompt = buildPrompt(context);
  const content = [{ type: "text", text: prompt }];

  if (context.image) {
    const base64 = context.image.includes(",")
      ? context.image.split(",")[1]
      : context.image;
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
      max_tokens: 500,
      tools: ACTION_TOOLS,
      tool_choice: { type: "tool", name: "submit_action" },
      messages: [{ role: "user", content }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = await response.json();

  // Structured tool extraction
  const toolBlock = data.content?.find(
    (c) => c.type === "tool_use" && c.name === "submit_action"
  );

  if (toolBlock && toolBlock.input) {
    return toolBlock.input;
  }

  // Fallback in case model replied via text block
  const text = data.content?.find((c) => c.type === "text")?.text || "{}";
  const cleaned = text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      type: "none",
      targetId: null,
      value: null,
      reasoning: "Could not parse model response into structured action."
    };
  }
}
