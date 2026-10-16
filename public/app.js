// Bunnyboard phone client. Plain DOM, no build step. All text from the server is set with
// textContent, never innerHTML.

const $ = (id) => document.getElementById(id);

// ---- Theme (per device) ---------------------------------------------------------------------------

const THEMES = ["system", "bunnyboard", "midnight", "oled", "light"];
const ACCENTS = ["pink", "purple", "blue", "teal", "green", "orange", "red"];
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function savedLook() {
  const theme = localStorage.getItem("vphone.theme");
  const accent = localStorage.getItem("vphone.accent");
  return { theme: THEMES.includes(theme) ? theme : "bunnyboard", accent: ACCENTS.includes(accent) ? accent : "pink" };
}

function applyLook() {
  const { theme, accent } = savedLook();
  const resolved = theme === "system" ? (darkQuery.matches ? "bunnyboard" : "light") : theme;
  const root = document.documentElement;
  if (resolved === "bunnyboard") root.removeAttribute("data-theme");
  else root.dataset.theme = resolved;
  root.dataset.accent = accent;
  applyDesk();
  // The phone's status bar / browser chrome follows the app background.
  const bg = getComputedStyle(root).getPropertyValue("--panel").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg || "#1b1430");
}
const DESKS = ["none", "sunset", "ocean", "aurora", "rose", "graphite", "image"];

function savedDesk() {
  const desk = localStorage.getItem("vphone.desk");
  return DESKS.includes(desk) ? desk : "none";
}

function applyDesk() {
  const root = document.documentElement;
  const desk = savedDesk();
  const image = localStorage.getItem("vphone.deskImage");
  root.style.removeProperty("--desk-bg");
  if (desk === "none" || (desk === "image" && !image)) {
    delete root.dataset.desk;
    return;
  }
  root.dataset.desk = desk;
  if (desk === "image") root.style.setProperty("--desk-bg", `url("${image}") center / cover no-repeat fixed`);
}

/** Shrinks a picked picture to a JPEG small enough to keep on this device. */
async function prepareDeskImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("That picture couldn't be opened."));
      image.src = url;
    });
    const scale = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally {
    URL.revokeObjectURL(url);
  }
}

applyLook();
darkQuery.addEventListener("change", applyLook);
const views = ["lock", "folder", "pick", "contacts", "thread", "settings"];
let current = "lock";
let settingsReturn = "contacts";
let openCharId = null;
let pollTimer = null;
let lastRenderKey = "";

