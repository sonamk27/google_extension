// offscreen.js
// This is the ONLY place image pixels are touched. It runs in an extension-owned
// document (not the web page, not the service worker) so it has both DOM/canvas
// access and its own isolated CSP.
//
// Two jobs:
//   1. Redact sensitive bounding boxes (from the DOM scan) directly on the pixels,
//      before anything else ever sees the image.
//   2. Optionally run a small local vision-language model (Transformers.js, WebGPU
//      when available, WASM fallback) on the ALREADY-REDACTED image to produce a
//      short caption describing the screen. This never sees the original pixels.
//
// If the local model fails to load (offline, blocked CDN, slow machine), we fail
// soft: redaction still happens, we just skip the caption.

let captionerPromise = null;

async function getCaptioner() {
  if (!captionerPromise) {
    captionerPromise = (async () => {
      // Loaded from inside the extension package - no remote code execution,
      // which Manifest V3 requires. Only the model's numeric weights (not
      // code) are fetched from Hugging Face at runtime, over connect-src,
      // which MV3 does allow.
      const { pipeline, env } = await import(
        chrome.runtime.getURL("lib/transformers/transformers.min.js")
      );
      env.allowLocalModels = false;
      // Force the non-threaded WASM backend: extension pages aren't
      // cross-origin-isolated, so SharedArrayBuffer (needed for threaded
      // WASM) usually isn't available here. Also point at our bundled
      // .wasm files instead of the library's own CDN default.
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("lib/transformers/");

      // Small, browser-friendly captioning model. Swap for an even smaller
      // model (e.g. a distilled ViT classifier) if you need lower latency.
      return pipeline("image-to-text", "Xenova/vit-gpt2-image-captioning");
    })();
  }
  return captionerPromise;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode screenshot image"));
    img.src = dataUrl;
  });
}

async function redactImage(screenshotDataUrl, boxes, cssViewport) {
  // Deliberately not using fetch() here: fetching a data: URL is subject to
  // the extension's connect-src CSP, which doesn't (and shouldn't need to)
  // allow the data: scheme. Loading it as an <img> instead sidesteps that
  // entirely and is the standard way to get a data URL onto a canvas.
  const img = await loadImage(screenshotDataUrl);

  const canvas = document.getElementById("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  // The screenshot is captured at actual device pixel resolution, but DOM
  // bounding boxes are measured in CSS pixels. On any display where
  // devicePixelRatio or OS-level scaling isn't exactly 1 (125%/150% is the
  // Windows default on many laptops), those two don't match 1:1 - without
  // correcting for it, redaction boxes land in the wrong place and the
  // sensitive content stays visible right next to a black box that missed it.
  const scaleX = cssViewport?.w ? img.naturalWidth / cssViewport.w : 1;
  const scaleY = cssViewport?.h ? img.naturalHeight / cssViewport.h : 1;
  console.log(`[offscreen] redaction scale factors: x=${scaleX.toFixed(3)} y=${scaleY.toFixed(3)}`);

  // Hard redaction: solid black rectangles over every DOM-flagged sensitive field.
  // This is deliberately crude and deliberately irreversible - no blur-and-guess.
  // A small margin is added on every side to absorb any residual rounding error
  // between the two coordinate systems, so we over-redact slightly rather than
  // risk a sliver of sensitive content peeking out at the edge.
  const margin = 3;
  ctx.fillStyle = "#000000";
  for (const box of boxes || []) {
    ctx.fillRect(
      box.x * scaleX - margin,
      box.y * scaleY - margin,
      box.w * scaleX + margin * 2,
      box.h * scaleY + margin * 2
    );
  }

  return canvas.toDataURL("image/jpeg", 0.7);
}

console.log("[offscreen] document loaded, listener attached");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING_OFFSCREEN") {
    sendResponse({ ready: true });
    return true;
  }

  if (msg.type !== "PROCESS_IMAGE") return false;

  console.log("[offscreen] received PROCESS_IMAGE");
  (async () => {
    try {
      const { screenshotDataUrl, sensitiveBoxes, cssViewport, enableCaption } = msg.payload;
      console.log("[offscreen] redacting image, boxes:", sensitiveBoxes?.length || 0);
      const redactedImageDataUrl = await redactImage(screenshotDataUrl, sensitiveBoxes, cssViewport);
      console.log("[offscreen] redaction complete");

      let caption = "";
      if (enableCaption) {
        try {
          console.log("[offscreen] loading local caption model...");
          const model = await getCaptioner();
          const output = await model(redactedImageDataUrl);
          caption = output?.[0]?.generated_text || "";
          console.log("[offscreen] caption:", caption);
        } catch (err) {
          console.warn("[offscreen] local vision model unavailable, continuing without caption:", err);
        }
      }

      sendResponse({ redactedImageDataUrl, caption });
    } catch (err) {
      // Without this, a thrown error here would silently kill the async
      // function and sendResponse would never be called - which looks
      // exactly like a hang to whoever is waiting on the other end.
      console.error("[offscreen] PROCESS_IMAGE failed:", err);
      sendResponse({ error: String(err.message || err) });
    }
  })();

  return true; // keep the message channel open for the async response
});
