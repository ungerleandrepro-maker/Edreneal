const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");

const pump = promisify(pipeline);
const root = __dirname;
const generatedDir = path.join(root, "generated");
const importsDir = path.join(root, "imports");
const configPath = path.join(root, "config.local.json");
const downloadsDir = path.join(os.homedir(), "Downloads");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

fs.mkdirSync(generatedDir, { recursive: true });
fs.mkdirSync(importsDir, { recursive: true });

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || `127.0.0.1:${port}`}`);

    if (request.method === "POST" && requestUrl.pathname === "/save") {
      await saveGeneratedFile(request, response, requestUrl);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/variant-video") {
      await createReliableVideoVariant(request, response, requestUrl);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/instagram-import") {
      await importInstagramMedia(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/hiker-key") {
      await saveHikerKey(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/variant-import-video") {
      await createImportedVideoVariant(response, requestUrl);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/variant-import-image") {
      await createImportedImageVariant(response, requestUrl);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/exports") {
      serveExportsPage(response, requestUrl);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/download") {
      downloadToPc(response, requestUrl);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Method not allowed");
      return;
    }

    if (requestUrl.pathname === "/") {
      response.writeHead(302, { Location: "/erdenael" });
      response.end();
      return;
    }

    await serveStatic(request, response, requestUrl);
  } catch (error) {
    console.error(error);
    sendText(response, 500, "Server error");
  }
});

server.listen(port, host, () => {
  console.log(`Erdenael ready on http://127.0.0.1:${port}/erdenael`);
  getLocalNetworkUrls().forEach((url) => console.log(`Network URL: ${url}`));
});

function getLocalNetworkUrls() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && (item.family === "IPv4" || item.family === 4) && !item.internal)
    .map((item) => `http://${item.address}:${port}/erdenael`);
}

async function saveGeneratedFile(request, response, requestUrl) {
  const rawName = requestUrl.searchParams.get("name") || "erdenael-export.webm";
  const safeName = safeFileName(rawName);
  const finalPath = uniquePath(path.join(generatedDir, safeName));
  const tempPath = `${finalPath}.tmp`;

  await pump(request, fs.createWriteStream(tempPath));
  fs.renameSync(tempPath, finalPath);

  const publicName = path.basename(finalPath);
  sendJson(response, 200, {
    name: publicName,
    url: `/generated/${encodeURIComponent(publicName)}`,
  });
}

async function createReliableVideoVariant(request, response, requestUrl) {
  const ffmpegPath = findFfmpeg();
  if (!ffmpegPath) {
    sendJson(response, 500, {
      error: "FFmpeg introuvable. Redemarre le terminal ou ajoute ffmpeg au PATH.",
    });
    return;
  }

  const rawName = requestUrl.searchParams.get("name") || "video.mp4";
  const variant = Number(requestUrl.searchParams.get("variant") || "1");
  const quality = requestUrl.searchParams.get("quality") || "standard";
  const originalExt = path.extname(rawName) || ".mp4";
  const inputExt = originalExt.slice(0, 12) || ".mp4";
  const inputPath = uniquePath(path.join(generatedDir, `_input-${Date.now()}-${cryptoRandom()}${inputExt}`));

  await pump(request, fs.createWriteStream(inputPath));

  try {
    const payload = await transcodeVideoFile(ffmpegPath, inputPath, rawName, variant, quality);
    sendJson(response, 200, payload);
  } finally {
    fs.rmSync(inputPath, { force: true });
  }
}

async function importInstagramMedia(request, response) {
  const body = await readJsonBody(request);
  const urls = Array.isArray(body.urls) ? body.urls.slice(0, 10) : [];
  const items = [];

  for (const inputUrl of urls) {
    try {
      const pageUrl = normalizeInstagramUrl(inputUrl);
      const imported = await fetchInstagramMedia(pageUrl);
      if (!imported.type?.startsWith("video/")) {
        throw new Error("Instagram a renvoye une image, pas une video.");
      }
      items.push({ ok: true, pageUrl, ...imported });
    } catch (error) {
      items.push({
        ok: false,
        pageUrl: inputUrl,
        error: error.message || "Import impossible",
      });
    }
  }

  sendJson(response, 200, { items });
}

