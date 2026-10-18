import { youtubeLinks } from "./youtube-links.js";

let youtubeReady;
function loadYouTubePlayer() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeReady) return youtubeReady;
  youtubeReady = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = setTimeout(() => fail(), 20000);
    function fail() { clearTimeout(timeout); script.remove(); youtubeReady = null; reject(new Error("YouTube's player could not load. Check your connection or content blocker, then try again.")); }
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timeout); resolve(window.YT); };
    script.onerror = fail;
    script.src = "https://www.youtube.com/iframe_api";
    document.head.append(script);
  });
  return youtubeReady;
}

export function createWatchTogether({ api, onThread, resize }) {
  const $ = id => document.getElementById(id);
  let epoch = 0, session = null, player = null, timer = null, pending = false, closing = Promise.resolve();
  const status = text => resize(() => { $("watch-status").textContent = text; });
  function close() {
    epoch++;
    const hadSession = session || pending;
    session = null; pending = false; clearInterval(timer); timer = null;
    player?.destroy(); player = null;
    resize(() => { $("watch-panel").hidden = true; $("watch-player").replaceChildren(); });
    if (hadSession) closing = closing.then(() => api("/api/watch/end", { body: {} })).catch(() => {});
    return closing;
  }
  async function open(link, charId, name) {
    const stopped = close(), generation = epoch;
    await stopped;
    if (generation !== epoch) return;
    pending = true;
    resize(() => { $("watch-panel").hidden = false; });
    $("watch-title").textContent = `Watch with ${name.split(" ")[0]}`;
    $("watch-external").href = link.url;
    status("Reading the video… longer videos take more time and use more of your AI credits.");
    try {
      const YT = await loadYouTubePlayer();
      if (generation !== epoch) return;
      const result = await api("/api/watch/start", { body: { charId, url: link.url + (link.startSeconds ? `&t=${link.startSeconds}s` : "") } });
      if (generation !== epoch) return;
      session = result; pending = false;
      $("watch-title").textContent = result.title;
      const iframe = document.createElement("iframe");
      iframe.title = result.title;
      iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      iframe.allowFullscreen = true;
      // YouTube requires an origin referrer (error 153 without it). Override only this frame.
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      iframe.src = `https://www.youtube-nocookie.com/embed/${result.videoId}?enablejsapi=1&playsinline=1&origin=${encodeURIComponent(location.origin)}&start=${result.startSeconds}`;
      resize(() => $("watch-player").replaceChildren(iframe));
      const tick = async () => {
        if (generation !== epoch || !session || !player?.getCurrentTime) return;
        const playing = player.getPlayerState() === 1 && !document.hidden;
        try {
          const update = await api("/api/watch/tick", { body: { id: result.id, position: player.getCurrentTime(), playing } });
          if (generation !== epoch) return;
          if (update.thread) {
            onThread(update.thread);
            if (update.thread.blocked) { player.pauseVideo(); clearInterval(timer); status("She has ended the watch session."); }
          }
        } catch (err) {
          if (generation !== epoch) return;
          player?.pauseVideo(); clearInterval(timer); timer = null;
          status(err.message); session = null;
          void api("/api/watch/end", { body: {} }).catch(() => {});
        }
      };
      player = new YT.Player(iframe, { events: {
        onReady: () => {
          if (generation !== epoch) return;
          status("Press Play. She’ll comment as you watch; you can keep texting below.");
          timer = setInterval(tick, 1500);
        },
        onStateChange: event => {
          if (generation !== epoch || !session) return;
          status(event.data === 1 ? "Watching together · reactions follow your place in the video"
            : event.data === 0 ? "Video finished. You can keep talking below."
            : event.data === 3 ? "Buffering · reactions will resume with playback"
            : "Paused · her reactions are paused too");
          void tick();
        },
        onError: event => {
          if (generation !== epoch) return;
          clearInterval(timer); session = null;
          status(event.data === 101 || event.data === 150 ? "This video’s owner disabled embedding. Try another video for Watch together."
            : "YouTube couldn’t play this video here. Try another public video or check your content blocker.");
          void api("/api/watch/end", { body: {} }).catch(() => {});
        },
      } });
    } catch (err) {
      if (generation === epoch) { pending = false; status(err.message); }
    }
  }
  $("watch-close").addEventListener("click", () => void close());
  $("draft").addEventListener("focus", () => {
    if (session) player?.pauseVideo();
    resize(() => $("watch-panel").classList.add("watch-typing"));
  });
  $("draft").addEventListener("blur", () => resize(() => $("watch-panel").classList.remove("watch-typing")));
  document.addEventListener("visibilitychange", () => { if (document.hidden) player?.pauseVideo(); });
  window.addEventListener("pagehide", () => {
    if (session || pending) void fetch("/api/watch/end", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}", keepalive: true }).catch(() => {});
  });
  function cards(text, charId, name) {
    return youtubeLinks(text).slice(0, 3).map(link => {
      const card = document.createElement("div"); card.className = "youtube-card";
      const label = document.createElement("span"); label.className = "youtube-label"; label.textContent = "YouTube";
      const watch = document.createElement("button"); watch.type = "button"; watch.className = "youtube-watch"; watch.textContent = "▶ Watch together";
      watch.addEventListener("click", () => void open(link, charId, name));
      const external = document.createElement("a"); external.href = link.url; external.target = "_blank"; external.rel = "noopener noreferrer"; external.textContent = "Open on YouTube";
      card.append(label, watch, external); return card;
    });
  }
  return { cards, close };
}
