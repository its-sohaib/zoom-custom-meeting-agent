#!/usr/bin/env node
/**
 * OpenAI Realtime (WebSocket) → PCM16 → ffplay stdout.
 * Route meeting audio: set system output (or Multi-Output) to BlackHole 2ch, then in Zoom web
 * choose BlackHole as the microphone. Requires ffmpeg (ffplay) on PATH.
 *
 * @see https://platform.openai.com/docs/guides/realtime-websockets
 */

import WebSocket from "ws";
import { spawn } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

loadEnv({ path: path.join(ROOT, ".env") });

const DEFAULT_MODEL = "gpt-realtime";
const DEFAULT_VOICE = "marin";

function parseArgs(argv) {
  const out = { text: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text" && argv[i + 1]) out.text = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  console.log(`
Usage: node src/realtime-audio-bridge.mjs --text "Your prompt"

Plays model audio to the default output device (set it to BlackHole; use that device as Zoom mic).

Environment:
  OPENAI_API_KEY          Required
  OPENAI_REALTIME_MODEL   Default: ${DEFAULT_MODEL}
  OPENAI_REALTIME_VOICE   Default: ${DEFAULT_VOICE}
  REALTIME_PROMPT         Used if --text is omitted
  REALTIME_PCM_RATE       Output sample rate (default 24000)
  REALTIME_INSTRUCTIONS   Optional session instructions
`);
}

/**
 * @param {number} sampleRate
 * @returns {import('node:child_process').ChildProcessWithoutNullStreams}
 */
function spawnFfplay(sampleRate) {
  const child = spawn(
    "ffplay",
    [
      "-nodisp",
      "-loglevel",
      "error",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-i",
      "pipe:0",
    ],
    { stdio: ["pipe", "ignore", "pipe"] }
  );

  child.stderr?.on("data", (d) => {
    const s = d.toString().trim();
    if (s) console.error("[ffplay]", s);
  });

  child.on("error", (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      console.error(
        "ffplay not found. Install ffmpeg (e.g. brew install ffmpeg) so ffplay is on your PATH."
      );
    } else {
      console.error(err);
    }
  });

  return child;
}

/**
 * @param {import('node:stream').Writable} stdin
 * @param {Buffer} chunk
 * @returns {Promise<void>}
 */
function writeChunk(stdin, chunk) {
  return new Promise((resolve, reject) => {
    const ok = stdin.write(chunk, (err) => {
      if (err) reject(err);
    });
    if (ok) resolve();
    else stdin.once("drain", resolve);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error("Missing OPENAI_API_KEY (see .env.example).");
    process.exit(1);
  }

  const model = process.env.OPENAI_REALTIME_MODEL?.trim() || DEFAULT_MODEL;
  const voice = process.env.OPENAI_REALTIME_VOICE?.trim() || DEFAULT_VOICE;
  const pcmRate = Number(process.env.REALTIME_PCM_RATE) || 24_000;
  const prompt =
    args.text?.trim() ||
    process.env.REALTIME_PROMPT?.trim() ||
    "Say hello in one short sentence.";

  const instructions =
    process.env.REALTIME_INSTRUCTIONS?.trim() ||
    "Speak clearly and briefly. One or two sentences unless asked for more.";

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  let updateSent = false;
  let player = /** @type {ReturnType<typeof spawnFfplay> | null} */ (null);
  let promptSent = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let exitTimer = null;
  let responseDoneHandled = false;

  const sessionUpdate = {
    type: "session.update",
    session: {
      type: "realtime",
      model,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          turn_detection: null,
        },
        output: {
          format: { type: "audio/pcm" },
          voice,
        },
      },
      instructions,
    },
  };

  const shutdown = async (code = 0) => {
    if (exitTimer) clearTimeout(exitTimer);
    exitTimer = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    if (player?.stdin?.writable) {
      player.stdin.end();
    }
    player?.kill("SIGTERM");
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  ws.on("open", () => {
    console.log("Realtime WebSocket open; waiting for session.created…");
  });

  ws.on("message", async (data) => {
    let ev;
    try {
      ev = JSON.parse(data.toString());
    } catch {
      console.warn("Non-JSON message from server");
      return;
    }

    if (ev.type === "error") {
      console.error("Realtime error:", JSON.stringify(ev, null, 2));
      await shutdown(1);
      return;
    }

    if (ev.type === "session.created") {
      ws.send(JSON.stringify(sessionUpdate));
      updateSent = true;
      console.log("Sent session.update (audio output, text-in via conversation item).");
      return;
    }

    if (ev.type === "session.updated" && updateSent && !promptSent) {
      player = spawnFfplay(pcmRate);
      if (!player.stdin) {
        console.error("ffplay stdin unavailable.");
        await shutdown(1);
        return;
      }

      ws.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: prompt }],
          },
        })
      );
      ws.send(JSON.stringify({ type: "response.create" }));
      promptSent = true;
      console.log("Requested response for prompt:", JSON.stringify(prompt));
      return;
    }

    const audioTypes = new Set(["response.output_audio.delta", "response.audio.delta"]);
    if (audioTypes.has(ev.type) && ev.delta && player?.stdin?.writable) {
      try {
        await writeChunk(player.stdin, Buffer.from(ev.delta, "base64"));
      } catch (e) {
        console.error("PCM write failed:", e);
      }
      return;
    }

    if (ev.type === "response.done" && !responseDoneHandled) {
      responseDoneHandled = true;
      console.log("response.done");
      if (player?.stdin?.writable) player.stdin.end();
      if (player) {
        player.once("close", () => void shutdown(0));
        exitTimer = setTimeout(() => void shutdown(0), 120_000);
      } else {
        exitTimer = setTimeout(() => void shutdown(0), 500);
      }
    }
  });

  ws.on("close", () => {
    if (player?.stdin?.writable) player.stdin.end();
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    shutdown(1);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
