#!/usr/bin/env node
/**
 * Zoom web join POC — Playwright drives the Zoom web client.
 * Update SELECTORS if Zoom changes their DOM.
 */

import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

loadEnv({ path: path.join(ROOT, ".env") });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chromium flags so media permission prompts are not shown (fake devices). */
const CHROMIUM_MEDIA_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];

/**
 * @param {import('playwright').Page} page
 * @returns {import('playwright').Frame[]}
 */
function allFrames(page) {
  return page.frames();
}

/** @type {Record<string, string[]>} */
const SELECTORS = {
  joinFromBrowser: [
    'button:has-text("Join from Browser")',
    'a:has-text("Join from Browser")',
    '[role="button"]:has-text("Join from Browser")',
  ],
  dismissOpenApp: [
    'button:has-text("Cancel")',
    'button:has-text("Stay in Browser")',
  ],
  guestNameInput: [
    "input#input-for-name",
    'input[aria-label*="Your name" i]',
    'input[placeholder*="Your name" i]',
    'input[placeholder*="name" i]',
    'input[aria-label*="name" i]',
    'input[name="uname"]',
    'input[name="userName"]',
    'input[name="name"]',
    'input[type="text"]',
  ],
  joinButton: [
    'button:has-text("Join")',
    'button:has-text("Join Meeting")',
    '[role="button"]:has-text("Join")',
    "button.join-meeting-button",
  ],
  passcodeInput: [
    'input[placeholder*="passcode" i]',
    'input[aria-label*="passcode" i]',
    'input[type="password"]',
    'input[name="password"]',
  ],
  inMeeting: [
    '[aria-label*="Leave" i]',
    'button:has-text("Leave")',
    '[data-tooltip*="Leave" i]',
    'footer button >> nth=0',
  ],
};

function parseArgs(argv) {
  const out = { url: null, name: null, headless: false, timeoutMs: 120_000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && argv[i + 1]) out.url = argv[++i];
    else if (a === "--name" && argv[i + 1]) out.name = argv[++i];
    else if (a === "--headless") out.headless = true;
    else if (a === "--timeout" && argv[i + 1]) out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
    else if (a === "--help" || a === "-h") {
      console.log(`
Usage: node src/join-zoom.mjs [options]

  --url <url>       Zoom meeting URL (or set ZOOM_MEETING_URL)
  --name <string>   Guest display name (or set GUEST_NAME)
  --headless          Run headless (often fails with Zoom; for CI/Xvfb only)
  --timeout <ms>      Max time for join steps (default 120000)

Environment: ZOOM_MEETING_URL, GUEST_NAME
`);
      process.exit(0);
    }
  }
  return out;
}

function isZoomLikeUrl(url) {
  try {
    const u = new URL(url);
    return /zoom\.(us|com|cn|gov)$/i.test(u.hostname) || u.hostname.endsWith(".zoom.us");
  } catch {
    return false;
  }
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} pageUrl
 */
async function grantMediaForZoomOrigin(context, pageUrl) {
  try {
    const origin = new URL(pageUrl).origin;
    await context.grantPermissions(["camera", "microphone"], { origin });
  } catch {
    /* invalid URL during navigation */
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string[]} candidates
 * @param {number} timeout
 */
async function clickFirstVisible(page, candidates, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of allFrames(page)) {
      for (const sel of candidates) {
        const loc = frame.locator(sel).first();
        try {
          if (await loc.isVisible({ timeout: 400 })) {
            await loc.click({ timeout: 5000 });
            return true;
          }
        } catch {
          /* try next */
        }
      }
    }
    await sleep(300);
  }
  return false;
}

/**
 * @param {import('playwright').Page} page
 * @param {string[]} candidates
 * @param {string} value
 * @param {number} timeout
 */
async function fillFirstVisible(page, candidates, value, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of allFrames(page)) {
      for (const sel of candidates) {
        const loc = frame.locator(sel).first();
        try {
          if (await loc.isVisible({ timeout: 400 })) {
            await loc.fill(value, { timeout: 5000 });
            return true;
          }
        } catch {
          /* try next */
        }
      }
    }
    await sleep(300);
  }
  return false;
}

/**
 * Clicks Join / Join Meeting via role + text (works across locales in en-US).
 * @param {import('playwright').Page} page
 * @param {number} timeout
 */
