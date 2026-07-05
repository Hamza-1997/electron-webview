const { app, BrowserWindow, ipcMain, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const log = require("electron-log");
const { exec } = require("child_process");
const fetch = global.fetch || require("node-fetch");

const BASE_URL = "http://localhost:8080/v1/assessments/application_session/";
const WEB_APP_URL = process.env.TESTFUSE_WEB_APP_URL || "http://localhost:3000/dashboard/assessments/6a4acdd59359266079b0f013";
const INITIAL_TARGET_URL = process.env.TESTFUSE_TARGET_URL || null;
const INITIAL_CONNECTION_TOKEN =
  process.env.TESTFUSE_CONNECTION_TOKEN ||
  "1f5af107fcb4982d47013f36548e04d806ec77a3c76c54f231d2d159c5550815";
const INITIAL_ASSESSMENT_ID =
  process.env.TESTFUSE_ASSESSMENT_ID || "6a4acdd59359266079b0f013";
const ALLOWED_ORIGINS = new Set(
  [new URL(WEB_APP_URL).origin]
    .concat((process.env.TESTFUSE_ALLOWED_ORIGINS || "").split(","))
    .map((origin) => origin.trim())
    .filter(Boolean)
);

log.transports.file.level = "info";
log.transports.console.level = "info";

let mainWindow;
let overlayWindow;
let heartbeatInterval = null;
let securityScanInterval = null;
let currentSession = getInitialSession();
allowUrlOrigin(currentSession?.targetUrl);
let isQuitting = false;
let shouldStartPolling = false;
let screenshotWatchers = [];
let screenshotPollingInterval = null;
let recentScreenshotFiles = new Set();
let lastScreenshotWarningAt = 0;
let warnedPids = new Set();

const SCREENSHOT_WARNING_COOLDOWN_MS = 1500;
const SCREENSHOT_SCAN_INTERVAL_MS = 2000;
const SCREENSHOT_FILE_WINDOW_MS = 10000;
const SECURITY_SCAN_INTERVAL_MS = 5000;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    kiosk: true,
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    movable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  applySecureBrowserPolicy();
  attachNavigationGuards();
  attachShortcutGuards();

  // This tells Linux to prevent the screen from sleeping or activating screen savers
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  // mainWindow = new BrowserWindow({show: false});
  // mainWindow.maximize();
  // mainWindow.show();
  mainWindow.loadURL(buildAssessmentUrl());
  // mainWindow.setIgnoreMouseEvents(true)
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 520,
    height: 300,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true);
  overlayWindow.setMenuBarVisibility(false);
  overlayWindow.loadFile(path.join(__dirname, "..", "renderer", "secure-overlay.html"));

  overlayWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      safeHideWindow(overlayWindow);
    }
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

function isUsableWindow(window) {
  return window && !window.isDestroyed();
}

function safeFocusWindow(window) {
  if (isUsableWindow(window)) window.focus();
}

function safeHideWindow(window) {
  if (isUsableWindow(window)) window.hide();
}

function applySecureBrowserPolicy() {
  if (!isUsableWindow(mainWindow)) return;

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true);
  mainWindow.setSkipTaskbar(true);
  mainWindow.setMovable(false);
  mainWindow.setResizable(false);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setKiosk(true);

  mainWindow.on("blur", () => {
    if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;

    setTimeout(() => {
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(true, "screen-saver");
        mainWindow.setKiosk(true);
      }
    }, 100);
  });

  mainWindow.on("minimize", (event) => {
    event.preventDefault();
    if (!isUsableWindow(mainWindow)) return;

    mainWindow.restore();
    mainWindow.setAlwaysOnTop(true, "screen-saver");
    mainWindow.setKiosk(true);
  });
}

function attachNavigationGuards() {
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) {
      return { action: "allow" };
    }

    showSecurityWarning({
      type: "navigation",
      title: "Navigation Blocked",
      message: "External pages are blocked while the secure assessment browser is active.",
      detail: url,
    });

    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAllowedUrl(url)) return;

    event.preventDefault();
    showSecurityWarning({
      type: "navigation",
      title: "Navigation Blocked",
      message: "External pages are blocked while the secure assessment browser is active.",
      detail: url,
    });
  });
}