async function saveHikerKey(request, response) {
  const body = await readJsonBody(request);
  const key = String(body.key || "").trim();
  if (!key) {
    sendJson(response, 400, { error: "Cle manquante." });
    return;
  }
  fs.writeFileSync(configPath, JSON.stringify({ hikerApiKey: key }, null, 2));
  sendJson(response, 200, { ok: true });
}

async function createImportedVideoVariant(response, requestUrl) {
  const ffmpegPath = findFfmpeg();
  if (!ffmpegPath) {
    sendJson(response, 500, { error: "FFmpeg introuvable." });
    return;
  }

  const sourcePath = resolveImportFile(requestUrl.searchParams.get("name"));
  if (!sourcePath) {
    sendJson(response, 404, { error: "Media Instagram introuvable." });
    return;
  }

  const variant = Number(requestUrl.searchParams.get("variant") || "1");
  const quality = requestUrl.searchParams.get("quality") || "standard";
  const payload = await transcodeVideoFile(ffmpegPath, sourcePath, path.basename(sourcePath), variant, quality);
  sendJson(response, 200, payload);
}

async function createImportedImageVariant(response, requestUrl) {
  const ffmpegPath = findFfmpeg();
  if (!ffmpegPath) {
    sendJson(response, 500, { error: "FFmpeg introuvable." });
    return;
  }

  const sourcePath = resolveImportFile(requestUrl.searchParams.get("name"));
  if (!sourcePath) {
    sendJson(response, 404, { error: "Media Instagram introuvable." });
    return;
  }

  const variant = Number(requestUrl.searchParams.get("variant") || "1");
  const quality = requestUrl.searchParams.get("quality") || "standard";
  const preset = imagePreset(variant, quality);
  const originalExt = path.extname(sourcePath) || ".jpg";
  const baseName = path.basename(sourcePath, originalExt);
  const safeName = safeFileName(`${baseName}-erdenael-${variant}-${preset.label}.jpg`);
  const finalPath = uniquePath(path.join(generatedDir, safeName));

  await runFfmpeg(ffmpegPath, [
    "-y",
    "-i",
    sourcePath,
    "-vf",
    preset.vf,
    "-frames:v",
    "1",
    "-q:v",
    quality === "max" ? "2" : "4",
    "-metadata",
    `comment=Erdenael ${preset.label} ${quality} ${cryptoRandom()}`,
    finalPath,
  ]);

  const publicName = path.basename(finalPath);
  const stat = fs.statSync(finalPath);
  sendJson(response, 200, {
    name: publicName,
    style: `${preset.label.replaceAll("-", " ")} / ffmpeg image`,
    size: stat.size,
    url: `/generated/${encodeURIComponent(publicName)}`,
  });
}

async function serveStatic(request, response, requestUrl) {
  const pathname = decodeURIComponent(requestUrl.pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let absolutePath = path.resolve(root, relativePath);

  if (!absolutePath.startsWith(root)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  if (
    !fs.existsSync(absolutePath) &&
    ["erdenael", "erdenael/instagram", "erdenael/tiktok", "instagram", "tiktok"].includes(relativePath)
  ) {
    absolutePath = path.resolve(root, "index.html");
  }

  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) {
    sendText(response, 404, "Not found");
    return;
  }

  const ext = path.extname(absolutePath).toLowerCase();
  const headers = {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  };

  if (absolutePath.startsWith(generatedDir)) {
    headers["Content-Disposition"] = `attachment; filename="${path.basename(absolutePath).replace(/"/g, "")}"`;
  }

  response.writeHead(200, headers);

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  fs.createReadStream(absolutePath).pipe(response);
}

function safeFileName(name) {
  const ext = path.extname(name).slice(0, 12) || ".webm";
  const base = path.basename(name, path.extname(name));
  const cleanBase = base
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
  return `${cleanBase || "erdenael-export"}${ext}`;
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  let index = 2;
  let candidate = `${base}-${index}${ext}`;
  while (fs.existsSync(candidate)) {
    index += 1;
    candidate = `${base}-${index}${ext}`;
  }
  return candidate;
}

function uniqueDownloadPath(filePath) {
  return uniquePath(filePath);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, text) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(text);
}

