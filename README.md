# Visual Privacy Agent

On-device visual perception for a light-weight browser agent. A Chrome extension
reads the screen locally, redacts anything sensitive **before it ever leaves the
browser**, and only a sanitized summary is sent to a server-side VLM/LLM, which
returns a single UI action for the extension to execute.

Built for: *On-device Visual Perception for Light-weight Browser Agents* (SIH-style problem statement).

## Architecture

```
 User's screen
      |
      v
+-----------------------------------------------------+
|  Browser extension (Manifest V3)                     |
|                                                       |
|  content.js        -> walks the DOM, flags sensitive  |
|                        fields (password/card/etc),    |
|                        returns bounding boxes          |
|                                                       |
|  background.js     -> orchestrator (service worker)   |
|                        captures screenshot, calls      |
|                        offscreen doc, calls server      |
|                                                       |
|  offscreen.js       -> the ONLY place pixels are        |
|  (offscreen doc)       touched: blacks out sensitive    |
|                        regions on canvas, then runs a   |
|                        local vision model (Transformers |
|                        .js, WebGPU/WASM) on the         |
|                        ALREADY-REDACTED image           |
+-----------------------------------------------------+
      |  sanitized image + sanitized DOM summary only
      v
+-----------------------------------------------------+
|  Server (Node/Express)                                |
|                                                        |
|  routes/agent.js    -> rejects any payload that still  |
|                         contains unredacted sensitive   |
|                         text (defense in depth)         |
|  services/vlmClient -> sends sanitized context to a     |
|                         cloud VLM (or a mock, offline)  |
|                         and returns a strict JSON action|
+-----------------------------------------------------+
      |  {type, targetId, value, reasoning}
      v
 content.js executes the action (click / scroll / type)
 back in the page.
```

**Privacy guarantee in one sentence:** redaction happens on-device, on pixels and
on DOM text, before the first network request is ever made — the server never
receives an unredacted password field, card number, or other flagged PII.

## What's inside

```
extension/        Chrome extension (client) — Manifest V3
  manifest.json
  content.js       DOM walker + sensitive-field detector + action executor
  background.js    Orchestrator (service worker)
  offscreen.html/.js   Canvas redaction + local vision model (Transformers.js)
  popup.html/.js/.css  UI to trigger a task and see the sanitized preview + result

server/           Backend (Node + Express)
  server.js
  routes/agent.js       POST /api/agent — the only endpoint
  services/vlmClient.js Calls Anthropic API, or mock mode (no key needed)
  services/promptBuilder.js
  .env.example
```

## Run it

### 1. Backend

```bash
cd server
npm install
cp .env.example .env
npm start
```

By default `MOCK_MODE=true` in `.env.example`, so the server runs **with no API
key** and returns a deterministic simulated action — good for a first test of the
whole pipeline offline. You should see:

```
Visual privacy agent server listening on http://localhost:5000
Mock mode: ON — no API key required, returns simulated actions.
```

To use a real VLM instead: set `MOCK_MODE=false` and `ANTHROPIC_API_KEY=your_key`
in `.env`, then restart.

Quick manual check:
```bash
curl http://localhost:5000/health
```

### 2. Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder
4. Pin the extension, open any normal web page (not a `chrome://` page),
   click the extension icon
5. Type a task (e.g. *"Click the login button"*) and click **Capture & run**

The popup will show the local processing log, the redacted screenshot that was
actually sent to the server, and the JSON action the server returned.

**First run note:** if you tick "Local caption," the first click downloads the
model's *weights* (~200MB of numeric data, not code) from Hugging Face and
caches them in the browser. That first run can take 10–30s; subsequent runs
are fast. It's **off by default** so your first end-to-end test is fast and
reliable — turn it on once the base pipeline (DOM extraction → redaction →
server round trip → action) is working for you.

## Evaluation criteria mapping

| Criterion | Where it's addressed |
|---|---|
| Accuracy of visual context | `content.js` DOM walk (exact, bbox-aligned) + optional local caption from Transformers.js |
| Recall/precision of PII detection | `isSensitiveField()` in `content.js` — type/autocomplete/name/keyword based |
| Precision of redaction | `offscreen.js` — hard black-box redaction on exact DOM-derived bounding boxes, done before any model or network call touches the image |
| Client-side resource use | Local work is DOM query + canvas draw (cheap); the only heavy step (captioning) is optional and toggleable |
| End-to-end latency | Orchestration in `background.js` logs each stage; mock mode isolates client-side latency from network/VLM latency for measurement |

## Known limitations / next steps (be upfront about these with judges)

- **Face blurring** is not wired in yet — the redaction pipeline already accepts
  arbitrary bounding boxes, so a face-detection model (e.g. MediaPipe Face
  Detector, WASM) can be dropped into `offscreen.js` and its boxes merged with
  `sensitiveBoxes` with no other changes needed.
- **PII detection is currently DOM/heuristic-based**, not full NER — the
  cleanest next addition is a quantized NER model (ONNX Runtime Web) run in the
  offscreen document over any OCR'd or DOM text, for freeform PII (names,
  addresses) that regex/keyword matching misses.
- The extension only captures the **visible viewport** (`captureVisibleTab`),
  not the full scrollable page. Full-page capture requires `chrome.debugger` +
  CDP (`Page.captureScreenshot` with `captureBeyondViewport`) or scroll-and-stitch.
- CSP in `manifest.json` allows `connect-src` to `huggingface.co` so the
  bundled Transformers.js library (vendored locally under
  `extension/lib/transformers/`, never loaded from a CDN — Manifest V3
  disallows remote code) can fetch model *weights* at runtime. Only the
  non-threaded WASM backend is bundled (no `SharedArrayBuffer`/cross-origin
  isolation required), which is what extension pages support reliably.
  For a fully offline/air-gapped demo, pre-download the model weights once
  on a networked machine (they get cached by the browser) before the demo.