function attachShortcutGuards() {
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const key = String(input.key || "").toLowerCase();
    const ctrlOrMeta = input.control || input.meta;
    const blocked =
      input.key === "F5" ||
      input.key === "F11" ||
      input.key === "F12" ||
      input.alt ||
      (ctrlOrMeta && ["l", "n", "o", "p", "r", "t", "w"].includes(key)) ||
      (ctrlOrMeta && input.shift && ["i", "j", "c"].includes(key));

    if (!blocked) return;

    event.preventDefault();
    showSecurityWarning({
      type: "shortcut",
      title: "Restricted Shortcut",
      message: "Browser and system shortcuts are disabled during the secure assessment.",
      detail: input.key,
    });
  });
}

function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    return ALLOWED_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

function buildAssessmentUrl() {
  const url = new URL(currentSession?.targetUrl || WEB_APP_URL);

  if (currentSession) {
    url.searchParams.set("token", currentSession.token);
    url.searchParams.set("assessment_id", currentSession.assessId);
    if (currentSession.accessToken) {
      url.searchParams.set("access_token", currentSession.accessToken);
    }
    if (currentSession.refreshToken) {
      url.searchParams.set("refresh_token", currentSession.refreshToken);
    }
  }

  url.searchParams.set("desktop_mode", "secure_browser");
  return url.toString();
}

function getInitialSession() {
  if (!INITIAL_CONNECTION_TOKEN || !INITIAL_ASSESSMENT_ID) return null;

  return {
    token: INITIAL_CONNECTION_TOKEN,
    assessId: INITIAL_ASSESSMENT_ID,
    targetUrl: INITIAL_TARGET_URL,
  };
}

function allowUrlOrigin(url) {
  if (!url) return;

  try {
    ALLOWED_ORIGINS.add(new URL(url).origin);
  } catch (error) {
    log.warn(`Invalid allowed URL origin: ${url}`, error);
  }
}

function showSecurityWarning({ type, title, message, detail, app = null }) {
  if (!isUsableWindow(overlayWindow)) return;

  const payload = { type, title, message, detail, app };

  const sendWarning = () => {
    if (!isUsableWindow(overlayWindow)) return;

    overlayWindow.webContents.send("security-warning", payload);
    overlayWindow.show();
    overlayWindow.focus();
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
  };

  if (overlayWindow.webContents.isLoading()) {
    overlayWindow.webContents.once("did-finish-load", sendWarning);
    return;
  }

  sendWarning();
}

// ============================================================================
// ADDED FOR LOCAL DEVELOPMENT DEEP LINKING
// ============================================================================
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("testfuse", process.execPath, [
      "--", 
      path.resolve(process.argv[1])
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("testfuse");
}
// ============================================================================

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (event, argv) => {
    const url = extractDeepLink(argv);
    if (url) handleDeepLink(url);
    safeFocusWindow(mainWindow);
  });

  app.whenReady().then(() => {
    createWindow();
    createOverlayWindow();
    startScreenshotDetection();
    startSecurityMonitoring();
    registerDemoExitShortcut();

    const url = extractDeepLink(process.argv);
    if (url) {
      handleDeepLink(url);
    } else if (currentSession) {
      patchConnection(true);
      startHeartbeat();
      shouldStartPolling = true;
    }
  });
}

function notifyScreenshotAttempt(source, filePath = null) {
  const now = Date.now();
  if (now - lastScreenshotWarningAt < SCREENSHOT_WARNING_COOLDOWN_MS) return;

  lastScreenshotWarningAt = now;
  log.warn("Screenshot attempt detected", { source, filePath });

  if (!isUsableWindow(mainWindow)) return;

  mainWindow.webContents.send("screenshot-attempt", {
    source,
    filePath,
    detectedAt: new Date(now).toISOString(),
  });

  showSecurityWarning({
    type: "screenshot",
    title: "Screenshot Detected",
    message: "Screenshot activity was detected. Screenshots are not permitted during this assessment.",
    detail: source,
  });
}