function cryptoRandom() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function videoPreset(variant, quality) {
  const high = quality === "max";
  const presets = [
    {
      label: "soft-grade",
      fps: 24,
      crf: high ? 20 : 26,
      audioBitrate: high ? "160k" : "112k",
      vf: "crop=trunc(iw*0.976/2)*2:trunc(ih*0.976/2)*2,scale=trunc(iw*0.92/2)*2:trunc(ih*0.92/2)*2,eq=contrast=1.05:saturation=0.94:brightness=0.02,noise=alls=2:allf=t+u",
    },
    {
      label: "clean-hd",
      fps: 30,
      crf: high ? 18 : 23,
      audioBitrate: high ? "192k" : "128k",
      vf: "crop=trunc(iw*0.964/2)*2:trunc(ih*0.964/2)*2,scale=trunc(iw*1.00/2)*2:trunc(ih*1.00/2)*2,eq=contrast=1.12:saturation=1.08:brightness=0.01,unsharp=3:3:0.35",
    },
    {
      label: "warm-cut",
      fps: 25,
      crf: high ? 21 : 27,
      audioBitrate: high ? "160k" : "112k",
      vf: "crop=trunc(iw*0.952/2)*2:trunc(ih*0.952/2)*2,scale=trunc(iw*0.88/2)*2:trunc(ih*0.88/2)*2,colorbalance=rs=0.04:gs=0.015:bs=-0.025,eq=contrast=1.08:saturation=1.16",
    },
    {
      label: "cool-cut",
      fps: 30,
      crf: high ? 22 : 28,
      audioBitrate: high ? "160k" : "96k",
      vf: "crop=trunc(iw*0.940/2)*2:trunc(ih*0.940/2)*2,scale=trunc(iw*0.86/2)*2:trunc(ih*0.86/2)*2,colorbalance=rs=-0.025:gs=0.005:bs=0.04,eq=contrast=1.1:saturation=1.1",
    },
    {
      label: "cinema-lite",
      fps: 24,
      crf: high ? 19 : 24,
      audioBitrate: high ? "192k" : "128k",
      vf: "crop=trunc(iw*0.964/2)*2:trunc(ih*0.964/2)*2,scale=trunc(iw*0.94/2)*2:trunc(ih*0.94/2)*2,eq=contrast=1.2:saturation=0.84:brightness=-0.015,vignette=PI/7",
    },
  ];
  return presets[(Math.max(1, variant) - 1) % presets.length];
}