async function api(path, options = {}) {
  const init = { method: options.method ?? "GET", headers: {}, credentials: "same-origin" };
  if (options.body !== undefined) {
    init.method = options.method ?? "POST";
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  let data = {};
  try {
    data = await response.json();
  } catch {
    // Non-JSON error page.
  }
  if (response.status === 401 && path !== "/api/login" && path !== "/api/pin") {
    show("lock");
    throw new Error(data.error ?? "Locked.");
  }
  if (!response.ok) {
    const error = new Error(data.error ?? `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function show(name) {
  current = name;
  for (const v of views) $(`view-${v}`).hidden = v !== name;
  document.body.classList.toggle("in-thread", name === "thread");
  window.scrollTo(0, 0);
  if (typeof fitViewport === "function") fitViewport();
  if (name !== "thread") {
    stopPolling();
    profileClicks = [];
  }
  const heading = $(`view-${name}`).querySelector("h1");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

// ---- Start-up --------------------------------------------------------------------------------

async function boot() {
  const status = await api("/api/status");
  if (!status.authed) return show("lock");
  if (!status.gameReady) return openFolder("");
  if (!status.session) return openPicker();
  if (!status.hasKey) {
    settingsReturn = "contacts";
    await openSettings();
    if (!$("settings-status").textContent) $("settings-status").textContent = "Add an API key to start texting.";
    return;
  }
  return openContacts();
}

$("lock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("lock-error").textContent = "";
  try {
    await api("/api/login", { body: { pin: $("pin").value } });
    $("pin").value = "";
    await boot();
  } catch (err) {
    $("lock-error").textContent = err.message;
  }
});

// ---- Game folder picker --------------------------------------------------------------------------

async function openFolder(path) {
  show("folder");
  $("folder-error").textContent = "";
  const list = $("folder-list");
  list.replaceChildren(el("li", { class: "hint", text: "Loading…" }));
  try {
    const data = await api(`/api/browse?path=${encodeURIComponent(path)}`);
    $("folder-path").textContent = data.path ? data.path : "Start somewhere:";
    $("folder-input").value = data.path;
    const use = $("folder-use");
    use.hidden = !data.gameDir;
    use.onclick = () => useFolder(data.gameDir);
    if (data.gameDir) use.textContent = `Use this folder (${data.gameDir})`;
    list.replaceChildren();
    if (data.parent !== null) {
      list.append(el("li", {}, el("button", { type: "button", class: "item", onclick: () => openFolder(data.parent) }, el("span", { class: "name", text: "⬆ Up one folder" }))));
    }
    for (const f of data.folders) {
      list.append(el("li", {}, el("button", { type: "button", class: "item", onclick: () => openFolder(f.path) }, el("span", { class: "name", text: `📁 ${f.name}` }))));
    }
    if (data.path && data.folders.length === 0) list.append(el("li", { class: "hint", text: "No folders in here." }));
  } catch (err) {
    list.replaceChildren();
    $("folder-error").textContent = err.message;
  }
}

async function useFolder(gameDir) {
  $("folder-error").textContent = "";
  try {
    await api("/api/settings", { body: { gameDir } });
    await boot();
  } catch (err) {
    $("folder-error").textContent = err.message;
  }
}

$("folder-type").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("folder-input").value.trim();
  if (value) useFolder(value);
});

// ---- Save picker ------------------------------------------------------------------------------

const KIND_LABEL = { autosave: "Autosave", slot: "Slot save", manual: "Manual save" };

async function openPicker() {
  show("pick");
  const list = $("pick-list");
  list.replaceChildren(el("p", { class: "hint", text: "Loading saves…" }));
  try {
    const { playthroughs } = await api("/api/playthroughs");
    list.replaceChildren();
    if (playthroughs.length === 0) {
      list.append(el("p", { class: "hint", text: "No saves found. Check the game folder in Settings." }));
      return;
    }
    for (const p of playthroughs) {
      const saves = el("div", { class: "saves" });
      for (const s of p.saves) {
        const real = new Date(s.saveDate).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
        saves.append(
          el(
            "button",
            { type: "button", onclick: () => choose(p.playthroughId, s.saveId) },
            el("span", { text: `${KIND_LABEL[s.kind]} · ${s.when}` }),
            el("span", { class: "muted", text: real }),
          ),
        );
      }
      list.append(el("section", { class: "playthrough" }, el("h2", { text: p.name ? `${p.name} — ${p.player}` : p.player }), saves));
    }
  } catch (err) {
    list.replaceChildren(el("p", { class: "error pad", role: "alert", text: err.message }));
  }
}

async function choose(playthroughId, saveId, discard = false) {
  try {
    await api("/api/session", { body: { playthroughId, saveId, discard } });
    await boot();
  } catch (err) {
    if (err.status === 409 && !discard) {
      if (confirm(`${err.message}\n\nDiscard the unsynced chats and switch saves?`)) return choose(playthroughId, saveId, true);
      return;
    }
    alert(err.message);
  }
}

// ---- Contacts ----------------------------------------------------------------------------------

async function openContacts() {
  show("contacts");
  await refreshContacts();
}

async function refreshContacts() {
  const [status, { contacts }] = await Promise.all([api("/api/status"), api("/api/contacts")]);
  const s = status.session;
  $("session-player").textContent = s ? s.player : "";
  $("session-now").textContent = s ? `${s.now}${s.unsynced ? ` · ${s.unsynced} unsynced` : ""}` : "";
  $("sync-btn").textContent = s?.unsynced ? `Sync (${s.unsynced})` : "Sync";
  const list = $("contact-list");
  list.replaceChildren();
  $("contacts-empty").hidden = contacts.length > 0;
  for (const c of contacts) {
    const preview = c.blocked ? "Blocked you" : c.lastText ? `${c.lastFromMe ? "You: " : ""}${c.lastText}` : "No messages yet";
    list.append(
      el(
        "li",
        {},
        el(
          "button",
          { type: "button", class: `item${c.unread ? " unread" : ""}`, onclick: () => openThread(c.charId) },
          el("img", { class: "avatar", src: `/api/avatar/${c.charId}`, alt: "", width: 44, height: 44, loading: "lazy" }),
          el("span", { class: "text" }, el("span", { class: "name", text: c.name }), el("span", { class: "preview", text: preview })),
          c.busy ? el("span", { class: "badge", text: "typing" }) : null,
          c.unread ? el("span", { class: "unread-badge", "aria-label": `${c.unread} unread`, text: String(c.unread) }) : null,
        ),
      ),
    );
  }
}

$("sync-btn").addEventListener("click", async () => {
  const button = $("sync-btn");
  button.disabled = true;
  $("sync-status").textContent = "Syncing…";
  try {
    const result = await api("/api/sync", { body: {} });
    $("sync-status").textContent = result.rebased
      ? `Synced ${result.messages} messages onto the game's newest save. Load save ${result.saveId} in the game.`
      : `Synced ${result.messages} messages. Load the newest slot save in the game.`;
    await refreshContacts();
  } catch (err) {
    $("sync-status").textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

// ---- Thread ---------------------------------------------------------------------------------------

// ---- Hidden profile gesture ----------------------------------------------------------------------
let profileClicks = [];
let threadBlocked = false;
let threadBusy = false;
let unblockingCharId = null;

$("thread-profile").addEventListener("click", async () => {
  if (current !== "thread" || !openCharId || !threadBlocked || threadBusy || revealing || editingMessage || unblockingCharId) {
    profileClicks = [];
    return;
  }
  const now = performance.now();
  profileClicks = profileClicks.filter((at) => now - at <= 3000);
  profileClicks.push(now);
  if (profileClicks.length < 3) return;
  profileClicks = [];
  const charId = openCharId;
  const before = new Set([...$("messages").querySelectorAll("[data-id]")].map((node) => node.dataset.id));
  unblockingCharId = charId;
  $("thread-profile").disabled = true;
  $("thread-error").textContent = "";
  $("typing").hidden = false;
  for (const button of document.querySelectorAll(".message-actions button")) button.disabled = true;
  try {
    const updated = await api(`/api/chats/${charId}/unblock`, { body: {} });
    if (current === "thread" && openCharId === charId) await revealReplies(updated, before);
  } catch (err) {
    if (current === "thread" && openCharId === charId) $("thread-error").textContent = err.message;
  } finally {
    unblockingCharId = null;
    lastRenderKey = "";
    if (current === "thread") {
      if (openCharId === charId) $("typing").hidden = true;
      await refreshThread().catch(() => {});
      $("thread-profile").disabled = threadBusy || revealing || editingMessage;
    }
  }
});

// ---- Thread loading ------------------------------------------------------------------------------
async function openThread(charId) {
  profileClicks = [];
  threadBlocked = false;
  threadBusy = false;
  $("thread-profile").disabled = true;
  if (openCharId !== charId) {
    clearAttachment();
    // A half-typed message belongs to the chat it was typed in.
    const box = $("draft");
    box.value = "";
    box.style.height = "auto";
    $("thread-error").textContent = "";
    $("incoming-panel").hidden = true;
    $("incoming-btn").setAttribute("aria-expanded", "false");
  }
  openCharId = charId;
  lastRenderKey = "";
  $("messages").replaceChildren();
  $("thread-error").textContent = "";
  $("thread-avatar").src = `/api/avatar/${charId}`;
  show("thread");
  await refreshThread(true);
}

async function refreshThread(scroll = false) {
  if (!openCharId) return;
  const charId = openCharId;
  const thread = await api(`/api/chats/${charId}`);
  if (revealing || charId !== openCharId) return;
  renderThread(thread, scroll);
  const waiting = thread.messages.some((m) => m.photo?.pending);
  if (waiting) startPolling();
  else stopPolling();
}

function renderThread(thread, scroll, held = new Set()) {
  threadBlocked = thread.blocked;
  threadBusy = thread.busy;
  const unblocking = unblockingCharId === thread.charId;
  $("thread-profile").disabled = thread.busy || revealing || editingMessage || Boolean(unblockingCharId);
  $("thread-profile").setAttribute("aria-label", `${thread.name}'s profile picture`);
  if (!thread.blocked || thread.busy) profileClicks = [];
  $("thread-title").textContent = thread.name;
  if (thread.incoming) {
    $("incoming-every").value = String(thread.incoming.everyMinutes);
    $("incoming-max").value = String(thread.incoming.maxUnanswered);
    $("incoming-btn").classList.toggle("on", thread.incoming.everyMinutes !== 0);
  }
  const composerOff = thread.blocked || unblocking;
  $("draft").disabled = composerOff;
  $("attach-btn").disabled = composerOff;
  $("composer").querySelector("button[type=submit]").disabled = composerOff;
  $("draft").placeholder = thread.blocked ? `${thread.name.split(" ")[0]} has you blocked` : "Message";

  // While she is still replying (opened mid-reply), show her typing.
  if (!revealing) $("typing").hidden = !thread.busy && !unblocking;

  const shown = thread.messages.filter((m) => !held.has(m.id));
  const key = JSON.stringify([thread.busy, revealing, editingMessage, unblocking, held.size > 0, ...shown.map((m) => [m.id, m.text, m.canRegenerate, m.photo?.pending, m.photo?.failed, m.reaction])]);
  if (key === lastRenderKey) return;
  lastRenderKey = key;

  const list = $("messages");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  list.replaceChildren();
  let stamp = null;
  for (const m of shown) {
    if (m.stamp !== stamp) {
      list.append(el("li", { class: "divider", text: m.stamp }));
      stamp = m.stamp;
    }
    if (m.sender === "system") {
      list.append(el("li", { class: "system", text: m.text, "data-id": m.id }));
      continue;
    }
    const mine = m.sender === "player";
    const side = mine ? "mine" : "theirs";
    const message = el("li", { class: `message ${side}`, "data-id": m.id });
    const bubble = el("div", { class: `bubble ${side}` });
    bubble.append(el("span", { class: "sr-only", text: mine ? "You: " : `${thread.name.split(" ")[0]}: ` }));
    if (m.text) bubble.append(document.createTextNode(m.text));
    if (m.photo) bubble.append(photoNode(thread, m));
    if (m.upload) {
      const src = `/api/upload/${thread.charId}/${m.upload.file}`;
      const alt = `Your photo: ${m.upload.scene}`;
      bubble.append(
        el(
          "button",
          { type: "button", class: "photo-btn", "aria-label": `Open photo. ${alt}`, onclick: () => viewPhoto(src, alt) },
          el("img", { class: "photo", src, alt, loading: "lazy" }),
        ),
      );
    }
    // Existing tapbacks stay visible while new replies arrive.
    if (m.reaction) {
      bubble.classList.add("reacted");
      bubble.append(el("span", { class: "reaction", "aria-label": `${thread.name.split(" ")[0]} reacted ${m.reaction}`, text: m.reaction }));
    }
    const actions = el("div", { class: "message-actions", role: "group", "aria-label": "Message actions" });
    actions.append(el("button", { type: "button", text: "Delete", disabled: thread.busy || revealing || editingMessage || unblocking, onclick: () => editMessage(thread, m, "delete") }));
    if (m.canRegenerate) actions.append(el("button", { type: "button", text: "Regenerate reply", disabled: thread.busy || revealing || editingMessage || unblocking, onclick: () => editMessage(thread, m, "regenerate") }));
    message.append(bubble, actions);
    list.append(message);
  }
  if (scroll || nearBottom) list.scrollTop = list.scrollHeight;
}

let editingMessage = false;
async function editMessage(thread, message, action) {
  if (editingMessage || revealing) return;
  if (action === "delete" && !confirm("Delete this message? It will also be removed from the next synced save. Deleting a message does not undo a block.")) return;
  const charId = thread.charId;
  editingMessage = true;
  $("thread-error").textContent = "";
  for (const button of document.querySelectorAll(".message-actions button")) button.disabled = true;
  try {
    const updated = await api(`/api/chats/${charId}/${action}`, { body: { id: message.id } });
    if (openCharId === charId) {
      lastRenderKey = "";
      renderThread(updated, false);
    }
  } catch (err) {
    if (openCharId === charId) $("thread-error").textContent = err.message;
  } finally {
    editingMessage = false;
    lastRenderKey = "";
    if (openCharId === charId) await refreshThread().catch(() => {});
  }
}

let revealing = false;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Roughly how long she'd take to type a bubble, like the game's typing pacer.
const typingDelay = (text) => Math.min(3000, 700 + text.length * 35);

/** Shows her new bubbles one at a time, with the typing dots before each. */
async function revealReplies(thread, before) {
  const fresh = thread.messages.filter((m) => !before.has(m.id) && m.sender !== "player");
  const held = new Set(fresh.map((m) => m.id));
  revealing = true;
  try {
    lastRenderKey = "";
    renderThread(thread, true, held);
    for (const m of fresh) {
      if (openCharId !== thread.charId) return;
      if (m.sender === "contact") {
        $("typing").hidden = false;
        $("messages").scrollTop = $("messages").scrollHeight;
        await wait(typingDelay(m.text));
      }
      held.delete(m.id);
      $("typing").hidden = true;
      renderThread(thread, true, held);
      if (m.sender === "contact") await wait(250);
    }
  } finally {
    revealing = false;
    $("typing").hidden = true;
    if (openCharId === thread.charId) await refreshThread().catch(() => {});
  }
  if (thread.messages.some((m) => m.photo?.pending)) startPolling();
}

function photoNode(thread, m) {
  if (m.photo.pending) return el("div", { class: "photo-wait", role: "img", "aria-label": "Photo developing" }, "Photo developing…");
  if (m.photo.failed) return el("div", { class: "photo-wait", text: "Photo didn't come through" });
  const src = `/api/photo/${thread.charId}/${m.photo.file}`;
  const alt = `Photo from ${thread.name.split(" ")[0]}: ${m.photo.scene}`;
  return el(
    "button",
    { type: "button", class: "photo-btn", "aria-label": `Open photo. ${alt}`, onclick: () => viewPhoto(src, alt) },
    el("img", { class: "photo", src, alt, loading: "lazy" }),
  );
}

function viewPhoto(src, alt) {
  const dialog = el("dialog", { class: "viewer", "aria-label": "Photo" });
  const close = el("button", { type: "button", class: "primary small", text: "Close", onclick: () => dialog.close() });
  dialog.append(close, el("img", { src, alt }));
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => refreshThread().catch(() => {}), 3000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// iOS Safari slides the page up under the keyboard instead of resizing it. Size the thread to
// the visible viewport instead, and keep the newest messages in view as it changes.
function fitViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  if (!vv) return;
  root.setProperty("--vv-height", `${Math.round(vv.height)}px`);
  root.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
  if (current === "thread") {
    const list = $("messages");
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 200) list.scrollTop = list.scrollHeight;
  }
}
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", fitViewport);
  window.visualViewport.addEventListener("scroll", fitViewport);
}
window.addEventListener("orientationchange", () => setTimeout(fitViewport, 300));
// If Safari leaves the page scrolled while the keyboard is closed, snap it back so the chat
// fills the screen again instead of sitting in a strip with blank space around it.
window.addEventListener("scroll", () => {
  if (current === "thread" && document.activeElement !== $("draft") && window.scrollY !== 0) {
    window.scrollTo(0, 0);
    fitViewport();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) fitViewport();
});
fitViewport();

const draft = $("draft");
draft.addEventListener("focus", () => setTimeout(fitViewport, 50));
draft.addEventListener("blur", () => {
  // Safari can leave the page scrolled after the keyboard closes; put it back.
  setTimeout(() => {
    window.scrollTo(0, 0);
    fitViewport();
  }, 100);
});
draft.addEventListener("input", () => {
  draft.style.height = "auto";
  draft.style.height = `${Math.min(draft.scrollHeight, 136)}px`;
});
draft.addEventListener("keydown", (event) => {
  // Enter sends on a keyboard; Shift+Enter makes a new line.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && matchMedia("(pointer: fine)").matches) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

// ---- Your photos ---------------------------------------------------------------------------------

let attached = null; // { mimeType, data, url }
const MAX_SIDE = 1600;

/** Shrinks a picked photo (HEIC included, on iPhone) to a JPEG the AI and server will take. */
async function preparePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("That photo couldn't be opened."));
      image.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("That photo couldn't be prepared.");
    const data = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.readAsDataURL(blob);
    });
    return { mimeType: "image/jpeg", data, url: URL.createObjectURL(blob) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function clearAttachment() {
  if (attached?.url) URL.revokeObjectURL(attached.url);
  attached = null;
  $("attach-input").value = "";
  $("attach-preview").hidden = true;
}

$("attach-btn").addEventListener("click", () => $("attach-input").click());
$("attach-clear").addEventListener("click", () => {
  clearAttachment();
  $("attach-btn").focus();
});
$("attach-input").addEventListener("change", async () => {
  const file = $("attach-input").files?.[0];
  if (!file) return;
  $("thread-error").textContent = "";
  try {
    clearAttachment();
    attached = await preparePhoto(file);
    $("attach-img").src = attached.url;
    $("attach-preview").hidden = false;
  } catch (err) {
    $("thread-error").textContent = err.message;
  }
});

async function saveIncoming() {
  if (!openCharId) return;
  try {
    const { incoming } = await api(`/api/chats/${openCharId}/incoming`, {
      body: { everyMinutes: Number($("incoming-every").value), maxUnanswered: Number($("incoming-max").value) },
    });
    $("incoming-btn").classList.toggle("on", incoming.everyMinutes !== 0);
  } catch (err) {
    $("thread-error").textContent = err.message;
  }
}
$("incoming-every").addEventListener("change", saveIncoming);
$("incoming-max").addEventListener("change", saveIncoming);
$("incoming-panel").addEventListener("submit", (event) => event.preventDefault());
$("incoming-btn").addEventListener("click", () => {
  const panel = $("incoming-panel");
  panel.hidden = !panel.hidden;
  $("incoming-btn").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) $("incoming-every").focus();
});

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = draft.value.trim();
  const photo = attached;
  if ((!text && !photo) || !openCharId) return;
  const charId = openCharId;
  const send = $("composer").querySelector("button[type=submit]");
  $("thread-error").textContent = "";
  send.disabled = true;
  draft.value = "";
  draft.style.height = "auto";
  $("attach-preview").hidden = true;

  // Show the text (and photo) right away while she "types".
  const list = $("messages");
  const optimistic = el("li", { class: "bubble mine" }, el("span", { class: "sr-only", text: "You: " }));
  if (text) optimistic.append(document.createTextNode(text));
  if (photo) optimistic.append(el("img", { class: "photo", src: photo.url, alt: "Your photo" }));
  list.append(optimistic);
  list.scrollTop = list.scrollHeight;
  $("typing").hidden = false;
  const before = new Set([...list.querySelectorAll("[data-id]")].map((node) => node.dataset.id));
  try {
    const body = { text, ...(photo ? { image: { mimeType: photo.mimeType, data: photo.data } } : {}) };
    const thread = await api(`/api/chats/${charId}/send`, { body });
    if (photo) clearAttachment();
    if (openCharId === charId) await revealReplies(thread, before);
  } catch (err) {
    optimistic.remove();
    draft.value = text;
    if (photo) $("attach-preview").hidden = false;
    $("thread-error").textContent = err.message;
  } finally {
    $("typing").hidden = true;
    send.disabled = false;
  }
});

