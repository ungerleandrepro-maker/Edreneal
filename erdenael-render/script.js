const variantButtons = document.querySelectorAll(".variant-picker button");
const tabButtons = document.querySelectorAll(".tab[data-tab]");
const sourcePanels = document.querySelectorAll(".source-panel[data-panel]");
const variantCount = document.querySelector("#variant-count");
const switchButton = document.querySelector(".switch");
const dropzone = document.querySelector(".dropzone");
const fileInput = document.querySelector("#file-input");
const instagramUrls = document.querySelector("#instagram-urls");
const instagramImportButton = document.querySelector("#instagram-import-button");
const instagramStatus = document.querySelector("#instagram-status");
const fileList = document.querySelector("#file-list");
const resultList = document.querySelector("#result-list");
const queueSummary = document.querySelector("#queue-summary");
const generateButton = document.querySelector("#generate-button");
const clearButton = document.querySelector("#clear-button");
const batchActions = document.querySelector("#batch-actions");
const downloadVideosButton = document.querySelector("#download-videos-button");
const downloadNotice = document.querySelector("#download-notice");
const progressBar = document.querySelector("#progress-bar");
const historyToggle = document.querySelector("#history-toggle");
const historyPanel = document.querySelector("#history-panel");
const historyList = document.querySelector("#history-list");
const historyClear = document.querySelector("#history-clear");

let files = [];
let variants = 5;
let maxQuality = false;
let activeTab = "upload";
let history = JSON.parse(localStorage.getItem("erdenael-history") || "[]");
let generatedVideos = [];
const basePath = "/erdenael";

const filters = [
  { name: "Naturel", css: "saturate(1.08) contrast(1.04) brightness(1.02)" },
  { name: "Studio", css: "saturate(0.95) contrast(1.12) brightness(1.06)" },
  { name: "Corail", css: "sepia(0.12) saturate(1.28) hue-rotate(-8deg) brightness(1.04)" },
  { name: "Ocean", css: "saturate(1.22) hue-rotate(12deg) contrast(1.08)" },
  { name: "Cinema", css: "contrast(1.18) saturate(0.86) brightness(0.96)" },
  { name: "Clair", css: "brightness(1.12) contrast(0.98) saturate(1.04)" },
  { name: "Net", css: "contrast(1.24) saturate(1.12)" },
  { name: "Doux", css: "brightness(1.08) saturate(0.9) contrast(0.94)" },
  { name: "Bleu", css: "hue-rotate(20deg) saturate(1.12) contrast(1.06)" },
  { name: "Print", css: "sepia(0.08) contrast(1.08) saturate(0.98)" },
];

variantButtons.forEach((button) => {
  button.addEventListener("click", () => {
    variantButtons.forEach((item) => {
      item.classList.remove("selected");
      item.setAttribute("aria-checked", "false");
    });

    button.classList.add("selected");
    button.setAttribute("aria-checked", "true");
    variants = Number(button.textContent.trim());
    variantCount.textContent = variants;
    renderQueue();
  });
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab, true));
});

switchButton.addEventListener("click", () => {
  maxQuality = switchButton.classList.toggle("on");
  switchButton.setAttribute("aria-checked", String(maxQuality));
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });
});

dropzone.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  addFiles(event.dataTransfer.files);
});

fileInput.addEventListener("change", () => addFiles(fileInput.files));

instagramImportButton.addEventListener("click", importInstagramUrls);

generateButton.addEventListener("click", async () => {
  generateButton.disabled = true;
  resultList.innerHTML = "";
  generatedVideos = [];
  batchActions.hidden = true;
  downloadNotice.hidden = true;
  progressBar.style.width = "0%";

  const imageFiles = files.filter((item) => item.source !== "instagram" && getItemType(item).startsWith("image/"));
  const videoFiles = files.filter((item) => getItemType(item).startsWith("video/"));
  const totalJobs = imageFiles.length * variants + videoFiles.length * variants;
  let completed = 0;

  for (const item of imageFiles) {
    for (let index = 0; index < variants; index += 1) {
      const output = await createImageVariantForItem(item, index);
      renderResult(output);
      completed += 1;
      progressBar.style.width = `${Math.round((completed / totalJobs) * 100)}%`;
      await wait(70);
    }
  }

  for (const item of videoFiles) {
    for (let index = 0; index < variants; index += 1) {
      const output = await createVideoVariantForItem(item, index);
      await persistGeneratedVideo(output);
      renderVideoResult(output);
      completed += 1;
      progressBar.style.width = `${Math.round((completed / totalJobs) * 100)}%`;
      await wait(45);
    }
  }

  const generatedImageCount = imageFiles.length * variants;
  const generatedVideoCount = videoFiles.length * variants;
  addHistory(`${generatedImageCount} variante${generatedImageCount > 1 ? "s" : ""} image, ${generatedVideoCount} variante${generatedVideoCount > 1 ? "s" : ""} video reencodee`);
  batchActions.hidden = generatedVideos.length === 0;
  generateButton.disabled = files.length === 0;
});