async function transcodeVideoFile(ffmpegPath, inputPath, rawName, variant, quality) {
  const originalExt = path.extname(rawName) || ".mp4";
  const baseName = path.basename(rawName, originalExt);
  const preset = videoPreset(variant, quality);
  const safeName = safeFileName(`${baseName}-erdenael-${variant}-${preset.label}.mp4`);
  const finalPath = uniquePath(path.join(generatedDir, safeName));

  await runFfmpeg(ffmpegPath, [
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-vf",
    preset.vf,
    "-r",
    String(preset.fps),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(preset.crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    preset.audioBitrate,
    "-movflags",
    "+faststart",
    "-metadata",
    `comment=Erdenael ${preset.label} ${quality} ${cryptoRandom()}`,
    finalPath,
  ]);

  const publicName = path.basename(finalPath);
  const stat = fs.statSync(finalPath);
  return {
    name: publicName,
    style: `${preset.label.replaceAll("-", " ")} / ${preset.fps} fps / crf ${preset.crf}`,
    size: stat.size,
    url: `/generated/${encodeURIComponent(publicName)}`,
  };
}

function imagePreset(variant, quality) {
  const high = quality === "max";
  const presets = [
    { label: "naturel", vf: `scale='min(iw,${high ? 2200 : 1400})':-2,eq=contrast=1.04:saturation=1.08:brightness=0.01,noise=alls=1:allf=t+u` },
    { label: "studio", vf: `scale='min(iw,${high ? 2200 : 1400})':-2,eq=contrast=1.12:saturation=0.95:brightness=0.03` },
    { label: "corail", vf: `scale='min(iw,${high ? 2200 : 1400})':-2,colorbalance=rs=0.04:gs=0.01:bs=-0.02,eq=contrast=1.08:saturation=1.22` },
    { label: "ocean", vf: `scale='min(iw,${high ? 2200 : 1400})':-2,colorbalance=rs=-0.03:gs=0.01:bs=0.04,eq=contrast=1.08:saturation=1.16` },
    { label: "cinema", vf: `scale='min(iw,${high ? 2200 : 1400})':-2,eq=contrast=1.18:saturation=0.86:brightness=-0.01,vignette=PI/8` },
  ];
  return presets[(Math.max(1, variant) - 1) % presets.length];
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error("Payload trop grand");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeInstagramUrl(value) {
  const parsed = new URL(value);
  if (/\.mp4(?:[?#]|$)/i.test(parsed.href)) {
    return parsed.toString();
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (host !== "instagram.com") {
    throw new Error("Lien Instagram invalide");
  }
  if (!/^\/(p|reel|reels|tv|stories|s)\//.test(parsed.pathname)) {
    throw new Error("Type de lien Instagram non pris en charge");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function fetchInstagramMedia(pageUrl) {
  if (/\.mp4(?:[?#]|$)/i.test(pageUrl)) {
    return downloadResolvedInstagramMedia(pageUrl, pageUrl, true);
  }

  const resolved = await fetchInstagramMediaViaPublicResolvers(pageUrl);
  if (resolved) return resolved;

  throw new Error("Video MP4 introuvable. Instagram ne l'expose pas publiquement pour ce lien.");
}

async function fetchInstagramMediaViaPublicResolvers(pageUrl) {
  const candidates = instagramResolverUrls(pageUrl);
  const errors = [];

  for (const candidateUrl of candidates) {
    try {
      const imported = await fetchMediaFromHtmlPage(candidateUrl, pageUrl);
      if (imported) return imported;
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (errors.length) {
    throw new Error(`Video introuvable. Details: ${errors.slice(0, 4).join(" / ")}`);
  }

  return null;
}

function instagramResolverUrls(pageUrl) {
  const parsed = new URL(pageUrl);
  const pathAndSearch = `${parsed.pathname}${parsed.search}`;
  const hosts = [
    "www.instagram.com",
    "ddinstagram.com",
    "www.ddinstagram.com",
    "d.ddinstagram.com",
    "vxinstagram.com",
    "www.vxinstagram.com",
    "kkinstagram.com",
    "www.kkinstagram.com",
  ];
  const urls = hosts.map((host) => `https://${host}${pathAndSearch}`);
  return [...new Set(urls)];
}

async function fetchMediaFromHtmlPage(candidateUrl, pageUrl) {
  const pageResponse = await fetch(candidateUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    },
  });

  if (!pageResponse.ok) {
    throw new Error(`Page refusee (${pageResponse.status})`);
  }

  const html = await pageResponse.text();
  const videoUrl =
    extractMeta(html, "og:video") ||
    extractMeta(html, "og:video:url") ||
    extractMeta(html, "og:video:secure_url") ||
    extractInstagramVideoUrlFromHtml(html);

  if (!videoUrl) {
    throw new Error("Video introuvable sur cette page");
  }

  return downloadResolvedInstagramMedia(videoUrl, pageUrl, true);
}

async function downloadResolvedInstagramMedia(mediaUrl, pageUrl, forceVideo) {
  const mediaResponse = await fetch(mediaUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36",
      Referer: pageUrl,
    },
  });

  if (!mediaResponse.ok) {
    throw new Error(`Media inaccessible (${mediaResponse.status})`);
  }

  const contentType = mediaResponse.headers.get("content-type") || "";
  const isVideo = contentType.startsWith("video") || /\.mp4(?:[?#]|$)/i.test(mediaUrl);
  if (forceVideo && !isVideo) {
    throw new Error("Le lien Instagram a renvoye une image de preview, pas une video MP4.");
  }
  const ext = extensionForContentType(contentType, isVideo);
  const shortcode = instagramCode(pageUrl);
  const serverName = safeFileName(`instagram-${shortcode}-${Date.now()}${ext}`);
  const finalPath = uniquePath(path.join(importsDir, serverName));
  const arrayBuffer = await mediaResponse.arrayBuffer();
  fs.writeFileSync(finalPath, Buffer.from(arrayBuffer));
  const stat = fs.statSync(finalPath);

  return {
    type: "video/mp4",
    name: serverName,
    serverName: path.basename(finalPath),
    size: stat.size,
    url: `/imports/${encodeURIComponent(path.basename(finalPath))}`,
  };
}

async function fetchInstagramMediaViaHiker(pageUrl, hikerKey) {
  const apiUrl = new URL("https://api.hikerapi.com/v2/media/info/by/url");
  apiUrl.searchParams.set("url", pageUrl);
  const response = await fetch(apiUrl, {
    headers: {
      "x-access-key": hikerKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`HikerAPI a refuse le lien (${response.status})`);
  }

  const payload = await response.json();
  const media = pickHikerMedia(payload);
  if (!media?.url) {
    throw new Error("HikerAPI n'a pas renvoye de media telechargeable");
  }

  const mediaResponse = await fetch(media.url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36",
      Referer: pageUrl,
    },
  });

  if (!mediaResponse.ok) {
    throw new Error(`Media HikerAPI inaccessible (${mediaResponse.status})`);
  }

  const contentType = mediaResponse.headers.get("content-type") || media.type;
  const isVideo = media.type.startsWith("video") || contentType.startsWith("video");
  const ext = extensionForContentType(contentType, isVideo);
  const shortcode = instagramCode(pageUrl);
  const serverName = safeFileName(`instagram-${shortcode}-${Date.now()}${ext}`);
  const finalPath = uniquePath(path.join(importsDir, serverName));
  const arrayBuffer = await mediaResponse.arrayBuffer();
  fs.writeFileSync(finalPath, Buffer.from(arrayBuffer));
  const stat = fs.statSync(finalPath);

  return {
    type: isVideo ? "video/mp4" : "image/jpeg",
    name: serverName,
    serverName: path.basename(finalPath),
    size: stat.size,
    url: `/imports/${encodeURIComponent(path.basename(finalPath))}`,
  };
}

function pickHikerMedia(payload) {
  const candidates = [];
  collectHikerUrls(payload, candidates);
  const video = candidates.find((item) => item.type.startsWith("video"));
  return video || candidates[0] || null;
}

function collectHikerUrls(value, out) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectHikerUrls(item, out));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /^https?:\/\//.test(child)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("video")) out.push({ url: child, type: "video/mp4" });
      if (lowerKey.includes("image") || lowerKey.includes("thumbnail") || lowerKey === "url") {
        out.push({ url: child, type: "image/jpeg" });
      }
    } else {
      collectHikerUrls(child, out);
    }
  }
}

function getHikerKey() {
  if (process.env.HIKERAPI_KEY) return process.env.HIKERAPI_KEY;
  try {
    if (!fs.existsSync(configPath)) return "";
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return String(config.hikerApiKey || "").trim();
  } catch {
    return "";
  }
}

function extractMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

function extractInstagramVideoUrlFromHtml(html) {
  const readable = decodeHtml(html)
    .replaceAll("\\u0026", "&")
    .replaceAll("\\/", "/")
    .replaceAll("\\u003d", "=");

  const fieldPatterns = [
    /"video_url"\s*:\s*"([^"]+)"/i,
    /"playable_url"\s*:\s*"([^"]+)"/i,
    /"playable_url_quality_hd"\s*:\s*"([^"]+)"/i,
    /"src"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
  ];

  for (const pattern of fieldPatterns) {
    const match = readable.match(pattern);
    if (match?.[1]) {
      const candidate = cleanupMediaUrl(match[1]);
      if (/\.mp4(?:[?#]|$)/i.test(candidate)) return candidate;
    }
  }

  const matches = readable.match(/https?:\/\/[^"'<>\\\s]+/g) || [];
  const urls = matches
    .map(cleanupMediaUrl)
    .filter((url) => /(?:cdninstagram|fbcdn|instagram)\.com/i.test(url));

  return urls.find((url) => /\.mp4(?:[?#]|$)/i.test(url)) || "";
}

function cleanupMediaUrl(value) {
  return decodeHtml(value)
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\\u003d/g, "=")
    .replace(/\\u0025/g, "%");
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function instagramCode(pageUrl) {
  const parsed = new URL(pageUrl);
  const part = parsed.pathname.split("/").filter(Boolean).at(1) || cryptoRandom();
  return part.replace(/[^\w.-]/g, "").slice(0, 32) || cryptoRandom();
}

function extensionForContentType(contentType, isVideo) {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("quicktime")) return ".mov";
  if (contentType.includes("webm")) return ".webm";
  return isVideo ? ".mp4" : ".jpg";
}

function resolveImportFile(name) {
  if (!name) return "";
  const sourcePath = path.resolve(importsDir, path.basename(name));
  if (!sourcePath.startsWith(importsDir) || !fs.existsSync(sourcePath)) return "";
  return sourcePath;
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`FFmpeg a echoue (${code}): ${stderr}`));
    });
  });
}

