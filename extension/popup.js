const taskEl = document.getElementById("task");
const runBtn = document.getElementById("runBtn");
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");
const previewEl = document.getElementById("preview");
const serverUrlEl = document.getElementById("serverUrl");
const enableCaptionEl = document.getElementById("enableCaption");

async function loadSettings() {
  const { serverUrl, enableCaption } = await chrome.storage.local.get([
    "serverUrl",
    "enableCaption"
  ]);
  serverUrlEl.value = serverUrl || "http://localhost:5000";
  enableCaptionEl.checked = enableCaption === true;
}

async function saveSettings() {
  await chrome.storage.local.set({
    serverUrl: serverUrlEl.value.trim() || "http://localhost:5000",
    enableCaption: enableCaptionEl.checked
  });
}

serverUrlEl.addEventListener("change", saveSettings);
enableCaptionEl.addEventListener("change", saveSettings);

runBtn.addEventListener("click", async () => {
  await saveSettings();
  const task = taskEl.value.trim() || "Describe what is currently on this screen";

  statusEl.textContent = "Running...";
  outputEl.textContent = "";
  previewEl.style.display = "none";
  runBtn.disabled = true;

  chrome.runtime.sendMessage({ type: "RUN_AGENT_TASK", task }, (response) => {
    runBtn.disabled = false;

    if (chrome.runtime.lastError) {
      statusEl.textContent = "Error: " + chrome.runtime.lastError.message;
      return;
    }
    if (response.error) {
      statusEl.textContent = "Error: " + response.error;
      return;
    }

    statusEl.textContent = response.log.join("\n");
    outputEl.textContent = JSON.stringify(response.result, null, 2);

    if (response.redactedImagePreview) {
      previewEl.src = response.redactedImagePreview;
      previewEl.style.display = "block";
    }
  });
});

loadSettings();
