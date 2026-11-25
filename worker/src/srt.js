/** Convert an SRT caption file to WebVTT. Timestamps use a comma; VTT uses a period. */
export function srtToVtt(srt) {
  const normalized = String(srt || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const converted = normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${converted}\n`;
}