clearButton.addEventListener("click", () => {
  files.forEach((item) => URL.revokeObjectURL(item.url));
  files = [];
  generatedVideos = [];
  fileInput.value = "";
  resultList.innerHTML = "";
  batchActions.hidden = true;
  progressBar.style.width = "0%";
  renderQueue();
});

downloadVideosButton.addEventListener("click", async () => {
  for (const output of generatedVideos) {
    await downloadOutput(output);
    await wait(160);
  }
});

historyToggle.addEventListener("click", () => {
  historyPanel.classList.toggle("open");
});

historyClear.addEventListener("click", () => {
  history = [];
  localStorage.removeItem("erdenael-history");
  renderHistory();
});

function addFiles(fileBag) {
  const accepted = [...fileBag].filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/"));
  const mapped = accepted.map((file) => ({
    id: crypto.randomUUID(),
    source: "upload",
    file,
    url: URL.createObjectURL(file),
  }));

  files = [...files, ...mapped];
  renderQueue();
}

function renderQueue() {
  fileList.innerHTML = "";
  generateButton.disabled = files.length === 0;

  if (!files.length) {
    queueSummary.textContent = "Aucun item dans la sacoche";
    dropzone.querySelector("strong").textContent = "Range tes medias dans la sacoche";
    return;
  }

  const imageCount = files.filter((item) => getItemType(item).startsWith("image/")).length;
  const videoCount = files.filter((item) => getItemType(item).startsWith("video/")).length;
  const totalPlanned = imageCount * variants + videoCount * variants;
  queueSummary.textContent = `${files.length} item${files.length > 1 ? "s" : ""} - ${totalPlanned} variante${totalPlanned > 1 ? "s" : ""} prevue${totalPlanned > 1 ? "s" : ""}`;
  dropzone.querySelector("strong").textContent = `${files.length} item${files.length > 1 ? "s" : ""} range${files.length > 1 ? "s" : ""}`;

  files.forEach((item) => {
    const card = document.createElement("article");
    card.className = "file-card";
    const itemType = getItemType(item);
    const preview = itemType.startsWith("image/") ? "img" : "video";
    card.innerHTML = `
      <${preview} class="thumb" src="${item.url}" ${preview === "video" ? "muted playsinline" : "alt=''"}></${preview}>
      <div class="file-meta">
        <strong>${escapeHtml(getItemName(item))}</strong>
        <span>${formatBytes(getItemSize(item))} - ${itemType || "type inconnu"}${item.source === "instagram" ? " - Instagram" : ""}</span>
      </div>
      <span class="status-pill">${itemType.startsWith("image/") ? `${variants} copies` : `${variants} crafts`}</span>
    `;
    fileList.append(card);
  });
}

async function importInstagramUrls() {
  const urls = instagramUrls.value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 10);

  if (!urls.length) {
    showInstagramStatus("Ajoute au moins un lien Instagram.", true);
    return;
  }

  instagramImportButton.disabled = true;
  showInstagramStatus("Import Instagram en cours...");

  try {
    const response = await fetch("/instagram-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Import impossible.");
    }

    const imported = payload.items.filter((item) => item.ok);
    const failed = payload.items.filter((item) => !item.ok);
    const importedVideos = imported.filter((item) => item.type?.startsWith("video/"));
    files = files.filter((item) => item.source !== "instagram");
    importedVideos.forEach((item) => {
      files.push({
        id: crypto.randomUUID(),
        source: "instagram",
        serverName: item.serverName,
        pageUrl: item.pageUrl,
        mediaType: item.type,
        name: item.name,
        size: item.size,
        url: item.url,
      });
    });

    renderQueue();
    const importedText = `${importedVideos.length} video${importedVideos.length > 1 ? "s" : ""} importe${importedVideos.length > 1 ? "es" : "e"}`;
    const failedText = failed.length ? ` - ${failed.length} lien${failed.length > 1 ? "s" : ""} non recupere${failed.length > 1 ? "s" : ""} (${failed[0].error})` : "";
    showInstagramStatus(`${importedText}${failedText}`, importedVideos.length === 0);
  } catch (error) {
    showInstagramStatus(error.message || "Import Instagram impossible.", true);
  } finally {
    instagramImportButton.disabled = false;
  }
}