function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(
      process.env.LOCALAPPDATA || "",
      "Microsoft",
      "WinGet",
      "Packages",
      "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
      "ffmpeg-8.1.1-full_build",
      "bin",
      "ffmpeg.exe",
    ),
    "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
    path.join(process.env.USERPROFILE || "", "scoop", "shims", "ffmpeg.exe"),
    "ffmpeg",
  ].filter(Boolean);

  return candidates.find((candidate) => {
    if (candidate === "ffmpeg") return true;
    return fs.existsSync(candidate);
  });
}

function downloadToPc(response, requestUrl) {
  const rawName = requestUrl.searchParams.get("name") || "";
  const sourcePath = path.resolve(generatedDir, path.basename(rawName));

  if (!sourcePath.startsWith(generatedDir) || !fs.existsSync(sourcePath)) {
    response.writeHead(302, { Location: "/exports?error=missing" });
    response.end();
    return;
  }

  fs.mkdirSync(downloadsDir, { recursive: true });
  const targetPath = uniqueDownloadPath(path.join(downloadsDir, path.basename(sourcePath)));
  fs.copyFileSync(sourcePath, targetPath);

  response.writeHead(302, {
    Location: `/exports?downloaded=${encodeURIComponent(path.basename(targetPath))}`,
  });
  response.end();
}

