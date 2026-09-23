// background.js (MV3 service worker)
// Orchestrator only. Owns no pixels directly - delegates image work to the
// offscreen document, and DOM work to the content script.

const DEFAULT_SERVER_URL = "http://localhost:5000";

async function getSettings() {
  const { serverUrl, enableCaption } = await chrome.storage.local.get([
    "serverUrl",
    "enableCaption"
  ]);
  return {
    serverUrl: serverUrl || DEFAULT_SERVER_URL,
    enableCaption: enableCaption === true // default false
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
    } catch (err) {
      // no listener yet, or timed out - just retry
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
  } else {
    console.log("[background] offscreen document already exists, verifying it still responds...");
  }

  // Whether it's brand new or pre-existing, don't trust it until it answers a
  // ping. A pre-existing document can be a "zombie" left over from an earlier
  // run (e.g. it errored out) - sending it real work would just hang forever.
  const ready = await pingOffscreenUntilReady(15, 100);
  if (ready) return;

  if (alreadyExisted) {
    console.warn("[background] existing offscreen document is unresponsive, recreating it...");
    try {
      await chrome.offscreen.closeDocument();
    } catch (err) {
      console.warn("[background] closeDocument failed (continuing anyway):", err.message);
    }
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER", "BLOBS"],
      justification: "Run local vision model and canvas-based redaction outside the service worker"
    });
    const readyAfterRecreate = await pingOffscreenUntilReady(15, 100);
    if (readyAfterRecreate) return;
  }

  throw new Error(
    "Offscreen document never became ready. Open chrome://extensions, find this extension, and check " +
      "for an 'offscreen document' inspect link with errors in it."
  );
}

async function runAgentTask(task) {
  const log = [];
  const emit = (msg) => {
    log.push(msg);
    console.log("[background]", msg);
  };

  const { serverUrl, enableCaption } = await getSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");

  emit("Capturing visible tab (pixels never leave the browser unredacted)...");
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(null, {
    format: "jpeg",
    quality: 70
  });

  emit("Extracting DOM structure + flagging sensitive fields...");
  let domResult;
  try {
    domResult = await withTimeout(
      chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_DOM" }),
      3000,
      "content script response"
    );
  } catch (err) {
    emit("Content script not found on this tab yet - injecting it now...");
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
    } catch (injectErr) {
      throw new Error(
        `Could not inject the content script into this tab (${injectErr.message}). ` +
          `This page may be a restricted Chrome page (chrome://, the Web Store, or a local PDF) ` +
          `where extensions can't run. Try a normal website like https://wikipedia.org.`
      );
    }
    // give the freshly-injected script a moment to register its listener
    domResult = await withTimeout(
      chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_DOM" }),
      3000,
      "content script response (after injection)"
    ).catch((err2) => {
      throw new Error(
        "Injected the content script but it still didn't respond. Reload the web page tab manually " +
          "(F5) and try again. Original error: " + err2.message
      );
    });
  }
  emit(
    `Found ${domResult.elements.length} interactive elements, ${domResult.sensitiveBoxes.length} flagged sensitive.`
  );

  emit("Preparing local redaction environment (offscreen document)...");
  await ensureOffscreenDocument();

  emit(
    enableCaption
      ? "Redacting sensitive regions locally, then running local vision model (first run downloads the model, can take 10-30s)..."
      : "Redacting sensitive regions locally..."
  );
  const processed = await withTimeout(
    chrome.runtime.sendMessage({
      type: "PROCESS_IMAGE",
      payload: {
        screenshotDataUrl,
        sensitiveBoxes: domResult.sensitiveBoxes,
        cssViewport: { w: domResult.viewport.w, h: domResult.viewport.h },
        enableCaption
      }
    }),
    enableCaption ? 60000 : 12000,
    "offscreen image processing"
  );

  if (processed?.error) {
    throw new Error(`Local redaction/vision step failed: ${processed.error}`);
  }

  if (processed?.caption) {
    emit(`Local caption: "${processed.caption}"`);
  }

  // Sanitize the DOM summary too: sensitive fields carry no text, only geometry + type.
  const sanitizedDom = domResult.elements.map((e) => ({
    agentId: e.agentId,
    tag: e.tag,
    role: e.role,
    text: e.sensitive ? "[REDACTED]" : e.text,
    bbox: e.bbox,
    sensitive: e.sensitive
  }));

  emit(`Sending sanitized context to ${serverUrl} ...`);
  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    response = await fetch(`${serverUrl}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        image: processed.redactedImageDataUrl,
        caption: processed.caption,
        domSummary: sanitizedDom,
        viewport: domResult.viewport
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch (err) {
    throw new Error(
      `Could not reach the server at ${serverUrl}. Is "npm start" still running in your terminal? ` +
        `Original error: ${err.message}`
    );
  }

  if (!response.ok) {
    throw new Error(`Server responded ${response.status}: ${await response.text()}`);
  }
  const result = await response.json();
  emit(`Server decided action: ${result.action?.type || "none"} — ${result.action?.reasoning || ""}`);

  let execResult = null;
  if (result.action && result.action.type !== "none") {
    execResult = await chrome.tabs.sendMessage(tab.id, {
      type: "EXECUTE_ACTION",
      action: result.action
    });
    emit(execResult.ok ? "Action executed on the page." : `Action failed: ${execResult.error}`);
  }

  return { log, result, redactedImagePreview: processed.redactedImageDataUrl };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "RUN_AGENT_TASK") {
    runAgentTask(msg.task)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: String(err.message || err) }));
    return true; // async response
  }
  return false;
});
