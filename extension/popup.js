const HATH_NETWORK_PATTERN = "https://*.hath.network/*";

const hostEl = document.getElementById("host");
const goBtn = document.getElementById("go");
const statusEl = document.getElementById("status");

let currentTab = null;
let imageUrl = null;
let hostPattern = null;
let hostGranted = false;

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.classList.remove("ok", "err");
  if (kind) statusEl.classList.add(kind);
}

function hostPatternForImage(url) {
  const { protocol, hostname } = url;
  if (protocol === "https:" && (hostname === "hath.network" || hostname.endsWith(".hath.network"))) {
    return HATH_NETWORK_PATTERN;
  }
  return protocol + "//" + hostname + "/*";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function detectImageUrl(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      let best = null;
      let bestArea = 0;
      for (const img of document.images) {
        if (!img.naturalWidth) continue;
        const rect = img.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea) {
          bestArea = area;
          best = img;
        }
      }
      if (!best) return null;
      return best.currentSrc || best.src || null;
    },
  });
  return results && results[0] && results[0].result;
}

async function ensureContentScript(tabId) {
  const probe = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => !!window.__mangaTranslateLoaded,
  });
  const loaded = probe && probe[0] && probe[0].result;
  if (loaded) return;
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function init() {
  try {
    currentTab = await getActiveTab();
    if (!currentTab || !currentTab.id) {
      setStatus("No active tab.", "err");
      return;
    }
    if (!/^https?:/.test(currentTab.url || "")) {
      hostEl.textContent = (currentTab.url || "this page");
      setStatus("Extension pages cannot be read. Open a manga page first.", "err");
      return;
    }

    imageUrl = await detectImageUrl(currentTab.id);
    if (!imageUrl) {
      hostEl.textContent = currentTab.url;
      setStatus("No image found on this page yet.", "err");
      return;
    }

    const source = new URL(imageUrl);
    hostPattern = hostPatternForImage(source);
    const isHathNetwork = hostPattern === HATH_NETWORK_PATTERN;
    hostEl.textContent = "Image host: " + source.hostname;

    hostGranted = await chrome.permissions.contains({ origins: [hostPattern] });
    await ensureContentScript(currentTab.id);
    goBtn.disabled = false;
    goBtn.textContent = hostGranted ? "Translate page" : "Allow & translate";
    const permissionMessage = isHathNetwork
      ? "Allow hath.network image hosts once to translate across pages."
      : "Allow access to this image host to translate.";
    setStatus(hostGranted ? "Ready." : permissionMessage);
  } catch (err) {
    setStatus("Init failed: " + (err && err.message ? err.message : err), "err");
  }
}

goBtn.addEventListener("click", async () => {
  if (!currentTab || !imageUrl || !hostPattern) return;
  goBtn.disabled = true;

  try {
    if (!hostGranted) {
      // Start the permission request in the original click handler.
      hostGranted = await chrome.permissions.request({ origins: [hostPattern] });
      if (!hostGranted) throw new Error("Host permission denied.");
      goBtn.textContent = "Translate page";
    }

    setStatus("Starting translation…");
    const response = await chrome.tabs.sendMessage(currentTab.id, {
      type: "FULL_PAGE_START",
      url: imageUrl,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "The manga tab did not start the translation.");
    }

    setStatus("Translation started. Results will appear on the page.", "ok");
    setTimeout(() => window.close(), 700);
  } catch (err) {
    setStatus("Error: " + (err?.message || String(err)), "err");
    goBtn.disabled = false;
  }
});

init();
