const SERVICE_BASE = "http://127.0.0.1:8765";
const POLL_INTERVAL_MS = 1500;
const POLL_DEADLINE_MS = 300000;
const MAX_POLL_FAILS = 10;

function submitJob(bytes, contentType) {
  return fetch(SERVICE_BASE + "/jobs", {
    method: "POST",
    headers: { "Content-Type": contentType || "image/png" },
    body: bytes,
    signal: AbortSignal.timeout(10000),
  }).then(async (res) => {
    if (!res.ok) {
      let msg = "HTTP " + res.status;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (_) {}
      throw new Error(msg);
    }
    const j = await res.json();
    if (!j || !j.jobId) throw new Error("service did not return a jobId");
    return j.jobId;
  });
}

function pollJob(jobId) {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let fails = 0;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() > deadline) {
        reject(new Error("Timed out waiting for the translation service."));
        return;
      }
      fetch(SERVICE_BASE + "/jobs/" + jobId)
        .then(async (res) => {
          if (!res.ok) throw new Error("HTTP " + res.status);
          const job = await res.json();
          fails = 0;
          if (job.status === "done") {
            resolve(job.result);
          } else if (job.status === "error") {
            reject(new Error(job.error || "translation failed"));
          } else {
            setTimeout(tick, POLL_INTERVAL_MS);
          }
        })
        .catch((err) => {
          fails += 1;
          console.warn("[manga] poll failed (" + fails + "):", err && err.message);
          if (fails >= MAX_POLL_FAILS) {
            reject(new Error("Service unreachable: " + (err && err.message ? err.message : err)));
            return;
          }
          setTimeout(tick, POLL_INTERVAL_MS);
        });
    };
    setTimeout(tick, POLL_INTERVAL_MS);
  });
}

async function handleCapture(message, tab) {
  if (!tab) throw new Error("No source tab for the capture.");
  const { x, y, width, height } = message.rect;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const shotW = bitmap.width;
  const shotH = bitmap.height;

  const vw = message.viewport ? message.viewport.w : shotW;
  const vh = message.viewport ? message.viewport.h : shotH;
  const scaleX = vw > 0 ? shotW / vw : 1;
  const scaleY = vh > 0 ? shotH / vh : 1;

  const cropX = Math.max(0, Math.min(shotW - 1, Math.round(x * scaleX)));
  const cropY = Math.max(0, Math.min(shotH - 1, Math.round(y * scaleY)));
  const cropW = Math.max(1, Math.min(shotW - cropX, Math.round(width * scaleX)));
  const cropH = Math.max(1, Math.min(shotH - cropY, Math.round(height * scaleY)));

  const canvas = new OffscreenCanvas(cropW, cropH);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  bitmap.close();

  const pngBlob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await pngBlob.arrayBuffer());

  const started = Date.now();
  console.log(`[manga] submit job (${bytes.length} bytes, crop ${cropW}x${cropH} of ${shotW}x${shotH}, rect ${width}x${height} @ ${x},${y}, scale ${scaleX.toFixed(3)}x${scaleY.toFixed(3)})`);
  const jobId = await submitJob(bytes);
  console.log("[manga] job " + jobId + " accepted; polling");

  const result = await pollJob(jobId);
  console.log(`[manga] job done after ${Date.now() - started} ms`);

  if (result && message.viewport) {
    result.scaleX = message.viewport.w / shotW;
    result.scaleY = message.viewport.h / shotH;
  }
  return result;
}

async function startFullPageJob(message) {
  const url = message.url;
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("Invalid image URL.");

  const res = await fetch(url, {
    credentials: "include",
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error("Failed to fetch image: HTTP " + res.status);
  const contentType = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
  const bytes = new Uint8Array(await res.arrayBuffer());

  let imgW = 0;
  let imgH = 0;
  try {
    const blob = new Blob([bytes], { type: contentType });
    const bitmap = await createImageBitmap(blob);
    imgW = bitmap.width;
    imgH = bitmap.height;
    bitmap.close();
  } catch (_) {
    // non-fatal: dimensions unknown; content script will fall back to naturalWidth
  }

  console.log(`[manga] full-page upload (${bytes.length} bytes, ${contentType})`);
  const jobId = await submitJob(bytes, contentType);
  return { jobId, imgW, imgH };
}

async function getFullPageJob(jobId) {
  if (typeof jobId !== "string" || !jobId) throw new Error("Missing translation job ID.");
  const res = await fetch(SERVICE_BASE + "/jobs/" + encodeURIComponent(jobId), {
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Translation status request failed: HTTP " + res.status);
  return res.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let task;
  switch (message?.type) {
    case "CAPTURE":
      task = () => handleCapture(message, sender.tab);
      break;
    case "START_FULL_PAGE_JOB":
      if (!sender.tab) return;
      task = () => startFullPageJob(message);
      break;
    case "GET_FULL_PAGE_JOB":
      if (!sender.tab) return;
      task = () => getFullPageJob(message.jobId);
      break;
    default:
      return;
  }

  (async () => {
    try {
      sendResponse({ ok: true, result: await task() });
    } catch (err) {
      console.error("[manga] " + message.type + " failed:", err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});