// ---- Notifications (while the app is open) ---------------------------------------------------------

let noticeSince = Date.now();
let toastTimer = null;

function showToast(notice) {
  const button = $("toast-open");
  button.textContent = `${notice.name}: ${notice.text}`;
  button.onclick = () => {
    $("toast").hidden = true;
    openThread(notice.charId);
  };
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6000);
}

async function pollNotices() {
  if (current === "lock" || current === "pick" || current === "folder") return;
  try {
    const { notices, unread, now } = await api(`/api/notices?since=${noticeSince}`);
    noticeSince = now;
    document.title = unread ? `(${unread}) Bunnyboard` : "Bunnyboard";
    for (const notice of notices) {
      if (current === "thread" && openCharId === notice.charId) {
        await refreshThread(true);
        continue;
      }
      showToast(notice);
    }
    if (notices.length && current === "contacts") await refreshContacts();
  } catch {
    // Offline or locked; try again next time.
  }
}
setInterval(pollNotices, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pollNotices();
});

// ---- Settings ---------------------------------------------------------------------------------------

async function openSettings() {
  if (current !== "settings") settingsReturn = current === "thread" ? "contacts" : current;
  show("settings");
  syncLookForm();
  const s = await api("/api/settings");
  const form = $("settings-form");
  form.provider.value = s.provider;
  form.geminiModel.value = s.geminiModel;
  form.openrouterModel.value = s.openrouterModel;
  form.openrouterVisionModel.value = s.openrouterVisionModel ?? "";
  form.endpointUrl.value = s.endpointUrl;
  form.thinking.value = s.thinking;
  form.photos.checked = s.photos;
  form.explicitPhotos.checked = s.explicitPhotos;
  form.gameDir.value = s.gameDir;
  form.geminiKey.value = "";
  form.openrouterKey.value = "";
  form.geminiKey.placeholder = s.hasGeminiKey ? "Saved (type to replace)" : "Paste your key";
  form.openrouterKey.placeholder = s.hasOpenrouterKey ? "Saved (type to replace)" : "Paste your key";
  form.clearGeminiKey.checked = false;
  form.clearOpenrouterKey.checked = false;
  // Over plain HTTP from another device, keys can't be sent; say so up front.
  const remoteHttp = location.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  for (const input of [form.geminiKey, form.openrouterKey]) {
    input.disabled = remoteHttp;
    if (remoteHttp) input.placeholder = `${input.placeholder} · enter keys on the PC`;
  }
  $("settings-status").textContent = remoteHttp
    ? `API keys can only be entered at http://localhost:${location.port || 80}, typed exactly like that in a browser on the PC running the app. This page is open at ${location.hostname}, which counts as another device even on that PC.`
    : "";
  syncProviderFields();
}

