# Venus Phone

A phone companion for **Venus University**. Text the girls from your save on your phone over your home Wi-Fi, get replies in character, swap photos, and sync the chats back into the game.

Unofficial fan project. Not made by or affiliated with Venus Dev. No game files, art or characters are included; it reads your own install.

## Requirements

- Windows PC with Venus University 0.4.0 or 0.5.0 (save schemas 12 and 13)
- [Node.js](https://nodejs.org/) 20 or newer
- A Gemini API key, or a key for an OpenAI-compatible chat provider such as OpenRouter or NanoGPT; the selected model must support structured JSON replies
- For photos from the girls: the game's managed local ComfyUI, set up from inside the game (external ComfyUI servers are not supported)

## Setup

1. Download or clone this repo.
2. Double-click `start.cmd`. The first run installs dependencies and asks you to choose a PIN (6+ digits or an 8+ character passphrase).
3. **On the PC**, open exactly `http://localhost:8790`, unlock, and add your API key in Settings, then press **Save settings**. Keys can only be entered this way, because the phone connection is plain HTTP.
   - It has to be `localhost`. Opening the PC's `http://192.168.x.x:8790` address in the PC's own browser counts as another device, and the key fields stay locked.
   - Until a key is saved for the AI service you picked, Settings keeps reopening when you go back.
4. **On your phone** (same Wi-Fi), open one of the `http://192.168.x.x:8790` addresses it prints. Skip any marked as a virtual adapter. Unlock with your PIN, then:
   - **Pick your game folder.** Browse to the folder with `Venus University.exe`, or paste its path. Its `data` or `saves` folder works too.
   - **Pick a save** to text from.

If Windows Firewall asks, allow **Private networks** only.

## AI providers

Venus Phone supports **Gemini** directly and **Other providers (OpenAI-compatible)** through a configurable API base URL. OpenRouter is the default compatible endpoint. NanoGPT and other services can use the same settings when their selected model supports the required chat API and structured JSON output.

In **Settings → AI service**, choose **Other providers (OpenAI-compatible)** and enter:

| Setting | What to enter |
| --- | --- |
| **Chat model** | The exact model ID from your provider's catalog |
| **Photo message model** | An image-capable model from the same provider; leave blank to use the chat model if it supports images |
| **API base URL** | OpenRouter: `https://openrouter.ai/api/v1`; NanoGPT: `https://nano-gpt.com/api/v1` |
| **Provider API key** | A key issued by the provider at that base URL |

Use the base URL without `/chat/completions`; the app adds that route. When switching services, update the API key and both model IDs along with the URL. Model IDs and image support can differ between providers. Existing OpenRouter settings continue to work; older builds label this option **OpenRouter**.

Compatibility requires bearer-key authentication, the Chat Completions API, and `response_format` with `json_schema`. NanoGPT documents these features, but it has not yet been live-tested with Venus Phone. Other compatible services and individual models may have additional limits. See [NanoGPT's Chat Completions documentation](https://docs.nano-gpt.com/api-reference/endpoint/chat-completion).

This provider choice supplies both text messages and dialogue for experimental calls. Chatterbox speech, Whisper transcription, and the game's ComfyUI photo generation continue to run locally.

## Using it

- **Chats:** everyone who has given you her number in that save.
- **Changing saves or folders:** wait for replies, calls, and photos to finish. Folder changes stop when there are unsynced changes; sync first, or use **Change save** to explicitly discard them. A failed selection keeps the previous session.
- **📷:** send her a photo. She reacts to what is in it. Location and other metadata are stripped first. Your selected model must accept images. For an OpenAI-compatible provider, choose its image-capable model under **Photo message model** in Settings.
- **"She texts first" (⏱ in each chat):** off, about every 5, 15 or 30 minutes, every 1–8 hours, or random (5 minutes to 4 hours). Set per girl, along with how many texts in a row (1–10) she can send before you reply. Never between 11pm and 8am.
- **Her replies:** she sends a varied number of texts each time (usually one or two, sometimes more), and now and then reacts to your text with an emoji.
- **Her photos:** she sends one when you ask, or now and then on her own. Ask for a selfie, mirror pic, full body, timer shot or candid and she follows it; otherwise the kind of shot varies. They are drawn using the game's local ComfyUI. DM photo behavior and relationship-based photo tiers are adapted from **Photo Feature**, naudh1r's mod in **Venus Extracurriculars**; these features are not part of the base game's Photos feature.
- **Themes (Settings → Appearance):** Bunnyboard, Midnight, OLED (true black), Light, or match your device, plus an accent colour. On desktop you can also set a background around the chat (gradients or your own picture). Saved per device.
- **Sync:** close the game, tap Sync, then load the newest slot save in the game. Sync always writes a *new* save; your existing saves are never changed. If the game saved since you started, your chats go on top of its newest save in the same semester. If the newest save belongs to a different semester (including another continuation branch), sync stops and keeps your unsynced chats rather than moving them onto the wrong calendar. Sync before continuing to a new semester.
- **0.5.0 semesters:** contacts include that save's roster and graduates, dates follow its spring/fall calendar, and character profiles come from the matching semester. Sync preserves the source save's schema and additional game fields.
- **0.5.0 photo generation:** uses the installed Photo Feature workflow when available, otherwise adapts the base game's CG workflow in memory. The fallback removes the staged pose requirement and placeholder character LoRA, honors a real character LoRA when present, and uses the game's managed checkpoint, style LoRA and face-detector selections. Game workflows/settings are never rewritten.

If you play the game between phone sessions, Sync detects changed saves (including overwritten autosave/manual slots) and asks before applying pending phone changes to newer progress. The warning identifies the target save and covers message deletions and block/unblock decisions. Confirmation is tied to that save's contents and the pending edits; changes after the warning require another review. Affected chat recaps are cleared so an older phone recap cannot replace newer game context. With no pending changes, Sync writes nothing; pick the newest save to refresh the app's conversation and relationship context. After syncing, load the newly created slot in the game before playing on.

## Privacy and security

- **Plain HTTP by default.** Like most self-hosted apps (SillyTavern included), the phone connects over plain HTTP. Anyone who can watch your local network traffic could read your chats and session cookie, so use Wi-Fi you trust.
- **Optional HTTPS.** For an encrypted connection, set `"https": true` in `app-data/config.json` (or `VENUS_PHONE_HTTPS=1`) and restart. The app creates a certificate authority on your PC, whose private key never leaves it. Each phone then installs the certificate once from the setup page at `http://<pc-ip>:8790`, which has iPhone and Android steps and the fingerprint to check. After that, use `https://<pc-ip>:8791`.
- **Local network only.** It only answers devices on your local network (192.168.x.x, 10.x.x.x, 172.16–31.x.x, localhost).
- **DNS rebinding blocked.** Requests addressed to any hostname other than this PC's own names and addresses are refused. Cross-site requests are blocked using `Sec-Fetch-Site` and an exact Origin check.
- **PIN-protected.** A PIN unlocks the app, with lockouts after repeated wrong tries and bounded pending login requests. Session cookies are `HttpOnly` and `SameSite=Strict`, with `Secure` set on HTTPS connections. Cookie names are separate for HTTP, HTTPS and each port, so an older voice build's secure cookie cannot block login to an HTTP build. After upgrading, enter your existing PIN once to start a new session; no Safari data reset is needed. If cookies are blocked, the login screen explains why the PIN was accepted but the session could not be kept.
- **API-key transport.** Keys can only be entered on the PC itself, or from the phone once HTTPS is on. AI endpoints must also use HTTPS; HTTP is allowed only for `localhost` or loopback addresses on this PC. This is checked again before sending requests, including for previously saved endpoints. AI requests do not follow redirects. Keys are stored encrypted with Windows DPAPI for your user account.
- **Don't expose it.** Don't port-forward it, tunnel it or put it behind a proxy. It is built for a home network.
- **The AI provider sees chats.** Chat text, and any photo you send, goes to your configured AI service: Gemini directly or the service at your chosen API base URL. Check that service's data-handling policies.
- **Personal data stays in `app-data/`.** That folder next to the app holds your PIN hash, encrypted API keys, unsynced chats, your uploaded photos and, if HTTPS is on, the certificate files. It is git-ignored; never commit it.

This is careful home-use hardening, not a professional security audit.

## Limits

- Your photos reach the game as a written description (`📷 [sent a photo: …]`). The game can't show images you send.
- Girls' DM images display in Venus Phone. Vanilla 0.5.0 does not render the Photo Feature mod's DM image metadata inside its chat; that still needs a compatible game mod.
- Hangout invites in texts don't schedule anything in the game.
- The prompt follows the game's texting prompt but leaves out some live game state (schedules, weather, location).

## Experimental voice calls

See [VOICE-EXPERIMENT.md](VOICE-EXPERIMENT.md) for local Chatterbox speech, Whisper transcription, typed replies with spoken responses, voice references, and iPhone HTTPS setup. Run `setup-voice.cmd` once to install the isolated speech environment, then `start-voice.cmd` (or `start-voice-https.cmd` for a phone microphone). Microphone access on a phone requires a trusted HTTPS connection.

## Development

```
npm install
npm run build
node dist/server.js
```

Settings can also come from environment variables: `VENUS_GAME_DIR`, `VENUS_PHONE_PORT` (HTTP, default 8790), `VENUS_PHONE_HTTPS_PORT` (default HTTP port + 1), `VENUS_PHONE_PIN`, `VENUS_PHONE_DATA`, and `VENUS_PHONE_HTTPS=1` to turn on HTTPS.

Pull requests targeting `main` and pushes to `main` run **Build and test (Windows)** in GitHub Actions. The workflow installs locked dependencies and runs `npm test` on Windows with Node.js 22. Tests use synthetic saves and mocked AI/speech providers; no game install, API keys, voice models, or personal data are needed.

## Credits

- **Venus Dev:** [Venus University](https://venus-dev.itch.io/venus-university), the base game.
- **naudh1r (Nauhd1r):** [Photo Feature](https://github.com/naudh1r/venus-university/tree/photo-feature), the mod integrated into [Venus Extracurriculars](https://github.com/venus-extracurriculars/build). Venus Phone adapts its DM photo behavior, relationship-based photo tiers and photo prompt logic, including `buildPhotoPrompt`, `allowedPhotoTier`, `settlePhoto` and `photoLines`. These originate from the mod, separately from the base game's Photos feature.

## License

AGPL-3.0-only, matching Venus University and Maestro's community mods. See [LICENSE](LICENSE) for the full license text.

# Message controls

Each message has a **Delete** button. Deletion is saved across restarts and applied to the next synced save, including when the game has created a newer save. It does not undo a character's block or erase game memories, and it leaves photo files on disk.

The last bubble of the latest reply has **Regenerate reply**. It replaces that entire reply; earlier replies cannot be regenerated because later messages depend on them. If that reply included a photo, regeneration also queues a new photo with a fresh filename and render seed, keeping the original scene and request as context. Current photo settings and relationship limits still apply; if a valid replacement cannot be prepared, the original reply is kept. Rendering happens in the background and shows “Photo developing…”; a renderer failure shows “Photo didn't come through” and can be retried with Regenerate reply. Old photo files remain on disk. Text-only replies stay text-only, and photos you sent are represented by their stored descriptions. Blocked chats cannot be regenerated.

Conversation prompts favor ongoing, natural back-and-forth without forced questions or routine goodnight/goodbye sign-offs. The save's day/night label is not a bedtime deadline. Characters can still refuse requests, set boundaries, and block for behavior that gives them a reason to cut contact. Existing emoji reactions remain visible while new reply bubbles arrive.

Editing clears the running chat recap to avoid carrying removed messages into future prompts. Future replies still use the surviving recent messages and the character's game memories, but details held only in the old recap will be forgotten.

Hidden unblock gesture: open a blocked contact's chat and click or tap her profile picture in the header **three times within three seconds**. She sends an in-character message deciding to reopen contact, then you can text again. The gesture does nothing for an unblocked contact. A failed AI request leaves her blocked so you can retry. The unblock survives restarts and carries into the next synced game save; it does not erase history or prevent a later block.

Run `npm test` to build and check deletion, regeneration, blocking/unblocking, persistence, profile gestures and edit guards with a mocked AI provider.

