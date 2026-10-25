import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { Endpoint } from "./navigator.ts";

export const modelsDir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "open-eyes", "models");

export type Download = { url: string; size: number; sha256: string };
export type Manifest = {
  model: Download & { id: string; name: string; file: string; license: string };
  /** llama.cpp's server per `${platform}-${arch}`. */
  server: Record<string, Download & { id: string }>;
};

const LLAMA = "https://github.com/ggml-org/llama.cpp/releases/download/b11836";

// What `open-eyes model install` downloads. Gemma 4 E2B won the evaluation in #73. When our
// own fine-tuned, compressed model is published (#76, #77), only `model` changes: status then
// tells users a newer model is available, and install replaces it. Vulkan builds run on
// NVIDIA, AMD and Intel GPUs and fall back to the CPU.
export const MANIFEST: Manifest = {
  model: {
    id: "gemma-4-e2b-it-q4_0",
    name: "Gemma 4 E2B (Q4_0)",
    file: "gemma-4-E2B-it-Q4_0.gguf",
    url: "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_0.gguf",
    size: 2_841_481_184,
    sha256: "8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52",
    license: "Apache 2.0, https://huggingface.co/google/gemma-4-E2B-it",
  },
  server: {
    "linux-x64": {
      id: "llama-b11836-vulkan",
      url: `${LLAMA}/llama-b11836-bin-ubuntu-vulkan-x64.tar.gz`,
      size: 34_993_192,
      sha256: "30af031b620f09412cbbea1bac77f9bcb9d30ed7ea7ec40bca99df3bf39659da",
    },
    "linux-arm64": {
      id: "llama-b11836-vulkan",
      url: `${LLAMA}/llama-b11836-bin-ubuntu-vulkan-arm64.tar.gz`,
      size: 28_338_075,
      sha256: "dda4c41ebe4e82b61fcf232a856dde71553c973f463e213533172f6065d8f5aa",
    },
    "darwin-arm64": {
      id: "llama-b11836-metal",
      url: `${LLAMA}/llama-b11836-bin-macos-arm64.tar.gz`,
      size: 16_161_898,
      sha256: "58d8af16987720af9e0a9a0a3b6edda36045b01219651c731e6013eacaef4e1f",
    },
    "win32-x64": {
      id: "llama-b11836-vulkan",
      url: `${LLAMA}/llama-b11836-bin-win-vulkan-x64.zip`,
      size: 36_881_686,
      sha256: "cd79abc3f25bce0086918d43f7b5562dc760d9809429f1a9037941185bc7cdf4",
    },
  },
};

/** What is on disk, written after a complete install. */
export type Installed = { model: string; modelFile: string; server: string; serverBinary: string };

const platformKey = () => `${process.platform}-${process.arch}`;
export const formatSize = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

export function serverFor(manifest: Manifest): (Download & { id: string }) | undefined {
  return manifest.server[platformKey()];
}

/** The installed model and server, or undefined when they are missing or incomplete. */
export function installedNavigator(dir = modelsDir): Installed | undefined {
  try {
    const installed = JSON.parse(readFileSync(join(dir, "installed.json"), "utf8")) as Installed;
    return existsSync(installed.modelFile) && existsSync(installed.serverBinary) ? installed : undefined;
  } catch {
    return undefined;
  }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Downloads `item` to `dest`, resuming a previous partial download, and verifies its
 * checksum. A file that does not match is deleted, so a retry starts clean.
 */
export async function download(item: Download, dest: string, progress?: (done: number, total: number) => void): Promise<void> {
  const part = `${dest}.part`;
  const have = existsSync(part) ? statSync(part).size : 0;
  if (have < item.size) {
    const response = await fetch(item.url, { headers: have ? { range: `bytes=${have}-` } : {} });
    if (!response.ok || !response.body) throw new Error(`could not download ${item.url}: ${response.status} ${response.statusText}`);
    const resumed = response.status === 206;
    let done = resumed ? have : 0;
    const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => progress?.((done += chunk.length), item.size));
    await pipeline(body, createWriteStream(part, { flags: resumed ? "a" : "w" }));
  }
  if (statSync(part).size !== item.size || (await sha256Of(part)) !== item.sha256) {
    rmSync(part, { force: true });
    throw new Error(`the download of ${item.url} did not match its checksum, so it was deleted; try again`);
  }
  renameSync(part, dest);
}

