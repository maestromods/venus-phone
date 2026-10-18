// Shared by the browser and server. Only canonical YouTube video URLs leave this parser.
export function youtubeLinks(text) {
  const found = new Map();
  for (const match of String(text).matchAll(/(?:https?:\/\/|www\.|(?:m\.)?youtube\.com\/|youtu\.be\/)[^\s<>"']+/gi)) {
    try {
      const raw = match[0].replace(/[)\],.!;:]+$/, "");
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) continue;
      const parts = url.pathname.split("/").filter(Boolean);
      const host = url.hostname.toLowerCase();
      let id;
      if (host === "youtu.be") id = parts.length === 1 ? parts[0] : undefined;
      else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "www.youtube-nocookie.com"].includes(host)) {
        if (url.pathname === "/watch") id = url.searchParams.get("v");
        else if (parts.length === 2 && ["shorts", "embed", "live"].includes(parts[0])) id = parts[1];
      }
      if (!id || !/^[\w-]{11}$/.test(id) || found.has(id)) continue;
      const start = url.searchParams.get("t") ?? url.searchParams.get("start") ?? url.hash.replace(/^#t=/, "");
      const time = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(start);
      const startSeconds = time ? Math.min(86400, Number(time[1] || 0) * 3600 + Number(time[2] || 0) * 60 + Number(time[3] || 0)) : 0;
      found.set(id, { id, url: `https://www.youtube.com/watch?v=${id}`, startSeconds });
    } catch { /* Ordinary or malformed links stay plain text. */ }
  }
  return [...found.values()];
}