function registerDemoExitShortcut() {
  const registered = globalShortcut.register("CommandOrControl+Shift+Q", () => {
    app.quit();
  });

  if (!registered) {
    log.warn("Could not register demo exit shortcut: CommandOrControl+Shift+Q");
  }
}

function startSecurityMonitoring() {
  if (securityScanInterval) clearInterval(securityScanInterval);

  scanForSecurityWarnings();
  securityScanInterval = setInterval(
    scanForSecurityWarnings,
    SECURITY_SCAN_INTERVAL_MS
  );
}

async function scanForSecurityWarnings() {
  try {
    const apps = await scanAppsFromShell();
    const app = apps.find((candidate) => !warnedPids.has(candidate.pid));

    if (!app) return;

    warnedPids.add(app.pid);
    showSecurityWarning({
      type: "application",
      title: "Suspicious Application Detected",
      message: "This application is not permitted during a secure assessment.",
      detail: app.path,
      app,
    });
  } catch (error) {
    log.warn("Security scan failed", error);
  }
}

function stopSecurityMonitoring() {
  if (securityScanInterval) {
    clearInterval(securityScanInterval);
    securityScanInterval = null;
  }
}

function startScreenshotDetection() {
  registerScreenshotShortcuts();
  startScreenshotPolling();
}

function registerScreenshotShortcuts() {
  const screenshotShortcuts = [
    "PrintScreen",
    "Alt+PrintScreen",
    "CommandOrControl+PrintScreen",
    "Shift+PrintScreen",
    "CommandOrControl+Shift+PrintScreen",
  ];

  for (const shortcut of screenshotShortcuts) {
    const registered = globalShortcut.register(shortcut, () => {
      notifyScreenshotAttempt("keyboard-shortcut");
    });

    if (!registered) {
      log.warn(`Could not register screenshot shortcut: ${shortcut}`);
    }
  }
}

function getScreenshotDirectories() {
  const home = os.homedir();

  return [
    path.join(home, "Pictures"),
    path.join(home, "Pictures", "Screenshots"),
    path.join(home, "Desktop"),
    path.join(home, "Downloads"),
  ].filter((dir, index, dirs) => dirs.indexOf(dir) === index && fs.existsSync(dir));
}

function isLikelyScreenshotFile(fileName) {
  return (
    /\.(png|jpe?g|webp)$/i.test(fileName) &&
    /screenshot|screen shot|captura|bildschirmfoto|capture|snap/i.test(fileName)
  );
}

function detectRecentScreenshotFiles() {
  const now = Date.now();

  for (const dir of getScreenshotDirectories()) {
    let entries = [];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      log.warn(`Could not scan screenshot directory: ${dir}`, error);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !isLikelyScreenshotFile(entry.name)) continue;

      const filePath = path.join(dir, entry.name);

      try {
        const stats = fs.statSync(filePath);
        const isRecent = now - stats.mtimeMs <= SCREENSHOT_FILE_WINDOW_MS;

        if (isRecent && !recentScreenshotFiles.has(filePath)) {
          recentScreenshotFiles.add(filePath);
          notifyScreenshotAttempt("screenshot-file", filePath);
        }
      } catch (error) {
        log.warn(`Could not inspect screenshot file: ${filePath}`, error);
      }
    }
  }
}

function startScreenshotPolling() {
  detectRecentScreenshotFiles();

  for (const dir of getScreenshotDirectories()) {
    try {
      const watcher = fs.watch(dir, (_eventType, fileName) => {
        if (fileName && isLikelyScreenshotFile(fileName.toString())) {
          const filePath = path.join(dir, fileName.toString());
          recentScreenshotFiles.add(filePath);
          notifyScreenshotAttempt("screenshot-file", filePath);
        }
      });

      screenshotWatchers.push(watcher);
    } catch (error) {
      log.warn(`Could not watch screenshot directory: ${dir}`, error);
    }
  }

  screenshotPollingInterval = setInterval(
    detectRecentScreenshotFiles,
    SCREENSHOT_SCAN_INTERVAL_MS
  );
}