function serveExportsPage(response, requestUrl) {
  const downloaded = requestUrl.searchParams.get("downloaded");
  const error = requestUrl.searchParams.get("error");
  const files = fs
    .readdirSync(generatedDir)
    .filter((name) => !name.endsWith(".tmp"))
    .map((name) => {
      const stat = fs.statSync(path.join(generatedDir, name));
      return { name, size: stat.size, modified: stat.mtimeMs };
    })
    .sort((a, b) => b.modified - a.modified);

  const rows = files.length
    ? files
        .map((file) => {
          const encoded = encodeURIComponent(file.name);
          return `<article><div><strong>${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)}</span><a class="small-link" href="/generated/${encoded}" download>Lien navigateur</a></div><a class="button" href="/download?name=${encoded}">Telecharger</a></article>`;
        })
        .join("")
    : "<p>Aucun export pour le moment.</p>";

  const notice = downloaded
    ? `<div class="notice">Fichier ajoute dans ton dossier Telechargements : <strong>${escapeHtml(downloaded)}</strong></div>`
    : error
      ? `<div class="notice error">Fichier introuvable. Regenere la video puis reessaie.</div>`
      : "";

  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Erdenael - exports</title>
  <style>
    :root{--text:#ffecc4;--muted:#d2b884;--line:#8c5528;--ink:#090605;--gold:#f5c45a;--gold-light:#ffe6a0;--gold-dark:#8d531f;--cyan:#55e0dc;--red:#f07b62}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;color:var(--text);font-family:"Trebuchet MS","Segoe UI",system-ui,sans-serif;padding:32px;background:linear-gradient(180deg,rgba(14,8,6,.12),rgba(14,8,6,.82)),url("/assets/erdenael-inventory-satchel-bg.png") center top/cover fixed no-repeat,#100b09}
    main{max-width:760px;margin:auto}
    h1{margin:0 0 18px;color:var(--gold);font-family:Impact,"Arial Black",sans-serif;text-transform:uppercase;letter-spacing:.035em;font-size:clamp(2.7rem,8vw,4.2rem);line-height:.9;text-shadow:0 5px 0 var(--gold-dark),0 12px 18px rgba(0,0,0,.5)}
    article{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;border:2px solid var(--line);border-radius:9px;background:linear-gradient(90deg,rgba(255,230,160,.05) 0 1px,transparent 1px 44px),linear-gradient(180deg,rgba(62,31,16,.96),rgba(40,20,12,.92));box-shadow:0 0 0 1px var(--ink),5px 5px 0 rgba(0,0,0,.38);padding:14px;margin:12px 0}
    strong{display:block;overflow:hidden;color:#fff7dd;text-overflow:ellipsis;white-space:nowrap;font-weight:900}
    span,p{color:var(--muted);font-size:13px;font-weight:700}
    .button{display:inline-flex;align-items:center;justify-content:center;border:2px solid var(--gold-light);border-radius:5px;background:linear-gradient(180deg,var(--gold-light),var(--gold));box-shadow:inset 0 -4px 0 var(--gold-dark),4px 4px 0 rgba(0,0,0,.5);color:#211305;text-decoration:none;text-transform:uppercase;letter-spacing:.055em;font-size:11px;font-weight:900;padding:10px 14px;white-space:nowrap}
    .small-link{display:block;width:fit-content;margin-top:7px;color:var(--cyan);font-size:12px;font-weight:900}
    .notice{border:2px solid var(--line);border-radius:9px;background:rgba(40,20,12,.92);box-shadow:0 0 0 1px var(--ink),5px 5px 0 rgba(0,0,0,.35);padding:12px 14px;margin:12px 0 18px;color:var(--text)}
    .notice.error{border-color:rgba(255,123,111,.75);background:rgba(58,21,27,.9)}
    @media(max-width:640px){body{padding:18px}article{grid-template-columns:1fr}.button{width:100%}}
  </style>
</head>
<body><main><h1>Erdenael sacoche</h1>${notice}${rows}</main></body>
</html>`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}
