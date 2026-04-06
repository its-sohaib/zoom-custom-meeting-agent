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

Or pass flags (overrides env):

```bash
node src/join-zoom.mjs --url "https://zoom.us/j/1234567890?pwd=..." --name "POC Guest"
```

- `--headless` — use only if you know your environment supports it (e.g. Xvfb on Linux servers).
- `--timeout <ms>` — max time for join steps (default 120000).

Stop: **Ctrl+C** in the terminal (closes the browser).

## Automation (pre-join)

The script attempts to run without manual steps:

- **Mic/camera**: Chromium is launched with fake media flags (`--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`) so permission prompts are not shown, and the context grants `camera` / `microphone` for Zoom origins after navigation.
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
| `.env.example` | Sample environment variables |