function syncProviderFields() {
  const provider = $("settings-form").provider.value;
  for (const block of document.querySelectorAll("[data-for]")) block.hidden = block.dataset.for !== provider;
}

for (const radio of document.querySelectorAll('input[name="provider"]')) radio.addEventListener("change", syncProviderFields);

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $("settings-status").textContent = "Saving…";
  try {
    await api("/api/settings", {
      body: {
        provider: form.provider.value,
        geminiModel: form.geminiModel.value,
        openrouterModel: form.openrouterModel.value,
        openrouterVisionModel: form.openrouterVisionModel.value,
        endpointUrl: form.endpointUrl.value,
        thinking: form.thinking.value,
        geminiKey: form.geminiKey.value,
        openrouterKey: form.openrouterKey.value,
        clearGeminiKey: form.clearGeminiKey.checked,
        clearOpenrouterKey: form.clearOpenrouterKey.checked,
        photos: form.photos.checked,
        explicitPhotos: form.explicitPhotos.checked,
        gameDir: form.gameDir.value,
      },
    });
    await openSettings();
    $("settings-status").textContent = "Saved.";
  } catch (err) {
    $("settings-status").textContent = err.message;
  }
});

$("pin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/pin", { body: { current: $("pin-current").value, next: $("pin-next").value } });
    $("pin-status").textContent = "PIN changed. Other devices are locked out until they use the new one.";
    form.reset();
  } catch (err) {
    $("pin-status").textContent = err.message;
  }
});