function showInstagramStatus(message, error = false) {
  instagramStatus.hidden = false;
  instagramStatus.textContent = message;
  instagramStatus.classList.toggle("error", error);
}

function setActiveTab(tab, push = false) {
  activeTab = tab;
  tabButtons.forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  sourcePanels.forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });

  if (push) {
    const path = tab === "upload" ? basePath : `${basePath}/${tab}`;
    window.history.replaceState(null, "", path);
  }
}

function getTabFromPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] === "erdenael") {
    return ["instagram", "tiktok"].includes(parts[1]) ? parts[1] : "upload";
  }

  return ["instagram", "tiktok"].includes(parts[0]) ? parts[0] : "upload";
}

function getItemType(item) {
  return item.mediaType || item.file?.type || "";
}

function getItemName(item) {
  return item.name || item.file?.name || "media";
}

function getItemSize(item) {
  return item.size || item.file?.size || 0;
}

async function createImageVariantForItem(item, index) {
  if (item.source === "instagram") {
    throw new Error("Instagram ne genere que des videos MP4.");
  }
  return createImageVariant(item.file, index);
}

async function createVideoVariantForItem(item, index) {
  if (item.source === "instagram") {
    return createImportedVideoVariant(item, index);
  }
  return createVideoVariant(item.file, index);
}

async function createImageVariant(file, index) {
  const image = await loadImage(file);
  const canvas = document.createElement("canvas");
  const maxSide = maxQuality ? 2200 : 1400;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

  const context = canvas.getContext("2d");
  const filter = filters[index % filters.length];
  context.filter = filter.css;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  addSoftGrain(context, canvas.width, canvas.height, index);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", maxQuality ? 0.94 : 0.86));
  const baseName = file.name.replace(/\.[^.]+$/, "");
  return {
    name: `${baseName}-erdenael-${index + 1}-${filter.name.toLowerCase()}.jpg`,
    style: filter.name,
    size: blob.size,
    url: URL.createObjectURL(blob),
    blob,
  };
}

async function createVideoVariant(file, index) {
  const response = await fetch(`/variant-video?name=${encodeURIComponent(file.name)}&variant=${index + 1}&quality=${maxQuality ? "max" : "standard"}`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });

  if (!response.ok) {
    throw new Error("Impossible de creer la variante video.");
  }

  const saved = await response.json();
  const output = {
    name: saved.name,
    style: saved.style,
    size: saved.size,
    url: saved.url,
    serverUrl: saved.url,
    blob: null,
  };
  generatedVideos.push(output);
  return output;
}

async function createImportedVideoVariant(item, index) {
  const response = await fetch(`/variant-import-video?name=${encodeURIComponent(item.serverName)}&variant=${index + 1}&quality=${maxQuality ? "max" : "standard"}`, {
    method: "POST",
  });
  if (!response.ok) throw new Error("Impossible de creer la variante Instagram.");
  const saved = await response.json();
  const output = {
    name: saved.name,
    style: saved.style,
    size: saved.size,
    url: saved.url,
    serverUrl: saved.url,
    blob: null,
  };
  generatedVideos.push(output);
  return output;
}

async function createImportedImageVariant(item, index) {
  const response = await fetch(`/variant-import-image?name=${encodeURIComponent(item.serverName)}&variant=${index + 1}&quality=${maxQuality ? "max" : "standard"}`, {
    method: "POST",
  });
  if (!response.ok) throw new Error("Impossible de creer l'image Instagram.");
  const saved = await response.json();
  return {
    name: saved.name,
    style: saved.style,
    size: saved.size,
    url: saved.url,
    serverUrl: saved.url,
    blob: null,
  };
}

function renderResult(output) {
  const card = document.createElement("article");
  card.className = "result-card";
  card.innerHTML = `
    <img class="thumb" src="${output.url}" alt="">
    <div class="result-meta">
      <strong>${escapeHtml(output.name)}</strong>
      <span>Style ${output.style} - ${formatBytes(output.size)}</span>
    </div>
    <button class="download-action" type="button">Telecharger</button>
  `;
  card.querySelector(".download-action").addEventListener("click", () => downloadOutput(output));
  resultList.append(card);
}

