# Venus Phone

A phone companion for **Venus University**. Text the girls from your save on your phone over your home Wi-Fi, get replies in character, swap photos, and sync the chats back into the game.

Unofficial fan project. Not made by or affiliated with Venus Dev. No game files, art or characters are included; it reads your own install.

## Requirements

- Windows PC with Venus University 0.4.0 (save schema 12)
- [Node.js](https://nodejs.org/) 20 or newer
- A Gemini or OpenRouter API key
- For photos from the girls: the game's local ComfyUI, set up from inside the game

## Setup

1. Download or clone this repo.
2. Double-click `start.cmd`. The first run installs dependencies and asks you to choose a PIN (6+ digits or an 8+ character passphrase).
3. **On the PC**, open `http://localhost:8790`, unlock, and add your API key in Settings. Keys can only be entered on the PC, because the phone connection is plain HTTP.
4. **On your phone** (same Wi-Fi), open one of the `http://192.168.x.x:8790` addresses it prints. Skip any marked as a virtual adapter. Unlock with your PIN, then:
   - **Pick your game folder.** Browse to the folder with `Venus University.exe`, or paste its path. Its `data` or `saves` folder works too.
   - **Pick a save** to text from.

If Windows Firewall asks, allow **Private networks** only.

## Using it

- **Chats:** everyone who has given you her number in that save.
- **📷:** send her a photo. She reacts to what is in it. Location and other metadata are stripped first. On OpenRouter this needs a vision model; set one in Settings (default `deepseek/deepseek-v4.1-flash`).
- **"She texts first" (⏱ in each chat):** off, about every 5, 15 or 30 minutes, every 1–8 hours, or random (5 minutes to 4 hours). Set per girl, along with how many texts in a row (1–10) she can send before you reply. Never between 11pm and 8am.
- **Her replies:** she sends a varied number of texts each time (usually one or two, sometimes more), and now and then reacts to your text with an emoji.
- **Her photos:** she sends one when you ask, or now and then on her own. Ask for a selfie, mirror pic, full body, timer shot or candid and she follows it; otherwise the kind of shot varies. They are drawn by the game's ComfyUI with the same rules as in-game, including what she will send at your current relationship stage.
- **Themes (Settings → Appearance):** Bunnyboard, Midnight, OLED (true black), Light, or match your device, plus an accent colour. On desktop you can also set a background around the chat (gradients or your own picture). Saved per device.
- **Sync:** close the game, tap Sync, then load the newest slot save in the game. Sync always writes a *new* save; your existing saves are never changed. If the game saved since you started, your chats go on top of its newest save.

## Privacy and security

- **Plain HTTP by default.** Like most self-hosted apps (SillyTavern included), the phone connects over plain HTTP. Anyone who can watch your local network traffic could read your chats and session cookie, so use Wi-Fi you trust.
- **Optional HTTPS.** For an encrypted connection, set `"https": true` in `app-data/config.json` (or `VENUS_PHONE_HTTPS=1`) and restart. The app creates a certificate authority on your PC, whose private key never leaves it. Each phone then installs the certificate once from the setup page at `http://<pc-ip>:8790`, which has iPhone and Android steps and the fingerprint to check. After that, use `https://<pc-ip>:8791`.
- **Local network only.** It only answers devices on your local network (192.168.x.x, 10.x.x.x, 172.16–31.x.x, localhost).
- **DNS rebinding blocked.** Requests addressed to any hostname other than this PC's own names and addresses are refused. Cross-site requests are blocked using `Sec-Fetch-Site` and an exact Origin check.
- **PIN-protected.** A PIN unlocks the app, with lockouts after repeated wrong tries. Session cookies are `HttpOnly`, `SameSite=Strict` and `Secure`.
- **API keys never cross the network unencrypted.** Keys can only be entered on the PC itself, or from the phone once HTTPS is on. They are stored encrypted with Windows DPAPI for your user account.
- **Don't expose it.** Don't port-forward it, tunnel it or put it behind a proxy. It is built for a home network.
- **The AI provider sees chats.** Chat text, and any photo you send, goes to the AI provider you choose (Gemini or OpenRouter), the same as the game does.
- **Personal data stays in `app-data/`.** That folder next to the app holds your PIN hash, encrypted API keys, unsynced chats, your uploaded photos and, if HTTPS is on, the certificate files. It is git-ignored; never commit it.

This is careful home-use hardening, not a professional security audit.

## Limits

- Your photos reach the game as a written description (`📷 [sent a photo: …]`). The game can't show images you send.
- Hangout invites in texts don't schedule anything in the game.
- The prompt follows the game's texting prompt but leaves out some live game state (schedules, weather, location).

## Development

```
npm install
npm run build
node dist/server.js
```

Settings can also come from environment variables: `VENUS_GAME_DIR`, `VENUS_PHONE_PORT` (HTTP, default 8790), `VENUS_PHONE_HTTPS_PORT` (default HTTP port + 1), `VENUS_PHONE_PIN`, `VENUS_PHONE_DATA`, and `VENUS_PHONE_HTTPS=1` to turn on HTTPS.

## License

AGPL-3.0-only, matching Venus University and Maestro's community mods. See [LICENSE](LICENSE) for the full license text.