function stopScreenshotPolling() {
  for (const watcher of screenshotWatchers) {
    watcher.close();
  }

  screenshotWatchers = [];

  if (screenshotPollingInterval) {
    clearInterval(screenshotPollingInterval);
    screenshotPollingInterval = null;
  }
}

function extractDeepLink(argv) {
  return argv.find((arg) => arg.includes("testfuse://"));
}

function parseDeepLink(url) {
  try {
    const parsed = new URL(url);
    return {
      token: parsed.searchParams.get("token"),
      assessId: parsed.searchParams.get("assessment_id"),
      targetUrl:
        parsed.searchParams.get("target_url") ||
        parsed.searchParams.get("assessment_url") ||
        parsed.searchParams.get("redirect_url"),
      accessToken: parsed.searchParams.get("access_token"),
      refreshToken: parsed.searchParams.get("refresh_token"),
    };
  } catch {
    return { token: null, assessId: null, targetUrl: null, accessToken: null, refreshToken: null };
  }
}

async function handleDeepLink(url) {
  const { token, assessId, targetUrl, accessToken, refreshToken } = parseDeepLink(url);
  if (!token || !assessId) return;

  currentSession = { token, assessId, targetUrl, accessToken, refreshToken };
  allowUrlOrigin(targetUrl);

  await patchConnection(true);
  startHeartbeat();
  shouldStartPolling = true;

  notifyRendererToStartPolling();

  if (isUsableWindow(mainWindow)) {
    mainWindow.loadURL(buildAssessmentUrl());
  }
}

function notifyRendererToStartPolling() {
  if (!isUsableWindow(mainWindow)) return;

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once("did-finish-load", () => {
      if (shouldStartPolling && isUsableWindow(mainWindow)) {
        mainWindow.webContents.send("start-polling");
      }
    });
    return;
  }

  if (shouldStartPolling && isUsableWindow(mainWindow)) {
    mainWindow.webContents.send("start-polling");
  }
}

