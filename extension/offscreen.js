// offscreen.js
// This is the ONLY place image pixels are touched. It runs in an extension-owned
// document (not the web page, not the service worker) so it has both DOM/canvas
// access and its own isolated CSP.
//
// Responsibilities:
//   1. Redact sensitive bounding boxes (DOM scan + plain-text NER) directly on the pixels.
//   2. Detect faces on unredacted raw canvas (using on-device face detector) and black them out.
//   3. Run plain-text NER (Xenova/bert-base-NER) via Transformers.js for PER/LOC/ORG entities.
//   4. Optionally run vision captioner (Xenova/vit-gpt2-image-captioning with WebGPU / WASM fallback)
//      on the ALREADY-REDACTED image. Raw pixels never leave this document.

import { detectFacesOnCanvas } from "./lib/mediapipe/faceDetector.js";
import { computeScaleFactors, transformBoxToCanvas } from "./lib/redactionMath.js";

let captionerPromise = null;
let nerPromise = null;

async function setupTransformersEnv() {
  const { env } = await import(
    chrome.runtime.getURL("lib/transformers/transformers.min.js")
  );
  env.allowLocalModels = false;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("lib/transformers/");
  return env;
}

async function getCaptioner() {
  if (!captionerPromise) {
    captionerPromise = (async () => {
      await setupTransformersEnv();
      const { pipeline } = await import(
        chrome.runtime.getURL("lib/transformers/transformers.min.js")
      );

      // Attempt WebGPU acceleration first for minimal latency, with soft fallback to WASM
      try {
        console.log("[offscreen] attempting to initialize captioner with WebGPU...");
        return await pipeline("image-to-text", "Xenova/vit-gpt2-image-captioning", {
          device: "webgpu"
        });
      } catch (gpuErr) {
        console.warn("[offscreen] WebGPU initialization failed, falling back to WASM:", gpuErr.message);
        return await pipeline("image-to-text", "Xenova/vit-gpt2-image-captioning");
      }
    })();
  }
  return captionerPromise;
}

export async function getNerModel() {
  if (!nerPromise) {
    nerPromise = (async () => {
      await setupTransformersEnv();
      const { pipeline } = await import(
        chrome.runtime.getURL("lib/transformers/transformers.min.js")
      );
      console.log("[offscreen] loading Xenova/bert-base-NER pipeline...");
      return await pipeline("token-classification", "Xenova/bert-base-NER");
    })();
  }
  return nerPromise;
}

async function loadImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    throw new Error("Invalid or empty screenshot data URL");
  }

  // 1. Try HTML Image element with modern async decode()
  try {
    const img = new Image();
    img.src = dataUrl;
    if (typeof img.decode === "function") {
      await img.decode();
      return img;
    }
    await new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(new Error("Image element onload failed"));
    });
    return img;
  } catch (imgErr) {
    console.warn("[offscreen] Image() decode failed, attempting fetch + createImageBitmap fallback:", imgErr.message);
  }

  // 2. Reliable fallback: fetch data URL as blob and decode to ImageBitmap
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return await createImageBitmap(blob);
  } catch (err) {
    console.error("[offscreen] all image decoding attempts failed:", err);
    throw new Error(`Failed to decode screenshot image (${err.message})`);
  }
}

async function redactImage(screenshotDataUrl, boxes, cssViewport) {
  const img = await loadImage(screenshotDataUrl);
  const naturalWidth = img.naturalWidth || img.width;
  const naturalHeight = img.naturalHeight || img.height;

  const canvas = document.getElementById("canvas");
  canvas.width = naturalWidth;
  canvas.height = naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  // 1. On-device face detection on raw canvas pixels before any redaction
  let faceBoxes = [];
  try {
    faceBoxes = await detectFacesOnCanvas(canvas);
    if (faceBoxes.length > 0) {
      console.log(`[offscreen] detected ${faceBoxes.length} face(s) for visual redaction`);
    }
  } catch (err) {
    console.warn("[offscreen] face detection error (proceeding with DOM redaction):", err);
  }

  // 2. Compute DPR / CSS viewport scale factors
  const { scaleX, scaleY } = computeScaleFactors(naturalWidth, naturalHeight, cssViewport);
  console.log(`[offscreen] redaction scale factors: x=${scaleX.toFixed(3)} y=${scaleY.toFixed(3)}`);

  const margin = 3;
  ctx.fillStyle = "#000000";

  // 3. Black out DOM sensitive boxes
  for (const box of boxes || []) {
    const transformed = transformBoxToCanvas(box, scaleX, scaleY, margin);
    if (transformed) {
      ctx.fillRect(transformed.x, transformed.y, transformed.w, transformed.h);
    }
  }

  // 4. Black out detected face boxes (already in canvas pixel coordinates)
  for (const face of faceBoxes) {
    ctx.fillRect(
      Math.max(0, face.x - margin),
      Math.max(0, face.y - margin),
      face.w + margin * 2,
      face.h + margin * 2
    );
  }

  return canvas.toDataURL("image/jpeg", 0.7);
}

// Run NER over candidate element texts
async function runNerOnElements(elements) {
  if (!elements || !Array.isArray(elements) || elements.length === 0) {
    return { sensitiveAgentIds: [] };
  }

  const ner = await getNerModel();
  const sensitiveAgentIds = [];
  const TARGET_ENTITIES = ["PER", "LOC", "ORG"];
  const CONFIDENCE_THRESHOLD = 0.80;

  for (const el of elements) {
    if (!el.text || typeof el.text !== "string" || el.text.trim().length < 3) {
      continue;
    }

    try {
      const results = await ner(el.text);
      if (Array.isArray(results)) {
        const hasSensitiveEntity = results.some((item) => {
          if (!item || !item.entity) return false;
          const entityType = item.entity.replace(/^[BI]-/, "").toUpperCase();
          const score = typeof item.score === "number" ? item.score : 0;
          return TARGET_ENTITIES.includes(entityType) && score >= CONFIDENCE_THRESHOLD;
        });

        if (hasSensitiveEntity) {
          console.log(`[offscreen] NER detected sensitive entity in text for ${el.agentId}: "${el.text}"`);
          sensitiveAgentIds.push(el.agentId);
        }
      }
    } catch (err) {
      console.warn(`[offscreen] NER inference failed on text "${el.text}":`, err.message);
    }
  }

  return { sensitiveAgentIds };
}

console.log("[offscreen] document loaded, listeners attached");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "PING_OFFSCREEN") {
    sendResponse({ ready: true });
    return true;
  }

  if (msg.type === "RUN_NER") {
    console.log("[offscreen] received RUN_NER request, items:", msg.elements?.length || 0);
    (async () => {
      try {
        const result = await runNerOnElements(msg.elements);
        sendResponse(result);
      } catch (err) {
        console.error("[offscreen] RUN_NER failed:", err);
        sendResponse({ error: String(err.message || err), sensitiveAgentIds: [] });
      }
    })();
    return true;
  }

  if (msg.type === "PROCESS_IMAGE") {
    console.log("[offscreen] received PROCESS_IMAGE");
    (async () => {
      try {
        const { screenshotDataUrl, sensitiveBoxes, cssViewport, enableCaption } = msg.payload;
        console.log("[offscreen] redacting image, DOM boxes:", sensitiveBoxes?.length || 0);
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
        console.error("[offscreen] PROCESS_IMAGE failed:", err);
        sendResponse({ error: String(err.message || err) });
      }
    })();

    return true; // keep message channel open
  }

  return false;
});
