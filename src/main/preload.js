const { contextBridge, ipcRenderer } = require("electron");

function watchAssessmentCompletion() {
  const trigger = () => {
    ipcRenderer.invoke("submit-assessment");
  };

  const checkText = () => {
    if (document.body?.textContent?.includes("Assessment Completed")) {
      trigger();
      return true;
    }
    return false;
  };

  if (checkText()) return;

  const observer = new MutationObserver(() => {
    if (checkText()) observer.disconnect();
  });

  const start = () => {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}

watchAssessmentCompletion();

contextBridge.exposeInMainWorld("api", {
  scanApps: () => ipcRenderer.invoke("scan-apps"),
  killApps: (pids) => ipcRenderer.invoke("kill-apps", pids),
  isSessionActive: () => ipcRenderer.invoke("is-session-active"),
  onStartPolling: (cb) => ipcRenderer.on("start-polling", cb),
  onScreenshotAttempt: (cb) => ipcRenderer.on("screenshot-attempt", (e, data) => cb(data)),
  submitAssessment: () => ipcRenderer.invoke("submit-assessment"),
  onSecurityWarning: (cb) => ipcRenderer.on("security-warning", (e, data) => cb(data)),
  dismissSecurityWarning: () => ipcRenderer.invoke("dismiss-security-warning"),
  closeSecurityApp: (pid) => ipcRenderer.invoke("close-security-app", pid),
});
