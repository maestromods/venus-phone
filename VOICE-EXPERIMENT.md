# Experimental local voice calls

Double-click **start-voice.cmd**, then open **http://localhost:8792** on this PC.
If it is already running, the launcher shows the address instead of starting another copy. **stop-voice.cmd** stops this build and its speech worker, including a copy running in the background. It only targets this folder's server; other apps are left alone. Use these shortcuts to start and stop the experiment.
This build keeps settings in its local app-data folder and uses a separate login cookie. No personal settings, chats, credentials, recordings, or voice references are distributed with the source.

1. Open a contact and click the **phone** button in the header. The call fills the available screen on phones. Native browser fullscreen is attempted only after call setup so it cannot cover the microphone permission prompt; some browsers keep their address bar visible. Closing the call screen restores the previous view.
2. Open the **three-dot Call options menu** for **Load voice models**, voice selection, previews, custom voice uploads, and microphone settings. First-time model downloads and loading can take a few minutes.
3. Leave **Type to talk — she replies aloud** selected, return to the call screen, and click **Start call**.
4. Type in **Your reply** and press the **up-arrow Send reply button**. **Keyboard** shows or hides the input. No microphone permission is needed in this mode.
5. **Interrupt** stops playback. Sending a new typed reply also interrupts. **End call** releases the conversation. **Transcript** opens the full call history; the main screen shows the current spoken line and call duration.

**Voice studio** in Settings can preview speech without calling a character or using your dialogue API. Preview text supports occasional `um`, `ah`, `hmm`, `[chuckle]`, `[laugh]`, `[sigh]`, and `[gasp]`. Delivery varies; the tags are suggestions to the speech model. A clear 6–30 second WAV reference can supply another voice. Use samples you have permission to use. There is one built-in voice; custom voice choices are remembered per contact on each browser.

## Microphone mode

Tap **Microphone** on the call screen (or select **Microphone — pause to send** in Call options), then **Start call** and allow microphone access. Permission is requested before contacting the call server. A denied or unavailable microphone stops startup and shows instructions; it never silently starts a typed call instead. The microphone meter shows incoming speech while listening. It transcribes locally after about a second of silence. Turns are capped at about 25 seconds. Headphones are recommended. Automatic interruption is optional under Microphone settings; the explicit Interrupt button works in either mode. Quiet/noisy rooms may need the sensitivity control.

Browsers allow microphones on **localhost** or trusted **HTTPS**. For an iPhone:

1. On the PC run **stop-voice.cmd**, then **start-voice-https.cmd**. Use that HTTPS launcher for future microphone sessions too. Alternatively enable `"https": true` in app-data/config.json.
2. On the iPhone, open the printed **http://<pc-ip>:8792** address in Safari. Download the certificate from the setup page and follow its installation instructions.
3. Install the profile in **Settings → General → VPN & Device Management**. Then enable **Venus Phone Local CA** in **Settings → General → About → Certificate Trust Settings**. Verify the fingerprint against the PC's setup output.
4. Return to Safari and tap **Open Bunnyboard securely** to use **https://<pc-ip>:8793**. Unlock with the same PIN, select Microphone and start the call. If permission was denied previously, allow Microphone in Safari's settings for that website.

Using an HTTP LAN address cannot show a microphone prompt. A certificate warning must be resolved by installing and trusting the certificate; bypassing a warning is insufficient. Typing still works on the PC's localhost address or with the ordinary HTTP launcher. See [WebKit's media-capture security policy](https://webkit.org/blog/7763/a-closer-look-into-webrtc/).

## What is local

- Chatterbox Turbo generates speech on the NVIDIA GPU, using its normal watermarking.
- faster-whisper small.en transcribes speech on the CPU, with Silero speech filtering.
- Your configured AI provider (Gemini directly or an OpenAI-compatible service such as OpenRouter or NanoGPT) generates the character's dialogue. It receives text context and transcripts, not microphone audio. Internet and dialogue API usage are still required. See [AI providers](README.md#ai-providers) for setup and compatibility requirements.
- Speech audio is transient. Uploaded reference voices and model weights stay under voice/. The completed transcript stays in this build's app-data/session.json.
- The speech worker uses private stdin/stdout and opens no extra network port. Existing PIN, LAN and cross-site protections apply.

## Experimental limits

This is a turn-based prototype with expressive speech and interruption, not simultaneous conversational reasoning. Model response time and speech synthesis introduce pauses. The first utterance can take longer. Heavy image generation or games may compete for GPU memory.

Calls share character history and blocking. A character can decline, hang up, or block; blocks use the existing game-sync flags. Only completed audio chunks are added to the transcript. An interrupted chunk may have been partly audible but is omitted rather than treating unheard words as remembered. Call messages cannot be regenerated through the text-message controls.

Sync is manual and writes a new game save. This experiment has a separate snapshot of your chats: **use only one build to sync a given playthrough during testing**. Close the game before syncing. Switching saves and syncing are refused during an active call. A disconnected call expires after 45 seconds without a heartbeat. A server restart ends all calls.

## Reinstalling or moving the build

Node.js 20+ and uv are required. Run **setup-voice.cmd** to create the isolated Python environment, then **start-voice.cmd**. Model downloads occur on first load. No global Python packages are changed. The portable source ZIP excludes personal app data, models, reference voices and the Python environment.

Sources: [Chatterbox](https://github.com/resemble-ai/chatterbox), [faster-whisper](https://github.com/SYSTRAN/faster-whisper). The CUDA 12.8 PyTorch override supports recent NVIDIA GPUs. The setuptools pin supplies a compatibility dependency used by Perth watermarking.
