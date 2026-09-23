// background.js (MV3 service worker)
// Orchestrator only. Owns no pixels directly - delegates image work to the
// offscreen document, and DOM work to the content script.

const DEFAULT_SERVER_URL = "http://localhost:5000";
const DEFAULT_SECRET = "dev-secret-key-visual-privacy-agent-2026";

async function getSettings() {
  const { serverUrl, enableCaption, extensionSecret } = await chrome.storage.local.get([
    "serverUrl",
    "enableCaption",
    "extensionSecret"
  ]);
  return {
    serverUrl: serverUrl || DEFAULT_SERVER_URL,
    enableCaption: enableCaption === true,
    extensionSecret: extensionSecret || DEFAULT_SECRET
  };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for: ${label}`)), ms)
    )
  ]);
}

async function pingOffscreenUntilReady(maxAttempts, intervalMs) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const pong = await withTimeout(
        chrome.runtime.sendMessage({ type: "PING_OFFSCREEN" }),
        300,
        "offscreen ping"
      );
      if (pong?.ready) {
        console.log(`[background] offscreen document responded after ${attempt + 1} ping(s)`);
        return true;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function ensureOffscreenDocument() {
  const alreadyExisted = await chrome.offscreen.hasDocument();

  if (!alreadyExisted) {
    console.log("[background] creating offscreen document...");
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER", "BLOBS"],
      justification: "Run local vision model and canvas-based redaction outside the service worker"
    });
  }

  const ready = await pingOffscreenUntilReady(15, 100);
  if (ready) return;

  if (alreadyExisted) {
    console.warn("[background] existing offscreen document is unresponsive, recreating it...");
    try {
      await chrome.offscreen.closeDocument();
    } catch (err) {
      console.warn("[background] closeDocument failed:", err.message);
    }
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER", "BLOBS"],
      justification: "Run local vision model and canvas-based redaction outside the service worker"
    });
    const readyAfterRecreate = await pingOffscreenUntilReady(15, 100);
    if (readyAfterRecreate) return;
  }

  throw new Error("Offscreen document never became ready.");
}

async function fetchWithRetry(url, options, maxRetries = 1, backoffMs = 1000) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeout || 20000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        console.warn(`[background] fetch attempt ${attempt + 1} failed, retrying in ${backoffMs}ms:`, err.message);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr;
}

// Single observation, redaction, inference, and execution cycle
async function observeAndDecide(task, history = [], stepIndex = 0, emit = console.log) {
  const t0 = performance.now();
  const timings = {};

  const { serverUrl, enableCaption, extensionSecret } = await getSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");

  // 1. Screenshot Capture
  emit(`[Step ${stepIndex + 1}] Capturing visible tab (raw pixels stay local)...`);
  const tCaptureStart = performance.now();
  let screenshotDataUrl = null;
  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 70
    });
  } catch (winErr) {
    console.warn("[background] captureVisibleTab with windowId failed, retrying with null windowId:", winErr.message);
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "jpeg",
      quality: 70
    });
  }

  if (!screenshotDataUrl || typeof screenshotDataUrl !== "string" || !screenshotDataUrl.startsWith("data:image/")) {
    throw new Error("Could not capture visible tab screenshot. Make sure the tab is open and visible.");
  }
  timings.captureMs = Math.round(performance.now() - tCaptureStart);

  // 2. DOM Extraction
  emit(`[Step ${stepIndex + 1}] Extracting DOM structure and flagging sensitive fields...`);
  const tDomStart = performance.now();
  let domResult;
  try {
    domResult = await withTimeout(
      chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_DOM" }),
      3000,
      "content script response"
    );
  } catch {
    emit("Injecting content script...");
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    domResult = await withTimeout(
      chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_DOM" }),
      3000,
      "content script response (after injection)"
    );
  }
  timings.domScanMs = Math.round(performance.now() - tDomStart);

  emit(`Found ${domResult.elements.length} elements (${domResult.sensitiveBoxes.length} DOM sensitive).`);

  await ensureOffscreenDocument();

  // 3. Plain-text NER pass for PII detection in non-sensitive elements
  const tNerStart = performance.now();
  const candidateElements = domResult.elements.filter(
    (e) => !e.sensitive && e.text && e.text.trim().length >= 3
  );

  let sensitiveBoxes = [...domResult.sensitiveBoxes];

  if (candidateElements.length > 0) {
    emit(`Running on-device NER model over ${candidateElements.length} text elements...`);
    try {
      const nerRes = await withTimeout(
        chrome.runtime.sendMessage({
          type: "RUN_NER",
          elements: candidateElements.map((e) => ({
            agentId: e.agentId,
            text: e.text
          }))
        }),
        15000,
        "NER entity recognition"
      );

      if (nerRes?.sensitiveAgentIds && nerRes.sensitiveAgentIds.length > 0) {
        emit(`NER flagged ${nerRes.sensitiveAgentIds.length} text element(s) as sensitive.`);
        for (const el of domResult.elements) {
          if (nerRes.sensitiveAgentIds.includes(el.agentId)) {
            el.sensitive = true;
            sensitiveBoxes.push(el.bbox);
          }
        }
      }
    } catch (nerErr) {
      console.warn("[background] NER processing skipped or timed out:", nerErr.message);
    }
  }
  timings.nerMs = Math.round(performance.now() - tNerStart);

  // 4. Local Redaction & Face Detection in offscreen document
  emit(`Applying on-device redaction and face detection (${sensitiveBoxes.length} sensitive boxes)...`);
  const tRedactStart = performance.now();
  const processed = await withTimeout(
    chrome.runtime.sendMessage({
      type: "PROCESS_IMAGE",
      payload: {
        screenshotDataUrl,
        sensitiveBoxes,
        cssViewport: { w: domResult.viewport.w, h: domResult.viewport.h },
        enableCaption
      }
    }),
    enableCaption ? 60000 : 15000,
    "offscreen image processing"
  );
  timings.redactionMs = Math.round(performance.now() - tRedactStart);

  if (processed?.error) {
    throw new Error(`Local redaction failed: ${processed.error}`);
  }

  // Sanitize DOM summary
  const sanitizedDom = domResult.elements.map((e) => ({
    agentId: e.agentId,
    tag: e.tag,
    role: e.role,
    text: e.sensitive ? "[REDACTED]" : e.text,
    bbox: e.bbox,
    sensitive: e.sensitive
  }));

  // 5. Server Communication with Shared Secret
  emit(`Sending sanitized payload to ${serverUrl}...`);
  const tServerStart = performance.now();
  let response;
  try {
    response = await fetchWithRetry(
      `${serverUrl}/api/agent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-extension-token": extensionSecret
        },
        body: JSON.stringify({
          task,
          image: processed.redactedImageDataUrl,
          caption: processed.caption || "",
          domSummary: sanitizedDom,
          viewport: domResult.viewport,
          history
        }),
        timeout: 25000
      },
      1,
      1000
    );
  } catch (err) {
    throw new Error(
      `Could not reach server at ${serverUrl}. Ensure the server is running. (${err.message})`
    );
  }

  timings.serverLatencyMs = Math.round(performance.now() - tServerStart);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Server responded ${response.status}: ${errText}`);
  }

  const result = await response.json();
  emit(`Agent action: ${result.action?.type || "none"} (${result.action?.reasoning || "no reasoning"})`);

  // 6. Action Execution on Page
  const tExecStart = performance.now();
  let execResult = null;
  if (result.action && result.action.type !== "none") {
    execResult = await chrome.tabs.sendMessage(tab.id, {
      type: "EXECUTE_ACTION",
      action: result.action
    });
    emit(execResult.ok ? "Action executed successfully." : `Action error: ${execResult.error}`);
  }
  timings.executionMs = Math.round(performance.now() - tExecStart);
  timings.totalMs = Math.round(performance.now() - t0);

  return {
    action: result.action,
    execResult,
    redactedImagePreview: processed.redactedImageDataUrl,
    caption: processed.caption,
    timings
  };
}

// Multi-step agent loop
async function runAgentLoop(task, maxSteps = 6, onStepUpdate = null) {
  const log = [];
  const emit = (msg) => {
    log.push(msg);
    console.log("[background]", msg);
    if (onStepUpdate) {
      onStepUpdate({ type: "LOG", message: msg });
    }
  };

  const history = [];
  let lastPreview = null;

  for (let step = 0; step < maxSteps; step++) {
    emit(`--- Starting Step ${step + 1} of max ${maxSteps} ---`);
    const stepData = await observeAndDecide(task, history, step, emit);
    lastPreview = stepData.redactedImagePreview;

    history.push({
      step: step + 1,
      action: stepData.action,
      execResult: stepData.execResult,
      timings: stepData.timings
    });

    if (onStepUpdate) {
      onStepUpdate({
        type: "STEP_COMPLETE",
        step: step + 1,
        stepData,
        history
      });
    }

    // Stop if model indicates completion or action execution failed fatally
    if (stepData.action?.type === "none") {
      emit("Task finished: Agent returned action type 'none'.");
      break;
    }

    if (stepData.execResult && !stepData.execResult.ok) {
      emit(`Stopping loop: action execution failed (${stepData.execResult.error}).`);
      break;
    }

    // Short pause between interactions to allow page mutations/animations to settle
    await new Promise((r) => setTimeout(r, 600));
  }

  return {
    log,
    history,
    redactedImagePreview: lastPreview,
    totalSteps: history.length
  };
}

async function runAgentTask(task) {
  const log = [];
  const emit = (msg) => {
    log.push(msg);
    console.log("[background]", msg);
  };
  const stepData = await observeAndDecide(task, [], 0, emit);
  return {
    log,
    result: { action: stepData.action },
    redactedImagePreview: stepData.redactedImagePreview,
    timings: stepData.timings
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "RUN_AGENT_TASK") {
    runAgentTask(msg.task)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: String(err.message || err) }));
    return true;
  }

  if (msg.type === "RUN_AGENT_LOOP") {
    runAgentLoop(msg.task, msg.maxSteps || 6)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: String(err.message || err) }));
    return true;
  }

  return false;
});
