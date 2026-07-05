let activeWarning = null;

const title = document.getElementById("warning-title");
const message = document.getElementById("warning-message");
const detail = document.getElementById("warning-detail");
const closeAppBtn = document.getElementById("close-app-btn");
const dismissBtn = document.getElementById("dismiss-btn");

function renderWarning(warning) {
  activeWarning = warning;

  title.textContent = warning.title || "Security Warning";
  message.textContent = warning.message || "Restricted activity was detected.";

  if (warning.detail) {
    detail.hidden = false;
    detail.textContent = warning.detail;
  } else {
    detail.hidden = true;
    detail.textContent = "";
  }

  closeAppBtn.hidden = !(warning.app && warning.app.pid);
}

window.api.onSecurityWarning(renderWarning);

closeAppBtn.addEventListener("click", async () => {
  if (!activeWarning || !activeWarning.app) return;
  closeAppBtn.disabled = true;
  closeAppBtn.textContent = "Closing...";
  await window.api.closeSecurityApp(activeWarning.app.pid);
  closeAppBtn.disabled = false;
  closeAppBtn.textContent = "Close App";
});

dismissBtn.addEventListener("click", () => {
  window.api.dismissSecurityWarning();
});