function renderVideoResult(output) {
  const card = document.createElement("article");
  card.className = "result-card";
  const status = output.serverUrl ? "fichier sauvegarde" : "sauvegarde locale fallback";
  const publicUrl = output.serverUrl || output.url;
  card.innerHTML = `
    <video class="thumb" src="${publicUrl}" muted playsinline></video>
    <div class="result-meta">
      <strong>${escapeHtml(output.name)}</strong>
      <span>Video exportee ${escapeHtml(output.style)} - ${formatBytes(output.size)} - ${status}</span>
      <a href="${publicUrl}" download="${escapeHtml(output.name)}">Lien direct</a>
    </div>
    <button class="download-action" type="button">Telecharger</button>
  `;
  card.querySelector(".download-action").addEventListener("click", () => downloadOutput(output));
  resultList.append(card);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = URL.createObjectURL(file);
  });
}

function waitForVideoMetadata(video) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    video.addEventListener("loadedmetadata", resolve, { once: true });
    video.addEventListener("error", () => reject(new Error("Impossible de lire cette video.")), { once: true });
  });
}

function getRecorderMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function addSoftGrain(context, width, height, seed) {
  const imageData = context.getImageData(0, 0, width, height);
  const stride = maxQuality ? 13 : 19;
  for (let index = seed; index < imageData.data.length; index += stride * 4) {
    const grain = ((index + seed * 17) % 7) - 3;
    imageData.data[index] = Math.max(0, Math.min(255, imageData.data[index] + grain));
    imageData.data[index + 1] = Math.max(0, Math.min(255, imageData.data[index + 1] + grain));
    imageData.data[index + 2] = Math.max(0, Math.min(255, imageData.data[index + 2] + grain));
  }
  context.putImageData(imageData, 0, 0);
}

function drawVariantNoise(context, width, height, seed) {
  const amount = maxQuality ? 10 : 18;
  context.save();
  context.globalAlpha = maxQuality ? 0.018 : 0.028;
  context.fillStyle = seed % 2 ? "#ffffff" : "#000000";
  for (let index = 0; index < amount; index += 1) {
    const x = (index * 97 + seed * 41) % width;
    const y = (index * 53 + seed * 29) % height;
    context.fillRect(x, y, 1, 1);
  }
  context.restore();
}

function addHistory(summary) {
  history.unshift({
    date: new Date().toLocaleString("fr-FR"),
    summary,
  });
  history = history.slice(0, 8);
  localStorage.setItem("erdenael-history", JSON.stringify(history));
  renderHistory();
}

function renderHistory() {
  historyList.innerHTML = history.length
    ? history.map((item) => `<article class="history-item"><strong>${escapeHtml(item.summary)}</strong><span>${escapeHtml(item.date)}</span></article>`).join("")
    : `<article class="history-item"><span>Aucun craft local pour le moment</span></article>`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function persistGeneratedVideo(output) {
  if (!output.blob) return;
  try {
    const response = await fetch(`/save?name=${encodeURIComponent(output.name)}`, {
      method: "POST",
      headers: {
        "Content-Type": output.blob.type || "application/octet-stream",
      },
      body: output.blob,
    });

    if (!response.ok) throw new Error("Sauvegarde impossible");
    const saved = await response.json();
    output.name = saved.name || output.name;
    output.serverUrl = saved.url;
  } catch {
    output.serverUrl = "";
  }
}

async function downloadOutput(output) {
  if (output.serverUrl) {
    if (!isLocalHost()) {
      saveRemoteFile(output.serverUrl, output.name);
      return;
    }

    const url = `/download?name=${encodeURIComponent(output.name)}`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      window.location.assign(output.serverUrl);
      return;
    }
    showDownloadNotice(output.name);
    return;
  }

  saveBlob(output.blob, output.name);
}

function isLocalHost() {
  return ["localhost", "127.0.0.1"].includes(window.location.hostname);
}

function saveRemoteFile(url, name) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

function showDownloadNotice(name) {
  downloadNotice.hidden = false;
  downloadNotice.innerHTML = `Fichier ajoute dans ton dossier Telechargements : <strong>${escapeHtml(name)}</strong>`;
}

async function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const initialTab = getTabFromPath(location.pathname);
if (location.pathname === "/") {
  window.history.replaceState(null, "", basePath);
}
setActiveTab(initialTab, false);
renderQueue();
renderHistory();
