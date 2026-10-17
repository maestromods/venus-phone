const byId = id => document.getElementById(id);
let panel, charId, name, onClose, callId = null, context, stream, capture, inputNode, silent;
let source = null, resolvePlayback = null, heartbeat, statusTimer, aborter, version = 0;
let phase = "idle", recording = [], prebuffer = [], speechFrames = 0, quietFrames = 0, previewing = false, opening = false, closing = false;
let sheet = null, keyboardVisible = true, modelsReady = false, callStarted = 0, durationTimer;
let callFullscreen = false;
let micRequest = 0, switchingInput = false, startAttempt = 0;
const status = text => { byId("voice-state").textContent = text; };
const error = text => { byId("voice-error").textContent = text; byId("voice-options-error").textContent = text; };
function enterCallFullscreen() {
  if (!charId || document.fullscreenElement || !window.matchMedia("(max-width: 700px), (pointer: coarse)").matches) return;
  // Only try after microphone permission. A fullscreen page can hide Safari's prompt.
  // Browsers requiring a fresh gesture keep the CSS edge-to-edge call layout.
  const request = document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
  void request?.then(async () => {
    callFullscreen = true;
    if (!panel.open) { callFullscreen = false; await document.exitFullscreen?.(); }
  }).catch(() => {});
}
function updateDuration(ended = false) {
  const seconds = Math.max(0, Math.floor((Date.now() - callStarted) / 1000));
  const duration = `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  byId("voice-timer").textContent = callStarted ? `${ended ? "Call ended · " : ""}${duration}` : "Ready to call";
}
function showSheet(next) {
  const previous = sheet; sheet = next;
  byId("voice-options").hidden = next !== "options";
  byId("voice-history").hidden = next !== "history";
  byId("voice-call-view").inert = !!next;
  byId("voice-options-open").setAttribute("aria-expanded", String(next === "options"));
  byId("voice-transcript-open").setAttribute("aria-expanded", String(next === "history"));
  if (next) byId(next === "options" ? "voice-options-back" : "voice-history-back").focus();
  else if (previous) byId(previous === "options" ? "voice-options-open" : "voice-transcript-open").focus();
  if (next === "history") byId("voice-transcript").scrollTop = byId("voice-transcript").scrollHeight;
}
async function request(url, body, signal) {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Voice request failed (${response.status}).`);
  return data;
}
const post = (action, data = {}, signal) => request(`/api/calls/${callId}/${action}`, data, signal);
function controls() {
  panel.dataset.phase = opening && !callId ? "calling" : phase;
  byId("voice-start").hidden = !!callId || opening || !charId;
  byId("voice-start").disabled = opening || closing || previewing || !modelsReady;
  byId("voice-end").hidden = !callId && !opening;
  byId("voice-end").disabled = closing;
  byId("voice-history-end").hidden = !callId && !opening;
  byId("voice-send").disabled = !callId || closing;
  byId("voice-interrupt").disabled = !callId || phase === "listening";
  byId("voice-choice").disabled = !!callId || opening;
  byId("voice-preview").disabled = !!callId || opening || previewing;
  byId("voice-reference").disabled = !!callId || opening;
  byId("voice-draft").disabled = !callId;
  byId("voice-form").hidden = !keyboardVisible || !charId;
  byId("voice-keyboard").setAttribute("aria-expanded", String(keyboardVisible));
  const microphone = byId("voice-mode").value === "microphone";
  byId("voice-mode").disabled = opening || closing || switchingInput;
  byId("voice-microphone").disabled = opening || closing || switchingInput;
  byId("voice-microphone").setAttribute("aria-pressed", String(microphone));
  byId("voice-mode-hint").textContent = microphone ? (stream ? "Microphone on. Pause to send." : "Start call to allow your microphone.") : "You type. She talks. Tap Microphone to speak instead.";
  byId("voice-mic-level").hidden = !stream;
  byId("voice-connection-help").hidden = window.isSecureContext;
}
function addLine(who, text) {
  const entry = document.createElement("p");
  const label = document.createElement("strong"); label.textContent = who + ": ";
  entry.append(label, document.createTextNode(text));
  const log = byId("voice-transcript"); log.append(entry); log.scrollTop = log.scrollHeight;
  byId("voice-transcript-empty").hidden = true;
}
async function audioContext() {
  context ??= new AudioContext();
  if (context.state !== "running") await context.resume();
  if (context.state !== "running") throw new Error("Audio is paused by the browser. Click Start call again.");
}
function stopAudio() {
  if (source) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); source = null; }
  resolvePlayback?.(false); resolvePlayback = null;
}
async function play(encoded, mine) {
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const buffer = await context.decodeAudioData(bytes.buffer);
  if (mine !== version || !panel.open) return false;
  return new Promise(resolve => {
    resolvePlayback = resolve;
    source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    source.onended = () => { source?.disconnect(); source = null; resolvePlayback = null; resolve(true); };
    source.start();
  });
}
function stopMic() {
  micRequest++;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  if (capture) { capture.port.onmessage = null; capture.disconnect(); capture = null; }
  inputNode?.disconnect(); inputNode = null; silent?.disconnect(); silent = null;
  recording = []; prebuffer = []; speechFrames = 0; quietFrames = 0;
}
async function enableMic() {
  stopMic();
  const target = micRequest;
  if (!window.isSecureContext) throw new Error("Your phone needs trusted HTTPS for microphone access. On the PC, stop this build and run start-voice-https.cmd, then follow its certificate setup page on your phone.");
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot request a microphone. Open the secure address directly in Safari or another browser with microphone support.");
  // Leave native fullscreen before asking, including when switching from a typed call.
  if (document.fullscreenElement) await document.exitFullscreen();
  if (target !== micRequest) return false;
  const permission = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  // Start unlocking audio in the same gesture, without delaying the permission request.
  const ready = audioContext(); ready.catch(() => {});
  const acquired = await permission;
  if (target !== micRequest || !panel.open || byId("voice-mode").value !== "microphone") { acquired.getTracks().forEach(t => t.stop()); return false; }
  stream = acquired;
  try {
    await ready;
    if (target !== micRequest) return false;
    await audioContext(); // Safari can interrupt the context while showing the permission sheet.
    if (!context.audioWorklet) throw new Error("Audio capture is unavailable. Update your browser and reopen the secure address.");
    await context.audioWorklet.addModule("/voice-capture.js");
    if (target !== micRequest) return false;
    inputNode = context.createMediaStreamSource(acquired);
    capture = new AudioWorkletNode(context, "voice-capture");
    silent = context.createGain(); silent.gain.value = 0;
    inputNode.connect(capture); capture.connect(silent); silent.connect(context.destination);
    capture.port.onmessage = e => collect(e.data);
    acquired.getAudioTracks().forEach(track => {
      track.onended = () => { if (stream === acquired) { stopMic(); error("Microphone disconnected. Tap Microphone to turn it off, then tap again to reconnect, or use the keyboard."); controls(); } };
    });
    controls(); return true;
  } catch (e) { if (target === micRequest) stopMic(); throw e; }
}
function microphoneError(e) {
  if (e.name === "NotAllowedError" || e.name === "SecurityError") return "Microphone permission was denied. In Safari's website settings, allow Microphone for this secure address, then try again. You can also select Type to talk.";
  if (e.name === "NotFoundError") return "No microphone was found. Connect one or select Type to talk.";
  if (e.name === "NotReadableError" || e.name === "AbortError") return "The browser could not open your microphone. Close other apps using it and try again.";
  return e.message;
}
function collect(samples) {
  if (!callId || closing) return;
  const allowed = phase === "listening" || (phase === "interrupting" && recording.length > 0) || (phase === "speaking" && byId("voice-barge").checked);
  if (!allowed) { recording = []; prebuffer = []; speechFrames = 0; quietFrames = 0; return; }
  const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
  byId("voice-mic-level").value = Math.min(1, rms * 8);
  const voiced = rms > Number(byId("voice-threshold").value);
  const length = samples.length / context.sampleRate;
  prebuffer.push(samples); if (prebuffer.length > 5) prebuffer.shift();
  if (voiced) {
    if (!recording.length) recording.push(...prebuffer.slice(0, -1));
    speechFrames += length; quietFrames = 0;
  } else if (recording.length) quietFrames += length;
  if (recording.length || voiced) recording.push(samples);
  if (phase === "speaking" && speechFrames >= 0.2) {
    void interrupt(false).catch(e => error(e.message));
  }
  const total = recording.reduce((n, s) => n + s.length, 0) / context.sampleRate;
  if ((quietFrames > 0.9 || total > 25) && recording.length) {
    const utterance = recording; const spoken = speechFrames;
    recording = []; prebuffer = []; speechFrames = 0; quietFrames = 0;
    if (spoken > 0.18) void microphoneTurn(utterance);
  }
}
export function wavBase64(chunks, rate) {
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(size); let offset = 0;
  for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
  const count = Math.floor(size * 16000 / rate), buffer = new ArrayBuffer(44 + count * 2), view = new DataView(buffer);
  const text = (at, str) => [...str].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + count * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const at = i * rate / 16000, low = Math.floor(at), fraction = at - low;
    const sample = (input[low] || 0) * (1 - fraction) + (input[low + 1] || 0) * fraction;
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true);
  }
  const bytes = new Uint8Array(buffer); let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
