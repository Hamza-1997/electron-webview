const { contextBridge, ipcRenderer } = require("electron");

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
