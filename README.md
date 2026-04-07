# Zoom meeting join POC

Minimal Node.js proof-of-concept: open a **Zoom invite URL** in Chromium (via [Playwright](https://playwright.dev/)) and walk through the web client to join as a guest.

This mimics the “send a bot/meeting URL and join” flow at a **local R&D** level. It is **not** a substitute for [Recall.ai](https://www.recall.ai/)-style hosted bots, and it is **not** the compliance path for production AI notetakers on Zoom (see [Zoom Meeting SDK policy](https://developers.zoom.us/docs/meeting-sdk/web/) and [Zoom RTMS](https://developers.zoom.us/docs/rtms/) for product direction).

## Prerequisites

- Node.js 18+
- A display (macOS/Windows/Linux desktop). **Headed** mode is the default; Zoom often fails in pure headless mode.

## Install

```bash
cd zoom-meeting-agent
npm install
```

`postinstall` runs `playwright install chromium`. If browsers are missing, run:

```bash
npx playwright install chromium
```

## Configure

```bash
cp .env.example .env
```

Edit `.env`:

- `ZOOM_MEETING_URL` — full invite link (including `pwd=` if present in the invite).
- `GUEST_NAME` — name shown to others.
- `ZOOM_PASSCODE` — optional; only if the meeting needs a passcode that is **not** already in the URL.

## Run

```bash
npm run join
```

**Real microphone** (others hear you in the meeting):

```bash
npm run join:real
# or: USE_REAL_MEDIA=1 npm run join
# or: node src/join-zoom.mjs --real-audio
```

Stay **headed** (default). Accept mic/camera prompts in the browser if macOS asks. The script best-effort clicks “join computer audio” and **Unmute**; if Zoom’s UI changed, do those steps manually.

Or pass flags (overrides env):

```bash
node src/join-zoom.mjs --url "https://zoom.us/j/1234567890?pwd=..." --name "POC Guest"
```

- `--headless` — use only if you know your environment supports it (e.g. Xvfb on Linux servers).
- `--real-audio` / `USE_REAL_MEDIA` — real mic/camera instead of fake silent devices.
- `--timeout <ms>` — max time for join steps (default 120000).

Stop: **Ctrl+C** in the terminal (closes the browser).

## OpenAI Realtime → Zoom (virtual mic)

To send **model-generated speech** into the meeting, play PCM audio to a **virtual output** (e.g. [BlackHole](https://github.com/ExistentialAudio/BlackHole) 2ch on macOS), then in **Zoom web → Audio settings** choose that device as the **microphone**.

1. Install **ffmpeg** so `ffplay` is on your `PATH` (e.g. `brew install ffmpeg`).
2. Set system **output** to BlackHole (or a Multi-Output device that includes BlackHole) so `ffplay` audio reaches the virtual cable.
3. Join the meeting (this repo’s join script or manually). In Zoom, set **Microphone** to the same BlackHole device.
4. Run the bridge (requires `OPENAI_API_KEY` in `.env`):

```bash
npm run realtime:bridge -- --text "Say a short greeting to the meeting."
```

Optional env vars: `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`, `REALTIME_PROMPT`, `REALTIME_PCM_RATE`, `REALTIME_INSTRUCTIONS` — see `.env.example`.

This is a **local R&D** path only; align with Zoom’s terms and supported APIs before shipping anything customer-facing.

## Automation (pre-join)

The script attempts to run without manual steps:

- **Mic/camera (default)**: Chromium uses **fake** media flags so permission prompts are suppressed; the context still grants `camera` / `microphone` for Zoom origins after navigation. No real audio is sent.
- **Mic/camera (`--real-audio` / `USE_REAL_MEDIA`)**: Fake-device flags are **off**; use a **headed** browser and allow the real microphone when prompted. After join, the script best-effort clicks join-computer-audio and **Unmute** (`SELECTORS.joinComputerAudio` / `unmuteMic` in `src/join-zoom.mjs`).
- **Name / Join**: The guest name from `GUEST_NAME` is filled and **Join** is clicked using locators across **all frames** (Zoom often loads the pre-join UI in an iframe). If Zoom changes the DOM, update `SELECTORS` in `src/join-zoom.mjs`.

## Limitations (POC)

- **Waiting room**: You stay in the lobby until the host admits you; the script may not detect “in meeting” until admitted.
- **SSO / login-only meetings**: May require manual login; not handled here.
- **CAPTCHA or “open Zoom app” flows**: Can block automation; you may need to interact manually in the window.
- **DOM changes**: Zoom updates their web client; if join breaks, update the `SELECTORS` map in `src/join-zoom.mjs`.
- **Terms of use**: Use for local testing only until you align with Zoom’s terms and approved APIs for your product.

## Project layout

| Path | Purpose |
|------|---------|
| `src/join-zoom.mjs` | Playwright script |
| `src/realtime-audio-bridge.mjs` | OpenAI Realtime WebSocket → `ffplay` (route into Zoom via virtual audio) |
| `.env.example` | Sample environment variables |