async function clickJoinMeetingButton(page, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of allFrames(page)) {
      try {
        const exact = frame.getByRole("button", { name: /^Join$/i }).first();
        if (await exact.isVisible({ timeout: 400 })) {
          await exact.click({ timeout: 5000 });
          return true;
        }
      } catch {
        /* continue */
      }
      try {
        const jm = frame.getByRole("button", { name: /join meeting/i }).first();
        if (await jm.isVisible({ timeout: 400 })) {
          await jm.click({ timeout: 5000 });
          return true;
        }
      } catch {
        /* continue */
      }
    }
    await sleep(300);
  }
  return false;
}

/**
 * @param {import('playwright').Page} page
 * @param {string[]} candidates
 * @param {number} timeoutMs
 */
async function waitForAny(page, candidates, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const frame of allFrames(page)) {
      for (const sel of candidates) {
        const loc = frame.locator(sel).first();
        try {
          await loc.waitFor({ state: "visible", timeout: 800 });
          return true;
        } catch {
          /* continue */
        }
      }
    }
    await sleep(400);
  }
  return false;
}

/**
 * Polls until name is filled and Join is clicked (handles slow iframe load).
 * @param {import('playwright').Page} page
 * @param {string} guestName
 * @param {string | undefined} passcode
 * @param {number} timeoutMs
 */
async function runPreJoinFlow(page, guestName, passcode, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let nameDone = false;

  while (Date.now() < deadline) {
    if (passcode) {
      const passFilled = await fillFirstVisible(page, SELECTORS.passcodeInput, passcode, 3000);
      if (passFilled) {
        await clickJoinMeetingButton(page, 3000);
        await clickFirstVisible(page, SELECTORS.joinButton, 3000);
      }
    }

    if (!nameDone) {
      const filled = await fillFirstVisible(page, SELECTORS.guestNameInput, guestName, 8000);
      if (filled) {
        nameDone = true;
        await page.keyboard.press("Enter").catch(() => {});
      }
    }

    if (await clickJoinMeetingButton(page, 2500)) return true;
    if (await clickFirstVisible(page, SELECTORS.joinButton, 2500)) return true;

    await sleep(400);
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv);
  const meetingUrl = args.url || process.env.ZOOM_MEETING_URL;
  const guestName = args.name || process.env.GUEST_NAME || "POC Guest";

  if (!meetingUrl || !String(meetingUrl).trim()) {
    console.error("Missing meeting URL. Pass --url or set ZOOM_MEETING_URL (see .env.example).");
    process.exit(1);
  }
  if (!isZoomLikeUrl(meetingUrl)) {
    console.error("URL does not look like a Zoom meeting link.");
    process.exit(1);
  }

  console.log("Starting Chromium (headed=%s)…", !args.headless);
  const browser = await chromium.launch({
    headless: args.headless,
    args: CHROMIUM_MEDIA_ARGS,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    ignoreHTTPSErrors: true,
    permissions: ["camera", "microphone"],
  });

  await grantMediaForZoomOrigin(context, meetingUrl);

  const page = await context.newPage();
  page.setDefaultTimeout(args.timeoutMs);

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      grantMediaForZoomOrigin(context, page.url()).catch(() => {});
    }
  });

  const shutdown = async () => {
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    console.log("Opening meeting URL…");
    await page.goto(meetingUrl, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    await grantMediaForZoomOrigin(context, page.url());

    await clickFirstVisible(page, SELECTORS.joinFromBrowser, 15_000);
    await clickFirstVisible(page, SELECTORS.dismissOpenApp, 8_000);

    const pass = process.env.ZOOM_PASSCODE?.trim() || undefined;
    console.log("Completing pre-join (name, permissions handled by browser flags)…");
    const preJoined = await runPreJoinFlow(page, guestName, pass, args.timeoutMs);
    if (preJoined) console.log("Clicked Join.");
    else console.warn("Pre-join automation did not confirm Join; check the window or selectors.");

    const joined = await waitForAny(page, SELECTORS.inMeeting, args.timeoutMs);
    if (joined) {
      console.log("Detected in-meeting UI. Leave the meeting in the browser or press Ctrl+C to exit.");
    } else {
      console.warn(
        "Could not confirm in-meeting state (waiting room, SSO, captcha, or DOM change). Check the browser window."
      );
    }

    await new Promise(() => {});
  } catch (err) {
    console.error(err);
    await browser.close();
    process.exit(1);
  }
}

main();