function syncLookForm() {
  const { theme, accent } = savedLook();
  const form = $("appearance-form");
  form.theme.value = theme;
  for (const radio of form.querySelectorAll('input[name="accent"]')) radio.checked = radio.value === accent;
  const desk = savedDesk();
  form.deskBg.value = desk;
  $("desk-image-row").hidden = desk !== "image";
  $("desk-image-status").textContent = localStorage.getItem("vphone.deskImage") ? "Picture set." : "No picture yet.";
}
$("appearance-form").addEventListener("change", (event) => {
  const target = event.target;
  if (target.name === "theme") localStorage.setItem("vphone.theme", target.value);
  if (target.name === "accent") localStorage.setItem("vphone.accent", target.value);
  if (target.name === "deskBg") {
    localStorage.setItem("vphone.desk", target.value);
    $("desk-image-row").hidden = target.value !== "image";
    if (target.value === "image" && !localStorage.getItem("vphone.deskImage")) $("desk-image").click();
  }
  applyLook();
});
$("desk-image-btn").addEventListener("click", () => $("desk-image").click());
$("desk-image").addEventListener("change", async () => {
  const file = $("desk-image").files?.[0];
  if (!file) return;
  $("desk-image-status").textContent = "Loading…";
  try {
    const data = await prepareDeskImage(file);
    localStorage.setItem("vphone.deskImage", data);
    localStorage.setItem("vphone.desk", "image");
    $("desk-image-status").textContent = "Picture set.";
    applyLook();
  } catch (err) {
    $("desk-image-status").textContent =
      err?.name === "QuotaExceededError" ? "That picture is too big to keep on this device. Try a smaller one." : err.message;
  } finally {
    $("desk-image").value = "";
  }
});
$("appearance-form").addEventListener("submit", (event) => event.preventDefault());

$("settings-back").addEventListener("click", () => boot());
$("change-save").addEventListener("click", () => openPicker());
$("change-folder").addEventListener("click", () => openFolder($("settings-form").gameDir.value));
$("logout").addEventListener("click", async () => {
  await api("/api/logout", { body: {} }).catch(() => {});
  show("lock");
});

for (const button of document.querySelectorAll("[data-go]")) {
  button.addEventListener("click", () => {
    const target = button.dataset.go;
    if (target === "settings") openSettings();
    else if (target === "contacts") openContacts();
  });
}

boot().catch(() => show("lock"));

