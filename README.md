# Visual Privacy Agent

On-device visual perception and privacy enforcement for a light-weight browser agent. A Chrome extension
reads the screen locally, redacts anything sensitive (passwords, payment cards, names/places via on-device NER, and faces) **before it ever leaves the browser**, and sends only a sanitized summary to a server-side VLM/LLM, which returns structured UI actions for the extension to execute in a multi-step loop.

Built for: *On-device Visual Perception for Light-weight Browser Agents* (SIH problem statement).

---

## Architecture & Privacy Pipeline

```
  User's Screen
       │
       ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Browser Extension (Manifest V3)                                       │
│                                                                        │
│  content.js        ──► Walks DOM, identifies sensitive form inputs     │
│                        (passwords, credit cards, SSN, OTP, emails)     │
│                                                                        │
│  background.js     ──► Orchestrator & Multi-Step Agent Loop            │
│                        Captures visible tab, dispatches NER & vision,  │
│                        measures latency timings, executes UI actions   │
│                                                                        │
│  offscreen.js      ──► THE ONLY PLACE RAW PIXELS ARE ACCESSED          │
│    (Isolated Doc)      1. Detects faces on raw canvas                  │
│                        2. Runs on-device NER (Xenova/bert-base-NER)    │
│                           on plain-text DOM elements                   │
│                        3. Blacks out sensitive regions & faces         │
│                        4. Optionally captions redacted screen          │
│                           (vit-gpt2, WebGPU / WASM fallback)           │
└────────────────────────────────────────────────────────────────────────┘
       │  Sanitized JPEG + Sanitized DOM Summary + x-extension-token
       ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Hardened Server (Node / Express)                                      │
│                                                                        │
│  routes/agent.js   ──► Shared-secret authentication (401 check)        │
│                        Rate limiting (150 req/15m)                     │
│                        Input schema & size boundary validation         │
│                        Defense-in-depth leak detector (rejects leaks)  │
│                                                                        │
│  services/vlmClient──► Structured output via Claude Tool Use           │
│                        (submit_action tool schema) or multi-step mock  │
└────────────────────────────────────────────────────────────────────────┘
       │  Structured UI Action: { type, targetId, value, reasoning }
       ▼
  content.js executes action on page (click / scroll / type with React support)
```

---

## Key Features

1. **On-Device Plain-Text NER**: Uses `Xenova/bert-base-NER` via Transformers.js in an isolated offscreen document to catch personal names (`PER`), locations (`LOC`), and organizations (`ORG`) embedded in plain text, not just input form fields.
2. **On-Device Face Redaction**: Detects human faces on the raw screenshot canvas using on-device detectors before image export, blacking them out irreversibly.
3. **Server-Side Security Hardening**:
   - **Shared-Secret Header**: `x-extension-token` verification rejects unauthorized access with 401.
   - **Rate Limiting**: Built-in rate limiting middleware protects backend VLM resources.
   - **Payload Validation**: Strict length caps on task text, image size, and DOM elements.
   - **Defense-in-Depth Leak Guard**: Rejects any request containing unredacted sensitive values with status 400.
4. **Extension Robustness & Framework Support**:
   - Native property descriptor setter for React/Vue/Angular controlled inputs.
   - Automatic fetch retry with exponential backoff on transient network failures.
5. **Multi-Step Autonomous Agent Loop**:
   - Configurable autonomous loop (`runAgentLoop`) that iteratively executes actions until task completion.
   - Maintains action history passed to prompt builder to prevent repetitive loops.
6. **Structured Output via Claude Tool Use**:
   - Enforces action schema with `submit_action` tool definition (`type`, `targetId`, `value`, `reasoning`).
7. **End-to-End Latency Instrumentation**:
   - Detailed timing breakdown per step (Capture, DOM Scan, NER, Redaction, Server Latency, Execution).
8. **Automated Test Suite**:
   - Unit tests for PII rules, DPR coordinate scaling math, server authentication, leak detection, and mock actions.

---

## Directory Structure

```
extension/
  manifest.json
  content.js             # DOM walker, sensitive attribute scanner, synthetic input setter
  background.js          # Service worker orchestrator & multi-step agent loop
  offscreen.html/.js     # Canvas redaction, on-device NER, and face detector
  lib/
    privacyRules.js      # Pure PII pattern matching functions
    redactionMath.js     # DPI/DPR scaling and margin calculation functions
    mediapipe/
      faceDetector.js    # Canvas face detection with native Shape Detection & fallback
    transformers/        # Vendored Transformers.js library and WASM binaries
  popup.html/.js/.css    # Modern UI with step-by-step trace viewer and timing chips

server/
  server.js              # Express server with rate limiter & CORS control
  routes/agent.js        # POST /api/agent with token auth, validation, leak guard
  services/
    vlmClient.js         # Claude Tool Use client & multi-step mock mode
    promptBuilder.js     # Context prompt generator with action history
  tests/
    server.test.js       # Server integration and middleware tests
  .env.example           # Configuration template

tests/
  extension-rules.test.js# Pure function tests (privacy detection & redaction math)
```

---

## Quick Start

### 1. Server Setup

```powershell
cd server
npm install
npm start
```

Runs with `MOCK_MODE=true` by default (no API key required). To use a live Claude model:
1. In `server/.env`, set `MOCK_MODE=false`.
2. Add your `ANTHROPIC_API_KEY=sk-ant-...`.
3. Model is set to `claude-3-7-sonnet-20250219`.

### 2. Extension Installation

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** in the top right.
3. Click **Load unpacked** and select the `extension/` directory.
4. Pin the extension icon.

### 3. Run Automated Tests

Run the full automated test suite from the repository root:

```powershell
npm test
```

This verifies:
- PII regular expressions (email, credit card, keywords).
- Viewport scaling math across various DPR display settings.
- Server token authentication (401 check).
- Sensitive field leak detector (400 check).
- Payload schema validation.
- VLM tool use action structure.
