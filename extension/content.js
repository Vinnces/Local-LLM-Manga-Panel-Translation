(() => {
  if (window.__mangaTranslateLoaded) return;
  window.__mangaTranslateLoaded = true;

  const MIN_RECT = 12;
  const LABEL_MIN_WIDTH = 120;
  const INLINE_FONT_MIN = 70;
  const INLINE_FONT_MAX = 160;
  const INLINE_FONT_STEP = 10;
  const FULL_PAGE_POLL_INTERVAL = 1500;
  const FULL_PAGE_POLL_TIMEOUT = 300000;

  const overlay = document.createElement("div");
  overlay.className = "manga-overlay";
  overlay.style.display = "none";

  const boxEl = document.createElement("div");
  boxEl.className = "manga-box";
  overlay.appendChild(boxEl);
  document.documentElement.appendChild(overlay);

  const inlineRoot = document.createElement("div");
  inlineRoot.className = "manga-inline-root";
  inlineRoot.style.display = "none";
  document.documentElement.appendChild(inlineRoot);

  const panel = document.createElement("div");
  panel.className = "manga-panel";
  panel.style.display = "none";
  document.documentElement.appendChild(panel);

  const hint = document.createElement("div");
  hint.className = "manga-hint";
  hint.style.display = "none";
  hint.textContent = "Click a highlighted panel, drag-select a region, or choose Translate page from the extension popup.";
  document.documentElement.appendChild(hint);

  const toolbar = document.createElement("div");
  toolbar.className = "manga-toolbar";
  toolbar.style.display = "none";
  const toolStatus = document.createElement("span");
  toolStatus.className = "manga-tool-status";
  toolbar.appendChild(toolStatus);
  document.documentElement.appendChild(toolbar);

  let captureRunning = false;

  function setToolStatus(text = "") {
    toolStatus.textContent = text;
    toolbar.style.display = text ? "" : "none";
  }

  let start = null;
  let activeRect = null;
  let activeScaleX = 1;
  let activeScaleY = 1;
  let lastTranslations = null;
  let candidateRects = [];
  let activeCandidateIndex = -1;
  let fullPage = null;
  let fullPageRunning = false;
  let panelMinimized = false;
  let panelSize = null;
  let inlineFontPercent = 100;

  function setBox(x, y, w, h) {
    boxEl.style.left = x + "px";
    boxEl.style.top = y + "px";
    boxEl.style.width = w + "px";
    boxEl.style.height = h + "px";
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clearResults() {
    panel.style.display = "none";
    panel.innerHTML = "";
    inlineRoot.innerHTML = "";
    inlineRoot.style.display = "none";
    activeRect = null;
    lastTranslations = null;
    fullPage = null;
  }

  function showHint() {
    hint.style.display = "block";
  }

  function hideHint() {
    hint.style.display = "none";
  }

  function showPanelStatus(text) {
    panel.innerHTML = "";
    panel.style.height = "";
    panel.style.width = "";
    panel.style.maxWidth = "";
    panel.style.maxHeight = "";
    panel.style.overflow = "";
    panel.appendChild(el("div", "manga-panel-status", text));
    panel.style.display = "block";
  }

  function panelLimits() {
    const rect = panel.getBoundingClientRect();
    const rightMargin = Math.max(0, window.innerWidth - rect.right);
    return {
      width: Math.max(1, window.innerWidth - rightMargin - 12),
      height: Math.max(1, window.innerHeight - Math.max(0, rect.top) - 12),
    };
  }

  function applyPanelSize() {
    if (!panelSize) return;
    const limits = panelLimits();
    panel.style.maxWidth = limits.width + "px";
    panel.style.maxHeight = limits.height + "px";
    panel.style.width = Math.min(panelSize.width, limits.width) + "px";
    panel.style.height = panelMinimized ? "auto" : Math.min(panelSize.height, limits.height) + "px";
  }

  function panelControl(text, label) {
    const button = el("button", "manga-panel-control", text);
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    Object.assign(button.style, {
      border: "1px solid #ccc", borderRadius: "4px", background: "#fff",
      color: "#222", cursor: "pointer", minWidth: "24px", padding: "2px 4px",
    });
    return button;
  }

  function openTranslationPanel(title) {
    const header = el("div", "manga-panel-header");
    Object.assign(header.style, {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: "8px", flex: "0 0 auto",
    });
    const controls = el("div");
    Object.assign(controls.style, { display: "flex", gap: "4px", flexShrink: "0" });
    const smaller = panelControl("A−", "Decrease inline text size");
    const larger = panelControl("A+", "Increase inline text size");
    const minimize = panelControl("−", "Minimize translation list");
    const close = panelControl("×", "Close translations");
    close.addEventListener("click", clearResults);

    function updateFontButtons() {
      smaller.disabled = inlineFontPercent <= INLINE_FONT_MIN;
      larger.disabled = inlineFontPercent >= INLINE_FONT_MAX;
    }
    function changeInlineFont(delta) {
      inlineFontPercent = Math.max(INLINE_FONT_MIN, Math.min(INLINE_FONT_MAX, inlineFontPercent + delta));
      updateFontButtons();
      if (fullPage) renderFullPageLabels();
      else if (lastTranslations) renderInlineLabels(lastTranslations);
    }
    smaller.addEventListener("click", () => changeInlineFont(-INLINE_FONT_STEP));
    larger.addEventListener("click", () => changeInlineFont(INLINE_FONT_STEP));
    updateFontButtons();

    controls.appendChild(smaller);
    controls.appendChild(larger);
    controls.appendChild(minimize);
    controls.appendChild(close);
    header.appendChild(el("span", "", title));
    header.appendChild(controls);

    const body = el("div", "manga-panel-lines");
    Object.assign(body.style, { flex: "1 1 auto", minHeight: "0", overflow: "auto" });
    const footer = el("div");
    footer.style.flex = "0 0 auto";
    const resize = panelControl("↙", "Resize translation list. Drag or use arrow keys.");
    resize.style.cursor = "nesw-resize";
    resize.style.touchAction = "none";
    footer.appendChild(resize);

    function updateMinimized() {
      const label = panelMinimized ? "Restore translation list" : "Minimize translation list";
      minimize.textContent = panelMinimized ? "+" : "−";
      minimize.title = label;
      minimize.setAttribute("aria-label", label);
      minimize.setAttribute("aria-expanded", String(!panelMinimized));
      body.style.display = panelMinimized ? "none" : "";
      footer.style.display = panelMinimized ? "none" : "";
      panel.style.height = panelMinimized ? "auto" : "";
      applyPanelSize();
    }

    function resizeTo(width, height) {
      const limits = panelLimits();
      panelSize = {
        width: Math.max(Math.min(240, limits.width), Math.min(width, limits.width)),
        height: Math.max(Math.min(150, limits.height), Math.min(height, limits.height)),
      };
      applyPanelSize();
    }

    let drag = null;
    resize.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      const { width, height } = panel.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, width, height };
      resize.setPointerCapture(event.pointerId);
    });
    resize.addEventListener("pointermove", (event) => {
      if (drag?.id !== event.pointerId) return;
      resizeTo(drag.width + drag.x - event.clientX, drag.height + event.clientY - drag.y);
    });
    resize.addEventListener("lostpointercapture", () => { drag = null; });
    resize.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 40 : 16;
      const { width, height } = panel.getBoundingClientRect();
      switch (event.key) {
        case "ArrowLeft": resizeTo(width + step, height); break;
        case "ArrowRight": resizeTo(width - step, height); break;
        case "ArrowDown": resizeTo(width, height + step); break;
        case "ArrowUp": resizeTo(width, height - step); break;
        default: return;
      }
      event.preventDefault();
    });
    minimize.addEventListener("click", () => {
      panelMinimized = !panelMinimized;
      updateMinimized();
    });

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(footer);
    Object.assign(panel.style, { display: "flex", flexDirection: "column", overflow: "hidden", boxSizing: "border-box" });
    updateMinimized();
    return body;
  }

  function renderResult(result, clientRect) {
    clearResults();

    const translations = (result && result.translations) || [];
    if (!translations.length) {
      showPanelStatus("No text found.");
      return;
    }

    const scaleX = result.scaleX || 1;
    const scaleY = result.scaleY || 1;

    const lines = openTranslationPanel("Translation (" + translations.length + " lines)");

    activeRect = clientRect;
    activeScaleX = scaleX;
    activeScaleY = scaleY;
    lastTranslations = translations;
    inlineRoot.style.display = "block";
    renderInlineLabels(translations);

    for (const row of translations) {
      const line = el("div", "manga-line");
      line.appendChild(el("span", "manga-id", "#" + row.id));
      if (row.garbled) {
        line.appendChild(el("span", "manga-badge manga-garbled", "GARBLED"));
      }
      if (row.question) {
        line.appendChild(el("span", "manga-badge manga-question", "?"));
      }
      if (row.en) {
        line.appendChild(el("div", "manga-en", row.en));
      } else {
        line.appendChild(el("div", "manga-en manga-empty", "(untranslated)"));
      }
      if (row.ja) {
        line.appendChild(el("div", "manga-ja", row.ja));
      }
      lines.appendChild(line);
    }
    hideHint();
  }

  function appendInlineLabel(row, left, top, width, scrollX, scrollY, rightEdge) {
    const label = el("div", "manga-label");
    label.style.top = (top + scrollY) + "px";
    label.appendChild(el("div", "manga-label-en", row.en || "(untranslated)"));
    if (row.ja) label.appendChild(el("div", "manga-label-ja", row.ja));
    inlineRoot.appendChild(label);

    if (inlineFontPercent !== 100) {
      const scale = inlineFontPercent / 100;
      const parts = Array.from(label.children);
      const baseSizes = parts.map((part) => parseFloat(window.getComputedStyle(part).fontSize));
      parts.forEach((part, index) => {
        if (Number.isFinite(baseSizes[index])) {
          part.style.fontSize = (baseSizes[index] * scale) + "px";
        }
      });
    }

    requestAnimationFrame(() => {
      if (!label.isConnected) return;
      const labelWidth = label.offsetWidth || LABEL_MIN_WIDTH;
      const rightPos = left + width + 8;
      const labelLeft = rightPos + labelWidth > rightEdge ? left - 8 - labelWidth : rightPos;
      label.style.left = (labelLeft + scrollX) + "px";
    });
  }

  function renderInlineLabels(translations) {
    if (!activeRect) return;
    const rect = activeRect;
    const sx = activeScaleX;
    const sy = activeScaleY;
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const rightEdge = window.innerWidth - 4;

    inlineRoot.querySelectorAll(".manga-box-hl, .manga-label").forEach((n) => n.remove());

    for (const row of translations) {
      if (!row.box || !Array.isArray(row.box) || row.box.length < 4) continue;
      const [x0, y0, x1, y1] = row.box;
      const left = rect.x + x0 * sx;
      const top = rect.y + y0 * sy;
      const width = (x1 - x0) * sx;
      const height = (y1 - y0) * sy;

      const hl = document.createElement("div");
      hl.className = "manga-box-hl";
      hl.style.left = (left + scrollX) + "px";
      hl.style.top = (top + scrollY) + "px";
      hl.style.width = width + "px";
      hl.style.height = height + "px";
      inlineRoot.appendChild(hl);

      appendInlineLabel(row, left, top, width, scrollX, scrollY, rightEdge);
    }
  }

  function renderFullPageLabels() {
    if (!fullPage) return;
    const { imgEl, translations, imgW, imgH } = fullPage;
    const rect = imgEl.getBoundingClientRect();
    const scaleX = rect.width / imgW;
    const scaleY = rect.height / imgH;
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const rightEdge = window.innerWidth - 4;

    inlineRoot.querySelectorAll(".manga-box-hl, .manga-label").forEach((n) => n.remove());

    for (const row of translations) {
      if (!row.box || !Array.isArray(row.box) || row.box.length < 4) continue;
      const [x0, y0, x1, y1] = row.box;
      const left = rect.x + x0 * scaleX;
      const top = rect.y + y0 * scaleY;
      const width = (x1 - x0) * scaleX;
      const height = (y1 - y0) * scaleY;

      const hl = document.createElement("div");
      hl.className = "manga-box-hl";
      hl.style.left = (left + scrollX) + "px";
      hl.style.top = (top + scrollY) + "px";
      hl.style.width = width + "px";
      hl.style.height = height + "px";
      inlineRoot.appendChild(hl);

      appendInlineLabel(row, left, top, width, scrollX, scrollY, rightEdge);
    }
  }

  function applyFullPageResult(result, imgEl) {
    const translations = result?.translations;
    if (!Array.isArray(translations)) throw new Error("The service returned invalid translations.");
    if (!translations.length) {
      showPanelStatus("No text found on the full page.");
      return;
    }

    const imgW = result.imgW || imgEl.naturalWidth || 0;
    const imgH = result.imgH || imgEl.naturalHeight || 0;

    clearResults();
    fullPage = { imgEl, translations, imgW, imgH };

    const lines = openTranslationPanel("Full-page translation (" + translations.length + " lines)");

    for (const row of translations) {
      const line = el("div", "manga-line");
      line.appendChild(el("span", "manga-id", "#" + row.id));
      if (row.garbled) line.appendChild(el("span", "manga-badge manga-garbled", "GARBLED"));
      if (row.question) line.appendChild(el("span", "manga-badge manga-question", "?"));
      line.appendChild(el("div", "manga-en", row.en || "(untranslated)"));
      if (row.ja) line.appendChild(el("div", "manga-ja", row.ja));
      lines.appendChild(line);
    }

    inlineRoot.style.display = "block";
    renderFullPageLabels();
    hideHint();
  }

  async function fullPageRequest(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "The extension did not respond.");
    return response.result;
  }

  async function translateFullPage(url, imgEl) {
    try {
      showPanelStatus("Downloading full page…");
      const { jobId, imgW, imgH } = await fullPageRequest({ type: "START_FULL_PAGE_JOB", url });
      console.log("[manga] Full-page job accepted:", jobId);
      showPanelStatus("Translating full page…");
      const deadline = Date.now() + FULL_PAGE_POLL_TIMEOUT;
      while (Date.now() < deadline) {
        if (!imgEl.isConnected || (imgEl.currentSrc || imgEl.src) !== url) {
          throw new Error("The manga image changed. Translate the current page again.");
        }
        const job = await fullPageRequest({ type: "GET_FULL_PAGE_JOB", jobId });
        if (job?.status === "error") throw new Error(job.error || "Full-page translation failed.");
        if (job?.status === "done") {
          if (!imgEl.isConnected || (imgEl.currentSrc || imgEl.src) !== url) {
            throw new Error("The manga image changed. Translate the current page again.");
          }
          applyFullPageResult({ ...job.result, imgW, imgH }, imgEl);
          console.log("[manga] Full-page result shown:", jobId);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, FULL_PAGE_POLL_INTERVAL));
      }
      throw new Error("Timed out waiting for the translation service.");
    } catch (err) {
      showPanelStatus("Error: " + (err?.message || String(err)));
    } finally {
      fullPageRunning = false;
      setToolStatus();
      hideHint();
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "FULL_PAGE_START") return;
    if (fullPageRunning || captureRunning || start) {
      sendResponse({ ok: false, error: "Finish the current selection or translation first." });
      return;
    }
    const imgEl = Array.from(document.images).find(
      (img) => img.naturalWidth && (img.currentSrc || img.src) === message.url
    );
    if (!imgEl) {
      sendResponse({ ok: false, error: "The selected manga image is no longer on this page." });
      return;
    }

    fullPageRunning = true;
    setToolStatus("Translating…");
    hideHint();
    void translateFullPage(message.url, imgEl);
    sendResponse({ ok: true });
  });

  function requestCapture(clientRect) {
    if (fullPageRunning || captureRunning) return;
    captureRunning = true;
    showHint();
    showPanelStatus("Translating\u2026");
    setToolStatus("Translating…");
    chrome.runtime.sendMessage(
      {
        type: "CAPTURE",
        rect: {
          x: clientRect.x,
          y: clientRect.y,
          width: clientRect.width,
          height: clientRect.height,
        },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      },
      (response) => {
        captureRunning = false;
        setToolStatus();
        if (chrome.runtime.lastError) {
          showPanelStatus("Service unavailable: " + chrome.runtime.lastError.message);
          return;
        }
        if (!response || !response.ok) {
          showPanelStatus("Error: " + (response && response.error ? response.error : "unknown"));
          return;
        }
        renderResult(response.result, clientRect);
      }
    );
  }

  function onMouseDown(e) {
    if (fullPageRunning || e.button !== 0) return;
    if (toolbar.contains(e.target)) return;
    if (panel.contains(e.target)) return;
    if (hint.contains(e.target)) return;
    if (e.target.closest && e.target.closest(".manga-candidate")) return;
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY };
    overlay.style.display = "block";
    setBox(start.x, start.y, 0, 0);
  }

  function onMouseMove(e) {
    if (!start) return;
    e.preventDefault();
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    const w = Math.abs(e.clientX - start.x);
    const h = Math.abs(e.clientY - start.y);
    setBox(x, y, w, h);
  }

  function onMouseUp(e) {
    if (!start) return;
    e.preventDefault();
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    const w = Math.abs(e.clientX - start.x);
    const h = Math.abs(e.clientY - start.y);
    start = null;
    overlay.style.display = "none";

    if (w < MIN_RECT || h < MIN_RECT) return;

    requestCapture({
      x: x,
      y: y,
      width: w,
      height: h,
    });
  }

  function detectCandidates(imgEl) {
    if (!imgEl || !imgEl.naturalWidth) return;
    const rect = imgEl.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;

    let candidates = [];
    try {
      candidates = detectPanelsOnImage(imgEl, rect);
    } catch (err) {
      candidates = [];
    }

    inlineRoot.querySelectorAll(".manga-candidate").forEach((n) => n.remove());
    if (!candidates.length) return;

    candidateRects = candidates;
    const centerX = window.innerWidth / 2;
    activeCandidateIndex = -1;
    let bestDist = Infinity;
    candidates.forEach((c, i) => {
      const cx = c.x + c.width / 2;
      const dist = Math.abs(cx - centerX);
      if (dist < bestDist) {
        bestDist = dist;
        activeCandidateIndex = i;
      }
    });
    renderCandidates();
  }

  function renderCandidates() {
    if (!candidateRects.length) return;
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    inlineRoot.querySelectorAll(".manga-candidate").forEach((n) => n.remove());
    candidateRects.forEach((c, i) => {
      const div = document.createElement("div");
      div.className = "manga-candidate";
      if (i === activeCandidateIndex) div.classList.add("manga-candidate-active");
      div.style.left = (c.x + scrollX) + "px";
      div.style.top = (c.y + scrollY) + "px";
      div.style.width = c.width + "px";
      div.style.height = c.height + "px";
      div.addEventListener("click", (ev) => {
        ev.stopPropagation();
        requestCapture({ x: c.x, y: c.y, width: c.width, height: c.height });
      });
      inlineRoot.appendChild(div);
    });
    inlineRoot.style.display = "block";
  }

  function detectPanelsOnImage(imgEl, rect) {
    const scale = 96 / imgEl.naturalWidth;
    const sw = Math.max(1, Math.round(imgEl.naturalWidth * scale));
    const sh = Math.max(1, Math.round(imgEl.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(imgEl, 0, 0, sw, sh);
    const data = ctx.getImageData(0, 0, sw, sh).data;

    const rowBright = new Array(sh).fill(0);
    const colBright = new Array(sw).fill(0);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4;
        const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        if (l > 200) {
          rowBright[y]++;
          colBright[x]++;
        }
      }
    }

    const rowGutter = new Array(sh).fill(false);
    for (let y = 0; y < sh; y++) rowGutter[y] = rowBright[y] / sw > 0.85;
    const colGutter = new Array(sw).fill(false);
    for (let x = 0; x < sw; x++) colGutter[x] = colBright[x] / sh > 0.85;

    const rowBands = bandsFromGutters(rowGutter, sh, 0.08);
    const colBands = bandsFromGutters(colGutter, sw, 0.08);

    const inv = { x: 1 / scale, y: 1 / scale };
    const out = [];
    for (const rb of rowBands) {
      for (const cb of colBands) {
        const x = rect.x + cb[0] * inv.x;
        const y = rect.y + rb[0] * inv.y;
        const width = (cb[1] - cb[0]) * inv.x;
        const height = (rb[1] - rb[0]) * inv.y;
        if (width > 40 && height > 40) {
          out.push({ x, y, width, height });
        }
      }
    }
    return out;
  }

  function bandsFromGutters(gutters, length, minRatio) {
    const bands = [];
    let start = null;
    for (let i = 0; i <= length; i++) {
      const isGutter = i < length && gutters[i];
      if (!isGutter) {
        if (start === null) start = i;
      } else {
        if (start !== null) {
          if ((i - start) / length >= minRatio) bands.push([start, i]);
          start = null;
        }
      }
    }
    if (!bands.length) return [[0, length]];
    return bands;
  }

  function findTargetImage() {
    const images = Array.from(document.images);
    let best = null;
    let bestArea = 0;
    for (const img of images) {
      if (!img.naturalWidth) continue;
      const rect = img.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = img;
      }
    }
    return best;
  }

  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("resize", () => {
    if (panel.style.display === "flex") applyPanelSize();
    if (candidateRects.length) renderCandidates();
    if (fullPage) renderFullPageLabels();
    else if (activeRect && lastTranslations) renderInlineLabels(lastTranslations);
  });

  setTimeout(() => {
    const img = findTargetImage();
    if (img) {
      detectCandidates(img);
      showHint();
    }
  }, 600);
})();
