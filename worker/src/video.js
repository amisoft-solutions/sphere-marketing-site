import { verifyVideoToken } from "./video-token.js";
import { srtToVtt } from "./srt.js";

const VIDEO_KEY = "SPHERE_Executive_Overview.mp4";
const CAPTION_KEY = "SPHERE_Executive_Overview.srt";
const INVALID_MESSAGE = "This link has expired or is invalid. Please contact the SPHERE team.";

export async function handleVideo(request, env) {
  try {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return invalidPage(404);
    const captions = url.pathname.match(/^\/v\/([^/]+)\/captions\.vtt$/);
    const media = url.pathname.match(/^\/v\/([^/]+)\/video$/);
    const page = url.pathname.match(/^\/v\/([^/]+)$/);
    const token = (captions || media || page || [])[1];
    if (!token) return invalidPage(404);
    const access = await authorizeVideo(env, token);
    if (!access.ok) return invalidPage(access.reason === "expired" || access.reason === "revoked" ? 410 : 404);
    if (captions) return await serveCaptions(request, env);
    if (media) return await serveVideo(request, env);
    return playerPage(token);
  } catch (err) {
    console.error("video request failed", err && err.message);
    return unavailable(request);
  }
}

async function authorizeVideo(env, token) {
  let decoded = token;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const checked = await verifyVideoToken(env && env.VIDEO_LINK_SECRET, decoded);
  if (!checked.ok) return checked;
  if (!env || !env.DB) return { ok: false, reason: "revoked" };
  const row = await env.DB.prepare(
    "SELECT status, video_link_expires_at FROM demo_requests WHERE id = ?"
  ).bind(checked.id).first();
  if (!row || row.status !== "approved" || !row.video_link_expires_at) {
    return { ok: false, reason: "revoked" };
  }
  const storedEpoch = Math.floor(Date.parse(row.video_link_expires_at) / 1000);
  if (storedEpoch !== checked.expiry) return { ok: false, reason: "revoked" };
  return checked;
}

function playerPage(token) {
  const safeToken = encodeURIComponent(token);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>SPHERE Executive Overview</title>
  <style>
    body { margin: 0; font: 16px/1.5 "Segoe UI", system-ui, sans-serif; background: #0A3D6F; color: #fff; }
    main { max-width: 960px; margin: 0 auto; padding: 32px 20px 48px; }
    h1 { font-size: 1.8rem; font-weight: 700; letter-spacing: -0.02em; }
    video { width: 100%; background: #041828; border-radius: 12px; }
  </style>
</head>
<body>
  <main>
    <h1>SPHERE Executive Overview</h1>
    <video controls preload="metadata">
      <source src="/v/${safeToken}/video" type="video/mp4" />
      <track kind="captions" src="/v/${safeToken}/captions.vtt" srclang="en" label="English" default />
    </video>
  </main>
</body>
</html>`;
  return new Response(html, { status: 200, headers: pageHeaders("text/html; charset=utf-8") });
}

async function serveCaptions(request, env) {
  const object = await env.VIDEO_BUCKET.get(CAPTION_KEY);
  if (!object) return unavailable(request);
  const vtt = srtToVtt(await object.text());
  const bytes = new TextEncoder().encode(vtt);
  return new Response(request.method === "HEAD" ? null : bytes, {
    status: 200,
    headers: mediaHeaders("text/vtt; charset=utf-8", bytes.length),
  });
}

async function serveVideo(request, env) {
  const head = await env.VIDEO_BUCKET.head(VIDEO_KEY);
  if (!head) return unavailable(request);
  const size = Number(head.size);
  const range = parseByteRange(request.headers.get("Range"), size);
  if (!range.ok) {
    return new Response(request.method === "HEAD" ? null : "Range not satisfiable", {
      status: 416,
      headers: mediaHeaders("text/plain; charset=utf-8", undefined, `bytes */${size}`),
    });
  }
  const object = await env.VIDEO_BUCKET.get(
    VIDEO_KEY,
    range.full ? undefined : { range: { offset: range.offset, length: range.length } }
  );
  if (!object) return unavailable(request);
  const headers = mediaHeaders("video/mp4");
  if (range.full) {
    headers["Content-Length"] = String(size);
    return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
  }
  headers["Content-Length"] = String(range.length);
  headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
}

export function parseByteRange(header, size) {
  if (!header) return { ok: true, full: true };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === "" && match[2] === "") || size < 1) return { ok: false };
  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return { ok: false };
    start = suffix >= size ? 0 : size - suffix;
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
      return { ok: false };
    }
    if (end >= size) end = size - 1;
  }
  return { ok: true, full: false, offset: start, length: end - start + 1, start, end };
}

function invalidPage(status) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>SPHERE</title>
</head>
<body>
  <p>${INVALID_MESSAGE}</p>
</body>
</html>`;
  return new Response(html, { status, headers: pageHeaders("text/html; charset=utf-8") });
}

function unavailable(request) {
  const text = "This video is temporarily unavailable. Please try again later.";
  return new Response(request.method === "HEAD" ? null : text, {
    status: 404,
    headers: pageHeaders("text/plain; charset=utf-8"),
  });
}

function pageHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  };
}

function mediaHeaders(contentType, length, contentRange) {
  const headers = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  };
  if (length !== undefined) headers["Content-Length"] = String(length);
  if (contentRange) headers["Content-Range"] = contentRange;
  return headers;
}