async function microphoneTurn(chunks) {
  if (!callId || phase !== "listening") return;
  const mine = version, id = callId;
  phase = "transcribing"; status("Listening to what you said…"); controls();
  try {
    const result = await post("transcribe", { audio: wavBase64(chunks, context.sampleRate) });
    if (mine !== version || id !== callId) return;
    phase = "listening";
    if (result.text) await turn(result.text); else status("Listening…");
  } catch (e) { if (mine === version) { error(e.message); phase = "listening"; controls(); } }
}
async function interrupt(clear = true) {
  version++; aborter?.abort(); stopAudio();
  phase = "interrupting"; controls();
  if (clear) { recording = []; speechFrames = 0; quietFrames = 0; }
  if (callId) {
    const ended = await post("interrupt");
    if (ended.ended) { await endCall(); return; }
  }
  phase = "listening"; status(byId("voice-mode").value === "microphone" ? "Listening…" : "Type your reply below."); controls();
}
async function turn(text, initial = false) {
  if (!callId || closing) return;
  if (phase !== "listening") await interrupt();
  if (!callId) return;
  const mine = ++version;
  aborter = new AbortController();
  const signal = aborter.signal;
  error(""); phase = "thinking"; status(initial ? "Calling…" : "She’s thinking…"); controls();
  if (!initial) addLine("You", text);
  try {
    const reply = await post("turn", { text, opening: initial }, signal);
    for (let index = 0; index < reply.segments.length; index++) {
      if (mine !== version || !callId) return;
      phase = "synthesizing"; status("Preparing her voice…"); controls();
      const audio = await post("audio", { replyId: reply.replyId, index }, signal);
      if (mine !== version || !callId) return;
      phase = "speaking"; status("She’s speaking…");
      byId("voice-caption").textContent = reply.segments[index].replace(/\[[^\]]*\]/g, "").trim();
      controls();
      const finished = await play(audio.audio, mine);
      if (!finished || mine !== version) return;
      await post("ack", { replyId: reply.replyId, index }, signal);
      if (mine !== version) return;
      addLine(name, reply.segments[index]);
    }
    if (reply.action !== "continue") {
      await endCall(); status(reply.action === "block" ? "She blocked you and ended the call." : reply.action === "decline" ? "She declined the call." : "She ended the call.");
    } else { phase = "listening"; status(byId("voice-mode").value === "microphone" ? "Listening…" : "Type your reply below."); }
  } catch (e) {
    if (mine !== version || e.name === "AbortError") return;
    error(e.message);
    // Clear the pending speech so a renderer failure cannot trap the next turn.
    try { await interrupt(); } catch { await endCall(); }
  } finally { controls(); }
}
async function startCall() {
  if (callId || opening) return;
  opening = true; closing = false; controls(); error(""); const mine = ++version;
  const attempt = ++startAttempt;
  callStarted = 0; updateDuration();
  byId("voice-caption").textContent = "";
  byId("voice-transcript").replaceChildren(); byId("voice-transcript-empty").hidden = false;
  status("Connecting…");
  try {
    if (byId("voice-mode").value === "microphone") {
      status("Allow microphone access in your browser…");
      if (!await enableMic()) return;
    } else await audioContext();
    if (mine !== version || !panel.open) return;
    status("Connecting…");
    const result = await request("/api/calls/start", { charId, voice: byId("voice-choice").value });
    if (mine !== version || !panel.open) { await request(`/api/calls/${result.id}/end`, {}); return; }
    callId = result.id; name = result.name.split(" ")[0];
    callStarted = Date.now(); updateDuration(); clearInterval(durationTimer);
    durationTimer = setInterval(() => updateDuration(), 1000);
    heartbeat = setInterval(() => { if (callId) void post("heartbeat").catch(e => { error(e.message); void endCall(); }); }, 10_000);
    phase = "listening"; opening = false; controls(); enterCallFullscreen();
    if (callId) await turn("", true);
  } catch (e) {
    if (attempt !== startAttempt) return;
    if (callId) await endCall(); else stopMic();
    error(microphoneError(e)); status("Call could not start. Check the message above and try again.");
  } finally { if (attempt === startAttempt) opening = false; controls(); }
}
async function endCall() {
  if (closing) return;
  closing = true; version++; startAttempt++; aborter?.abort(); stopAudio(); stopMic(); clearInterval(heartbeat);
  const id = callId; callId = null; phase = "idle"; opening = false; controls();
  clearInterval(durationTimer); updateDuration(!!callStarted);
  try { if (id) await request(`/api/calls/${id}/end`, {}); }
  catch (e) { error(e.message); }
  finally { closing = false; status("Call ended. Completed speech is saved in the chat."); controls(); }
}
async function refreshVoices(selected) {
  const result = await request("/api/voice/voices");
  const select = byId("voice-choice"); select.replaceChildren();
  for (const voice of result.voices) { const option = document.createElement("option"); option.value = voice.id; option.textContent = voice.name; select.append(option); }
  const remembered = selected || localStorage.getItem(`vphone.voice.${charId || "preview"}`) || "default";
  if ([...select.options].some(o => o.value === remembered)) select.value = remembered;
}
async function refreshStatus() {
  try {
    const result = await request("/api/voice/status");
    modelsReady = result.ready;
    byId("voice-model-status").textContent = result.detail + (result.device ? ` (${result.device === "cuda" ? "GPU" : "CPU"})` : "");
    byId("voice-load").disabled = result.loading || result.ready;
    byId("voice-load").textContent = result.ready ? "Models ready" : result.loading ? "Loading models…" : "Load voice models";
    if (!callId && !previewing && !callStarted) status(result.ready ? "Ready when you are." : result.loading ? "Getting her voice ready…" : "Open options to set up her voice.");
    controls();
    if (result.ready) { clearInterval(statusTimer); await refreshVoices(); }
  } catch (e) { error(e.message); }
}
export async function openVoicePanel(options = {}) {
  panel = byId("voice-panel"); charId = options.charId || null; name = options.name || "Voice"; onClose = options.onClose;
  error(""); byId("voice-title").textContent = charId ? name : "Voice studio";
  byId("voice-options-title").textContent = charId ? "Call options" : "Voice studio";
  byId("voice-options-back").setAttribute("aria-label", charId ? "Back to call" : "Close voice studio");
  byId("voice-initials").textContent = name.split(/\s+/).slice(0, 2).map(part => part[0]).join("");
  const avatar = byId("voice-avatar"); avatar.hidden = true;
  avatar.onload = () => { avatar.hidden = false; }; avatar.onerror = () => { avatar.hidden = true; };
  if (charId) avatar.src = `/api/avatar/${encodeURIComponent(charId)}`; else avatar.removeAttribute("src");
  byId("voice-transcript").replaceChildren();
  byId("voice-transcript-empty").hidden = false; byId("voice-caption").textContent = "";
  byId("voice-preview-status").textContent = "";
  callStarted = 0; clearInterval(durationTimer); updateDuration();
  keyboardVisible = byId("voice-mode").value === "type";
  byId("voice-draft").value = ""; status("Getting ready…");
  controls(); panel.showModal(); showSheet(charId ? null : "options");
  clearInterval(statusTimer); statusTimer = setInterval(refreshStatus, 2000); await refreshStatus();
}
function init() {
  panel = byId("voice-panel");
  byId("voice-load").onclick = async () => { error(""); try { await request("/api/voice/load", {}); clearInterval(statusTimer); statusTimer = setInterval(refreshStatus, 2000); await refreshStatus(); } catch (e) { error(e.message); } };
  byId("voice-start").onclick = startCall;
  byId("voice-end").onclick = endCall;
  byId("voice-history-end").onclick = async () => { await endCall(); showSheet(null); };
  byId("voice-options-open").onclick = () => showSheet("options");
  byId("voice-transcript-open").onclick = () => showSheet("history");
  byId("voice-history-back").onclick = () => showSheet(null);
  byId("voice-keyboard").onclick = () => { keyboardVisible = !keyboardVisible; controls(); if (keyboardVisible && callId) byId("voice-draft").focus(); };
  byId("voice-interrupt").onclick = () => { void interrupt().catch(e => error(e.message)); };
  byId("voice-form").onsubmit = e => { e.preventDefault(); const draft = byId("voice-draft").value.trim(); if (draft && callId) { byId("voice-draft").value = ""; void turn(draft); } };
  byId("voice-mode").onchange = async () => {
    switchingInput = true; error(""); controls();
    try {
      if (byId("voice-mode").value === "type") stopMic();
      else if (callId) await enableMic();
      if (callId && phase === "listening") status(byId("voice-mode").value === "microphone" ? "Listening…" : "Type your reply below.");
    } catch (e) { stopMic(); byId("voice-mode").value = "type"; error(microphoneError(e)); }
    finally { switchingInput = false; keyboardVisible = byId("voice-mode").value === "type"; controls(); }
  };
  byId("voice-microphone").onclick = () => {
    byId("voice-mode").value = byId("voice-mode").value === "microphone" ? "type" : "microphone";
    void byId("voice-mode").onchange();
  };
  byId("voice-choice").onchange = () => localStorage.setItem(`vphone.voice.${charId || "preview"}`, byId("voice-choice").value);
  byId("voice-preview").onclick = async () => {
    previewing = true; controls(); error(""); const mine = ++version;
    try { await audioContext(); byId("voice-preview-status").textContent = "Generating a voice preview…"; const result = await request("/api/voice/test", { text: byId("voice-preview-text").value, voice: byId("voice-choice").value }); if (mine !== version) return; byId("voice-preview-status").textContent = "Playing voice preview…"; await play(result.audio, mine); if (mine === version) byId("voice-preview-status").textContent = "Preview finished."; }
    catch (e) { error(e.message); } finally { previewing = false; controls(); }
  };
  byId("voice-reference").onchange = async e => {
    const file = e.target.files[0]; if (!file) return; error("");
    try { if (file.size > 4_000_000) throw new Error("Use a WAV reference under 4 MB, 6-30 seconds long."); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); const added = await request("/api/voice/add", { name: file.name.replace(/\.wav$/i, ""), audio: btoa(binary) }); await refreshVoices(added.id); byId("voice-choice").dispatchEvent(new Event("change")); }
    catch (e) { error(e.message); } finally { e.target.value = ""; }
  };
  const close = async () => {
    await endCall(); clearInterval(statusTimer); await context?.close(); context = null; panel.close();
    if (callFullscreen) { callFullscreen = false; if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); }
    onClose?.();
  };
  byId("voice-close").onclick = close;
  byId("voice-options-back").onclick = () => { if (charId) showSheet(null); else void close(); };
  panel.addEventListener("cancel", e => { e.preventDefault(); if (sheet && charId) showSheet(null); else void close(); });
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) callFullscreen = false; });
  window.addEventListener("pagehide", () => { stopAudio(); stopMic(); if (callId) navigator.sendBeacon(`/api/calls/${callId}/end`, new Blob(["{}"], { type: "application/json" })); });
}
if (typeof document !== "undefined") init();
