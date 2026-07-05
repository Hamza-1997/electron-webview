let interval = null;
let latestApps = [];
let baselinePids = new Set();
let warnedPids = new Set();
let warningActive = false;
let currentScreen = 1;

const list = document.getElementById("list");
const closeAllBtn = document.getElementById("close-all-btn");
const refreshBtn = document.getElementById("refresh-btn");
const continueBtn = document.getElementById("continue-btn");
const appCount = document.getElementById("app-count");

const warningOverlay = document.getElementById("warning-overlay");
const warningAppName = document.getElementById("warning-app-name");
const closeAutoBtn = document.getElementById("close-auto-btn");
const dismissBtn = document.getElementById("dismiss-btn");

const screenshotWarning = document.getElementById("screenshot-warning");
const screenshotDismissBtn = document.getElementById("screenshot-dismiss-btn");

function showScreen(id) {
  document.getElementById("screen-1").style.display = id === 1 ? "block" : "none";
  document.getElementById("screen-2").style.display = id === 2 ? "block" : "none";
  document.getElementById("screen-3").style.display = id === 3 ? "block" : "none";
  currentScreen = id;
}

showScreen(1);
setTimeout(() => {
  showScreen(2);
  scan(true);
}, 1000);

async function scan(showLoading) {
  try {
    if (currentScreen === 2 && showLoading) {
      list.style.display = "none";
      document.getElementById("loading").style.display = "block";
      appCount.textContent = "...";
    }

    const { apps = [], untrusted_apps_found = false } =
      (await window.api.scanApps()) || {};
    latestApps = apps;

    if (currentScreen === 2) {
      list.style.display = "";
      document.getElementById("loading").style.display = "none";
      list.innerHTML = "";
      appCount.textContent = String(apps.length);

      if (apps.length > 0) {
        apps.forEach((app) => {
          const row = document.createElement("div");
          row.className = "app-row";

          const name = document.createElement("div");
          name.className = "app-name";
          name.textContent = app.name || "Unknown App";

          const appPath = document.createElement("div");
          appPath.className = "app-path";
          appPath.textContent = app.path || "";

          row.appendChild(name);
          row.appendChild(appPath);
          list.appendChild(row);
        });
      }

      closeAllBtn.disabled = apps.length === 0;
      continueBtn.disabled = apps.length > 0;
    }

    if (currentScreen === 3) {
      if (!warningActive) {
        const newApps = apps.filter(
          (app) => !baselinePids.has(app.pid)
        );

        for (const app of newApps) {
          if (!warnedPids.has(app.pid)) {
            showSuspiciousAppAlert(app);
            break;
          }
        }
      }
    }
  } catch (error) {
    console.error("Scan failed:", error);
  }
  if (currentScreen === 2) {
    document.getElementById("loading").style.display = "none";
    list.style.display = "";
  }
}

async function closeAllApps() {
  if (!latestApps.length) return;

  try {
    closeAllBtn.disabled = true;
    closeAllBtn.textContent = "Closing...";
    await window.api.killApps(latestApps.map((app) => Number(app.pid)));
  } catch (error) {
    console.error("Close all failed:", error);
  } finally {
    closeAllBtn.textContent = "Close all listed apps";
    await scan();
  }
}

function showSuspiciousAppAlert(app) {
  warningActive = true;
  warningAppName.textContent = app.name || "Unknown App";
  warningOverlay.style.display = "flex";

  closeAutoBtn.onclick = async () => {
    await window.api.killApps([Number(app.pid)]);
    warnedPids.add(app.pid);
    warningActive = false;
    warningOverlay.style.display = "none";
  };

  dismissBtn.onclick = () => {
    warningActive = false;
    warningOverlay.style.display = "none";
  };
}

screenshotDismissBtn.addEventListener("click", () => {
  screenshotWarning.style.display = "none";
});

window.api.onScreenshotAttempt(() => {
  if (currentScreen === 3) {
    screenshotWarning.style.display = "flex";
  }
});

function startPolling() {
  if (interval) return;

  scan();
  interval = setInterval(scan, 5000);
}

continueBtn.addEventListener("click", () => {
  warnedPids = new Set();
  baselinePids = new Set(latestApps.map((a) => a.pid));
  showScreen(3);
  startPolling();
});

closeAllBtn.addEventListener("click", closeAllApps);
refreshBtn.addEventListener("click", () => scan(true));

document.getElementById("submit-btn").addEventListener("click", async () => {
  await window.api.submitAssessment();
});

window.api.onStartPolling(() => {
  startPolling();
});

window.api.isSessionActive().then((isActive) => {
  if (isActive) {
    startPolling();
  }
});
