const taskEl = document.getElementById("task");
const runBtn = document.getElementById("runBtn");
const agentBadge = document.getElementById("agentBadge");
const statusAlert = document.getElementById("statusAlert");
const traceContainer = document.getElementById("traceContainer");
const serverUrlEl = document.getElementById("serverUrl");
const extensionSecretEl = document.getElementById("extensionSecret");
const enableCaptionEl = document.getElementById("enableCaption");
const enableLoopEl = document.getElementById("enableLoop");
const maxStepsEl = document.getElementById("maxSteps");
const configToggle = document.getElementById("configToggle");
const configBody = document.getElementById("configBody");
const configArrow = document.getElementById("configArrow");

// Quick Chips
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    taskEl.value = chip.getAttribute("data-task");
    taskEl.focus();
  });
});

// Config toggle
configToggle.addEventListener("click", () => {
  const isHidden = configBody.style.display === "none";
  configBody.style.display = isHidden ? "flex" : "none";
  configArrow.textContent = isHidden ? "▴" : "▾";
});

async function loadSettings() {
  const settings = await chrome.storage.local.get([
    "serverUrl",
    "extensionSecret",
    "enableCaption",
    "enableLoop",
    "maxSteps"
  ]);
  serverUrlEl.value = settings.serverUrl || "http://localhost:5000";
  extensionSecretEl.value = settings.extensionSecret || "dev-secret-key-visual-privacy-agent-2026";
  enableCaptionEl.checked = settings.enableCaption === true;
  enableLoopEl.checked = settings.enableLoop !== false;
  maxStepsEl.value = settings.maxSteps || 6;
}

async function saveSettings() {
  await chrome.storage.local.set({
    serverUrl: serverUrlEl.value.trim() || "http://localhost:5000",
    extensionSecret: extensionSecretEl.value.trim() || "dev-secret-key-visual-privacy-agent-2026",
    enableCaption: enableCaptionEl.checked,
    enableLoop: enableLoopEl.checked,
    maxSteps: parseInt(maxStepsEl.value, 10) || 6
  });
}

serverUrlEl.addEventListener("change", saveSettings);
extensionSecretEl.addEventListener("change", saveSettings);
enableCaptionEl.addEventListener("change", saveSettings);
enableLoopEl.addEventListener("change", saveSettings);
maxStepsEl.addEventListener("change", saveSettings);

function setBadge(state, text) {
  agentBadge.className = `badge badge-${state}`;
  agentBadge.textContent = text;
}

function renderStepCard(stepNum, action, execResult, timings, previewUrl) {
  const card = document.createElement("div");
  card.className = "step-card";

  const actionType = action?.type || "none";
  const tagClass = `tag-${actionType.toLowerCase()}`;

  let timingHtml = "";
  if (timings) {
    timingHtml = `
      <div class="step-timings">
        <span class="timing-chip">Total: ${timings.totalMs || 0}ms</span>
        <span class="timing-chip">DOM: ${timings.domScanMs || 0}ms</span>
        ${timings.nerMs ? `<span class="timing-chip">NER: ${timings.nerMs}ms</span>` : ""}
        <span class="timing-chip">Redact: ${timings.redactionMs || 0}ms</span>
        <span class="timing-chip">Server: ${timings.serverLatencyMs || 0}ms</span>
      </div>
    `;
  }

  let previewHtml = "";
  if (previewUrl) {
    previewHtml = `
      <details style="margin-top: 6px;">
        <summary style="font-size: 10px; color: #64748b; cursor: pointer;">View Redacted Screenshot</summary>
        <img class="step-preview" src="${previewUrl}" alt="Step ${stepNum} Redacted View" />
      </details>
    `;
  }

  const targetInfo = action?.targetId ? ` -> <code>${action.targetId}</code>` : "";
  const valueInfo = action?.value ? ` ("${action.value}")` : "";

  card.innerHTML = `
    <div class="step-header">
      <span class="step-number">Step ${stepNum}</span>
      <span class="step-action-tag ${tagClass}">${actionType}</span>
    </div>
    <div class="step-reasoning">
      <strong>Action:</strong> ${actionType}${targetInfo}${valueInfo}<br/>
      <strong>Reasoning:</strong> ${action?.reasoning || "None provided"}
      ${execResult ? `<br/><strong>Exec:</strong> ${execResult.ok ? "Success" : `Failed (${execResult.error})`}` : ""}
    </div>
    ${timingHtml}
    ${previewHtml}
  `;

  return card;
}

runBtn.addEventListener("click", async () => {
  await saveSettings();
  const task = taskEl.value.trim() || "Analyze the current screen and identify key interactive actions";
  const isLoop = enableLoopEl.checked;
  const maxSteps = parseInt(maxStepsEl.value, 10) || 6;

  setBadge("running", "RUNNING");
  statusAlert.style.display = "none";
  traceContainer.innerHTML = "";
  runBtn.disabled = true;

  const msgType = isLoop ? "RUN_AGENT_LOOP" : "RUN_AGENT_TASK";
  const payload = isLoop ? { type: msgType, task, maxSteps } : { type: msgType, task };

  chrome.runtime.sendMessage(payload, (response) => {
    runBtn.disabled = false;

    if (chrome.runtime.lastError) {
      setBadge("error", "ERROR");
      statusAlert.textContent = chrome.runtime.lastError.message;
      statusAlert.style.display = "block";
      return;
    }

    if (response?.error) {
      setBadge("error", "ERROR");
      statusAlert.textContent = response.error;
      statusAlert.style.display = "block";
      return;
    }

    setBadge("success", "COMPLETE");

    if (isLoop && Array.isArray(response.history)) {
      if (response.history.length === 0) {
        traceContainer.innerHTML = '<div class="empty-trace">No actions were required.</div>';
      } else {
        response.history.forEach((h, idx) => {
          const preview = idx === response.history.length - 1 ? response.redactedImagePreview : null;
          traceContainer.appendChild(
            renderStepCard(h.step || idx + 1, h.action, h.execResult, h.timings, preview)
          );
        });
      }
    } else if (response.result) {
      traceContainer.appendChild(
        renderStepCard(1, response.result.action, null, response.timings, response.redactedImagePreview)
      );
    }
  });
});

loadSettings();