async function patchConnection(isInitial = false, isDisconnect = false) {
  if (!currentSession) return;

  const untrustedAppsFound = isDisconnect
    ? false
    : (await scanAppsFromShell()).length > 0;

  const payload = {
    assess_id: currentSession.assessId,
    connection_token: currentSession.token,
    app_connected: !isDisconnect,
    untrusted_apps_found: untrustedAppsFound,
  };

  await fetch(BASE_URL, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  heartbeatInterval = setInterval(() => {
    patchConnection(false, false);
  }, 3000);
}

function scanAppsFromShell() {
  return new Promise((resolve, reject) => {
    // We get the PID of the current Electron process to make sure it doesn't flag itself
    const currentPid = process.pid;

    const cmd = `
CURRENT_ELECTRON_PID="${currentPid}"

for pid in /proc/[0-9]*; do
  p=\${pid##*/}

  # 1. Skip if it's the current running Electron app or its children
  if [ "$p" = "$CURRENT_ELECTRON_PID" ]; then continue; fi
  ppid=$(awk '/PPid:/ {print $2}' /proc/$p/status 2>/dev/null)
  if [ "$ppid" = "$CURRENT_ELECTRON_PID" ]; then continue; fi

  path=$(readlink /proc/$p/exe 2>/dev/null)
  [ -z "$path" ] && continue
  name=$(cat /proc/$p/comm 2>/dev/null)

  # ============================================================================
  # SYSTEM CRITICAL WHITELIST (DO NOT TOUCH - OS will crash/logout if killed)
  # ============================================================================
  # Essential Core Linux Folders
  echo "$path" | grep -qE "^(/usr/lib|/lib|/lib64|/usr/libexec|/usr/share)" && continue
  
  # Core Shell Utilities & Standard Desktop Apps (safe to whitelist all of /usr/bin
  # and /usr/local/bin — suspicious apps like Discord/Slack/VSCode install to /opt, /snap, or home)
  echo "$path" | grep -qE "^(/usr/bin|/usr/local/bin)" && continue
  
  # Core OS Desktop Environment, Windows Managers, Display Servers, & Audio Drivers
  echo "$path" | grep -qiE "pipewire|pulseaudio|dbus|gnome|Xorg|xwayland|ibus|gjs|snapd|systemd|cosmic" && continue
  echo "$name" | grep -qiE "^(pop-shell|pop-launcher|pop-os|pop|cosmic|gdm|kcompactd|khugepaged|ksoftirqd|migration)" && continue

  # ============================================================================
  # DEV ENVIRONMENT WHITELIST (Only needed for your local machine testing)
  # ============================================================================
  # Ignore IDEs, local Node processes, Docker engines, and active workspaces
  echo "$path" | grep -qE "/\\.vscode/|/node$|/nodejs/|/npm$|/npx$|/python|/docker$|/docker-compose|[/.]nvm/" && continue
  echo "$path" | grep -qiE "(sternguard|testfuse-electron|testfuse|pyrefly|opencode)" && continue

  # ============================================================================
  # WEB BROWSER WHITELIST (Candidate needs these to take the exam)
  # ============================================================================
  echo "$path" | grep -qE "^/usr/bin/google-chrome$|^/opt/google/chrome/chrome$|^/opt/google/chrome/chrome_crashpad_handler$|^/usr/bin/chromium$|^/usr/bin/chromium-browser$|^/snap/chromium/|^/usr/bin/firefox$|^/snap/firefox/|^/usr/bin/brave-browser$|^/opt/brave\\\\.com/brave/brave$|^/usr/bin/microsoft-edge$|^/usr/bin/opera$" && continue

  # ============================================================================
  # IF IT REACHES HERE, THE APP IS UNTRUSTED (Flag it for closure)
  # ============================================================================
  echo "$p|$name|$path"

done 2>/dev/null | sort -u
`;

    exec(cmd, { shell: "/bin/bash" }, (err, stdout) => {
      if (err) return reject(err);

      const apps = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [pid, name, path] = line.split("|");
          return { pid, name, path };
        });

      resolve(apps);
    });
  });
}

ipcMain.handle("scan-apps", async () => {
  const apps = await scanAppsFromShell();

  return {
    apps,
    untrusted_apps_found: apps.length > 0,
  };
});

ipcMain.handle("kill-app", (e, pid) => {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
});
ipcMain.handle("kill-apps", async (e, pids = []) => {
  return pids.reduce((count, pid) => {
    try {
      process.kill(pid, "SIGTERM");
      return count + 1;
    } catch {
      try {
        process.kill(pid, "SIGKILL");
        return count + 1;
      } catch {
        return count;
      }
    }
  }, 0);
});
ipcMain.handle("is-session-active", () => shouldStartPolling);

ipcMain.handle("submit-assessment", async () => {
  app.quit();
});

ipcMain.handle("dismiss-security-warning", () => {
  safeHideWindow(overlayWindow);
});

ipcMain.handle("close-security-app", async (_event, pid) => {
  const numericPid = Number(pid);

  if (!Number.isFinite(numericPid)) return false;

  try {
    process.kill(numericPid, "SIGTERM");
    safeHideWindow(overlayWindow);
    return true;
  } catch {
    try {
      process.kill(numericPid, "SIGKILL");
      safeHideWindow(overlayWindow);
      return true;
    } catch {
      return false;
    }
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("before-quit", async (event) => {
  if (isQuitting) return;

  isQuitting = true;

  if (heartbeatInterval) clearInterval(heartbeatInterval);
  stopSecurityMonitoring();
  stopScreenshotPolling();

  if (!currentSession) return;

  event.preventDefault();

  await patchConnection(false, true);

  app.exit(0);
});
