/**
 * Visible-copy punctuation rule for spheresce.com.
 *
 * Authored copy that a person can see (page text, alt and title text, descriptions,
 * form messages, admin UI, emails, and the video player) may not contain an em dash,
 * a colon, or a semicolon. Clock times and URLs are stripped before that check.
 * Code, CSS, comments, and HTTP syntax are not copy.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const COPY_ALLOWANCES = [
  {
    id: "url",
    description: "A URL shown in copy, or stored as an endpoint, keeps the https:// scheme separator.",
    pattern: /https?:\/\/[^\s<>"']+/gi,
  },
  {
    id: "clock-time",
    description: "Clock times keep their colons, including 9:00, 09:00:00, and ISO timestamps such as 2026-11-24T12:00:00.000Z.",
    pattern: /(?:\d{4}-\d{2}-\d{2}T)?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?/g,
  },
];

export const SYNTAX_EXCLUSIONS = [
  {
    id: "url-scheme",
    description: "Code compares the protocol tokens http: and https:. Those strings are not sentences.",
    test(value) {
      return /^https?:$/i.test(value.trim());
    },
  },
  {
    id: "media-type",
    description: "Content-Type values such as text/html; charset=utf-8 use a semicolon between the type and its parameters.",
    test(value) {
      return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*$/i.test(value.trim());
    },
  },
  {
    id: "content-security-policy",
    description: "A Content-Security-Policy header uses semicolons between directives.",
    test(value) {
      return /(?:^|;)\s*(?:default-src|script-src|style-src|img-src|font-src|connect-src|media-src|form-action|frame-ancestors|base-uri|object-src)\b/.test(value);
    },
  },
  {
    id: "css-media-query",
    description: "A matchMedia argument such as (prefers-reduced-motion: reduce) is a CSS media query, not a sentence.",
    test(value) {
      return /^\(\s*[a-z-]+\s*:\s*[^)]+\)$/i.test(value.trim());
    },
  },
  {
    id: "wordless-code-punctuation",
    description: "A string with no letters and no em dash is code punctuation, such as the rate-limit separator or a cookie-attribute joiner.",
    test(value) {
      const stripped = stripAllowances(decodeEntities(value));
      return !/\p{L}/u.test(stripped) && !stripped.includes("\u2014");
    },
  },
];

const COPY_META = new Set([
  "description",
  "application-name",
  "og:title",
  "og:description",
  "og:image:alt",
  "twitter:title",
  "twitter:description",
  "twitter:image:alt",
]);

const COPY_ATTRS = new Set([
  "alt",
  "title",
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "placeholder",
  "label",
]);

export function scanRepository(root) {
  const dir = root instanceof URL ? fileURLToPath(root) : root;
  const violations = [];
  for (const rel of copySourceFiles(dir)) {
    const source = readFileSync(join(dir, rel), "utf8");
    violations.push(...scanSource(rel, source));
  }
  return violations;
}

export function copySourceFiles(root) {
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git" || name === "screenshots") continue;
      const full = join(dir, name);
      const rel = relative(root, full);
      if (rel === "worker/test" || rel.startsWith("worker/test/") || rel === "worker/migrations" || rel.startsWith("worker/migrations/")) {
        continue;
      }
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (isCopySource(rel)) files.push(rel);
    }
  }
  walk(root);
  return files.sort();
}

export function isCopySource(rel) {
  if (rel.endsWith(".html") || rel.endsWith(".svg")) return true;
  if (rel.endsWith(".srt") || rel.endsWith(".vtt")) return true;
  if (rel.endsWith(".js") && !rel.includes("/")) return true;
  if (rel.startsWith("shared/") && rel.endsWith(".js")) return true;
  if (rel.startsWith("worker/src/") && rel.endsWith(".js")) return true;
  return false;
}

export function scanSource(filename, source) {
  if (/\.(html|svg)$/i.test(filename)) return scanHtml(filename, source);
  if (/\.(srt|vtt)$/i.test(filename)) {
    return violationsInText(source).map((hit) => violation(filename, source, 0, hit.char, source));
  }
  if (filename.endsWith(".js")) return scanJs(filename, source);
  return [];
}

export function scanHtml(filename, html) {
  const violations = [];
  for (const piece of extractVisiblePieces(html)) {
    for (const hit of violationsInText(piece.text)) {
      violations.push(violation(filename, html, piece.index, hit.char, piece.text));
    }
  }
  return violations;
}

export function scanJs(filename, source) {
  const violations = [];
  for (const item of extractJsStrings(source)) {
    if (isSyntaxExclusion(item.value)) continue;
    if (isHtmlFragment(item.value)) {
      for (const hit of scanHtml(filename, item.value)) {
        violations.push({ ...hit, line: lineOf(source, item.index) });
      }
      continue;
    }
    for (const hit of violationsInText(item.value)) {
      violations.push(violation(filename, source, item.index, hit.char, item.value));
    }
  }
  return violations;
}

export function violationsInText(raw) {
  const decoded = decodeEntities(String(raw));
  const stripped = stripAllowances(decoded);
  const found = [];
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === "\u2014" || ch === ":" || ch === ";") found.push({ char: ch, index: i });
  }
  if (!found.length) return [];
  if (!/\p{L}/u.test(stripped) && !found.some((item) => item.char === "\u2014")) return [];
  return found;
}

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|mdash|ndash|amp|lt|gt|quot|apos|nbsp);/gi, (entity) => {
    const body = entity.slice(1, -1);
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return entity;
      return String.fromCodePoint(code);
    }
    const named = {
      mdash: "\u2014",
      ndash: "\u2013",
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
    };
    return named[body.toLowerCase()] ?? entity;
  });
}

function stripAllowances(text) {
  let next = text;
  for (const allowance of COPY_ALLOWANCES) {
    next = next.replace(new RegExp(allowance.pattern.source, allowance.pattern.flags), " ");
  }
  return next;
}

function isSyntaxExclusion(value) {
  return SYNTAX_EXCLUSIONS.some((item) => item.test(value));
}

function isHtmlFragment(value) {
  return /<!DOCTYPE/i.test(value) || /<!--/.test(value) || /<[a-z][^>]*>/i.test(value);
}

export function extractVisiblePieces(html) {
  const pieces = [];
  const source = String(html);
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source[i] === "<") {
      const tag = readTag(source, i);
      const name = tag.name.toLowerCase();
      if (!tag.closing) collectCopyAttributes(tag, pieces);
      if (!tag.closing && !tag.selfClosing && (name === "script" || name === "style")) {
        const endTag = new RegExp(`</${name}\\s*>`, "i");
        const rest = source.slice(tag.end);
        const found = endTag.exec(rest);
        i = found ? tag.end + found.index + found[0].length : source.length;
        continue;
      }
      i = tag.end;
      continue;
    }
    const next = source.indexOf("<", i);
    const text = source.slice(i, next === -1 ? source.length : next);
    if (text.trim()) pieces.push({ text, index: i });
    i = next === -1 ? source.length : next;
  }
  return pieces;
}

function collectCopyAttributes(tag, pieces) {
  const attrs = attributes(tag.raw);
  const name = tag.name.toLowerCase();
  if (name === "meta") {
    const key = (attrs.property || attrs.name || "").toLowerCase();
    if (COPY_META.has(key) && attrs.content) pieces.push({ text: attrs.content, index: tag.start });
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (!COPY_ATTRS.has(key) || !value.trim()) continue;
    pieces.push({ text: value, index: tag.start });
  }
  if (name === "option" && attrs.value && attrs.value.trim()) {
    pieces.push({ text: attrs.value, index: tag.start });
  }
}

function readTag(source, start) {
  let i = start + 1;
  let quote = "";
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      const raw = source.slice(start, i + 1);
      const nameMatch = /^<\s*\/?\s*([a-zA-Z][\w:-]*)/.exec(raw);
      return {
        raw,
        name: nameMatch ? nameMatch[1] : "",
        closing: /^<\s*\//.test(raw),
        selfClosing: /\/\s*>$/.test(raw),
        start,
        end: i + 1,
      };
    }
  }
  return { raw: source.slice(start), name: "", closing: false, selfClosing: true, start, end: source.length };
}

function attributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? "";
  }
  return attrs;
}

export function extractJsStrings(source) {
  const strings = [];

  function startsRegex(atSlash) {
    let j = atSlash - 1;
    while (j >= 0 && /\s/.test(source[j])) j -= 1;
    if (j < 0) return true;
    const tail = source.slice(Math.max(0, j - 24), j + 1);
    if (/^https?:$/.test(tail.trim()) || tail.endsWith(":")) return false;
    return /(?:^|[^A-Za-z0-9_$])(?:return|case|throw|typeof|void|delete|await|yield|else|in|of|instanceof|do)$/.test(tail)
      || "([{:;,=!&|?~^%<>+-*".includes(source[j]);
  }

  function readRegex(from) {
    let j = from + 1;
    let inClass = false;
    while (j < source.length) {
      const ch = source[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "[" && !inClass) inClass = true;
      else if (ch === "]" && inClass) inClass = false;
      else if (ch === "/" && !inClass) {
        j += 1;
        while (j < source.length && /[a-z]/i.test(source[j])) j += 1;
        return j;
      } else if (ch === "\n") return from + 1;
      j += 1;
    }
    return Math.min(source.length, from + 1);
  }

  function unescape(next) {
    if (next === "n") return "\n";
    if (next === "r") return "\r";
    if (next === "t") return "\t";
    return next;
  }

  function readQuoted(from, quote) {
    let j = from + 1;
    let value = "";
    while (j < source.length) {
      const ch = source[j];
      if (ch === "\\") {
        value += unescape(source[j + 1] || "");
        j += 2;
        continue;
      }
      if (ch === quote) return { value, end: j + 1 };
      if (ch === "\n") return { value, end: j };
      value += ch;
      j += 1;
    }
    return { value, end: j };
  }

  function readTemplate(from) {
    let j = from + 1;
    let current = "";
    const parts = [];
    while (j < source.length) {
      const ch = source[j];
      if (ch === "\\") {
        current += unescape(source[j + 1] || "");
        j += 2;
        continue;
      }
      if (ch === "`") {
        parts.push(current);
        return { value: parts.join(""), end: j + 1 };
      }
      if (ch === "$" && source[j + 1] === "{") {
        parts.push(current);
        current = "";
        j = scanCode(j + 2, true);
        parts.push(" ");
        continue;
      }
      current += ch;
      j += 1;
    }
    parts.push(current);
    return { value: parts.join(""), end: j };
  }

  function scanCode(from, stopAtBrace) {
    let i = from;
    let depth = stopAtBrace ? 1 : 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "/" && source[i + 1] === "/") {
        const nl = source.indexOf("\n", i);
        i = nl === -1 ? source.length : nl + 1;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? source.length : end + 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const parsed = readQuoted(i, ch);
        strings.push({ value: parsed.value, index: i });
        i = parsed.end;
        continue;
      }
      if (ch === "`") {
        const parsed = readTemplate(i);
        strings.push({ value: parsed.value, index: i });
        i = parsed.end;
        continue;
      }
      if (ch === "/" && startsRegex(i)) {
        const next = readRegex(i);
        i = next > i ? next : i + 1;
        continue;
      }
      if (stopAtBrace && ch === "{") depth += 1;
      if (stopAtBrace && ch === "}") {
        depth -= 1;
        i += 1;
        if (depth === 0) return i;
        continue;
      }
      i += 1;
    }
    return i;
  }

  scanCode(0, false);
  return strings;
}

function violation(file, source, index, mark, text) {
  return {
    file,
    line: lineOf(source, index),
    mark,
    text: text.replace(/\s+/g, " ").trim().slice(0, 220),
  };
}

function lineOf(source, index) {
  let line = 1;
  const end = Math.min(index, source.length);
  for (let i = 0; i < end; i += 1) if (source[i] === "\n") line += 1;
  return line;
}