function findFile(dir: string, names: string[]): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && names.includes(entry.name)) return path;
    if (entry.isDirectory()) {
      const found = findFile(path, names);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Downloads the navigator model and llama.cpp's server, then records them. Files from an
 * older install are removed once the new ones are in place.
 */
export async function installNavigator(manifest: Manifest, dir = modelsDir, progress?: (what: string, done: number, total: number) => void): Promise<Installed> {
  const server = serverFor(manifest);
  if (!server) throw new Error(`there is no llama.cpp server download for ${platformKey()}; run your own and set OPEN_EYES_MODEL_URL`);
  const previous = installedNavigator(dir);
  mkdirSync(dir, { recursive: true });

  const modelFile = join(dir, manifest.model.file);
  if (!existsSync(modelFile)) await download(manifest.model, modelFile, (done, total) => progress?.(manifest.model.name, done, total));

  const serverDir = join(dir, server.id);
  let serverBinary = existsSync(serverDir) ? findFile(serverDir, ["llama-server", "llama-server.exe"]) : undefined;
  if (!serverBinary) {
    const archive = join(dir, server.url.split("/").pop()!);
    await download(server, archive, (done, total) => progress?.("llama.cpp server", done, total));
    rmSync(serverDir, { recursive: true, force: true });
    mkdirSync(serverDir);
    await promisify(execFile)("tar", ["-xf", archive, "-C", serverDir]); // bsdtar on Windows and macOS reads zip too.
    rmSync(archive);
    serverBinary = findFile(serverDir, ["llama-server", "llama-server.exe"]);
    if (!serverBinary) throw new Error(`${server.url} has no llama-server in it`);
  }

  const installed: Installed = { model: manifest.model.id, modelFile, server: server.id, serverBinary };
  writeFileSync(join(dir, "installed.json"), `${JSON.stringify(installed, null, 2)}\n`);
  if (previous && previous.modelFile !== modelFile) rmSync(previous.modelFile, { force: true });
  if (previous && previous.server !== server.id) rmSync(join(dir, previous.server), { recursive: true, force: true });
  return installed;
}

export function navigatorStatus(manifest: Manifest, dir = modelsDir): string {
  const installed = installedNavigator(dir);
  if (!installed) {
    return `navigator model: not installed\n"open-eyes model install" downloads ${manifest.model.name}, ${formatSize(manifest.model.size)}, after asking`;
  }
  const lines = [`navigator model: ${installed.model} (${formatSize(statSync(installed.modelFile).size)})`, `server: ${installed.server}`, `folder: ${dir}`];
  if (installed.model !== manifest.model.id || installed.server !== serverFor(manifest)?.id) {
    lines.push(`a newer navigator is available: ${manifest.model.name}; "open-eyes model install" replaces it`);
  }
  return lines.join("\n");
}

/** Devices as llama-server --list-devices prints them: `  Vulkan1: NVIDIA GeForce GTX 1650 (4342 MiB, 3966 MiB free)`. */
const INTEGRATED = /\b(UHD|Iris|HD Graphics|Intel\(R\) Graphics|Radeon\(TM\) Graphics|Radeon Graphics|llvmpipe)\b/i;

/**
 * Picks the GPU for the model. Splitting it with an integrated GPU slows reading the page
 * down by ~60x (2 instead of 154 tokens/s on a laptop with a GTX 1650), so the dedicated GPU
 * with the most free memory wins; undefined leaves the choice to llama.cpp.
 */
export function pickDevice(listing: string): string | undefined {
  const devices = [...listing.matchAll(/^\s*(\S+): (.+) \((\d+) MiB, (\d+) MiB free\)/gm)].map((m) => ({ id: m[1], name: m[2], free: Number(m[4]) }));
  if (devices.length < 2) return undefined;
  const dedicated = devices.filter((device) => !INTEGRATED.test(device.name)).sort((a, b) => b.free - a.free);
  return dedicated[0]?.id;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const SERVER_START_MS = 120_000;

/** Starts llama-server with the installed model for one `do` run; `stop` ends it. */
export async function startNavigator(installed: Installed): Promise<{ endpoint: Endpoint; stop: () => void }> {
  const run = promisify(execFile);
  const device =
    process.env.OPEN_EYES_MODEL_DEVICE ||
    pickDevice((await run(installed.serverBinary, ["--list-devices"]).catch(() => ({ stdout: "" }))).stdout);
  const port = await freePort();
  // The context fits a snapshot and a dozen steps; GPU layers are fitted to free memory
  // automatically, since forcing them all fails on small GPUs (#73).
  const args = ["-m", installed.modelFile, "--jinja", "-c", "16384", "--no-webui", "--host", "127.0.0.1", "--port", String(port)];
  if (device) args.push("--device", device);
  const child = spawn(installed.serverBinary, args, { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  child.stderr.on("data", (chunk: Buffer) => (log = (log + chunk).slice(-4000)));
  let exited = false;
  child.on("exit", () => (exited = true));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + SERVER_START_MS;
  while (!exited && Date.now() < deadline) {
    if ((await fetch(`${url}/health`).catch(() => undefined))?.ok) return { endpoint: { url: `${url}/v1`, model: "" }, stop: () => child.kill() };
    await sleep(500);
  }
  child.kill();
  const errors = log.split("\n").filter((line) => /error|fail/i.test(line)).slice(-4).join("\n");
  throw new Error(`the local model did not start${errors ? `:\n${errors}` : ""}`);
}
