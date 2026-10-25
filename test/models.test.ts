import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { download, installedNavigator, installNavigator, navigatorStatus, pickDevice, type Manifest } from "../src/models.ts";

const root = mkdtempSync(join(tmpdir(), "open-eyes-models-"));
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

// A stand-in for Hugging Face and GitHub releases that honours Range requests.
const files = new Map<string, Buffer>();
const ranges: string[] = [];
const server = createServer((req, res) => {
  const body = files.get(req.url!);
  if (!body) return res.writeHead(404).end();
  const range = req.headers.range?.match(/^bytes=(\d+)-$/);
  if (range) {
    ranges.push(req.headers.range!);
    const start = Number(range[1]);
    res.writeHead(206, { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` });
    return res.end(body.subarray(start));
  }
  res.end(body);
});
let base = "";
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const weights = Buffer.from("fake gguf weights ".repeat(1000));
const item = (path: string, data: Buffer) => {
  files.set(path, data);
  return { url: base + path, size: data.length, sha256: sha256(data) };
};

describe("download", () => {
  test("downloads and verifies a file", async () => {
    const dest = join(root, "a.gguf");
    await download(item("/a.gguf", weights), dest);
    assert.deepEqual(readFileSync(dest), weights);
    assert.ok(!existsSync(`${dest}.part`));
  });

  test("resumes a partial download", async () => {
    const dest = join(root, "b.gguf");
    writeFileSync(`${dest}.part`, weights.subarray(0, 5000));
    ranges.length = 0;
    await download(item("/b.gguf", weights), dest);
    assert.deepEqual(ranges, ["bytes=5000-"]);
    assert.deepEqual(readFileSync(dest), weights);
  });

  test("deletes a file that does not match its checksum", async () => {
    const dest = join(root, "c.gguf");
    const wrong = { ...item("/c.gguf", weights), sha256: "0".repeat(64) };
    await assert.rejects(download(wrong, dest), /did not match its checksum, so it was deleted/);
    assert.ok(!existsSync(dest) && !existsSync(`${dest}.part`));
  });
});

describe("installNavigator", () => {
  // A llama.cpp release archive with the server inside a versioned folder, as published.
  const work = join(root, "archive");
  mkdirSync(join(work, "llama-b1"), { recursive: true });
  writeFileSync(join(work, "llama-b1", "llama-server"), "#!/bin/sh\n");
  writeFileSync(join(work, "llama-b1", "libggml.so"), "");
  execFileSync("tar", ["-czf", join(root, "llama.tar.gz"), "-C", work, "llama-b1"]);
  const archive = readFileSync(join(root, "llama.tar.gz"));
  const manifest = (id: string, data: Buffer): Manifest => ({
    model: { id, name: `Model ${id}`, file: `${id}.gguf`, license: "test", ...item(`/${id}.gguf`, data) },
    server: { [`${process.platform}-${process.arch}`]: { id: "llama-b1", ...item("/llama.tar.gz", archive) } },
  });

  test("installs the model and server, and reports a newer model until it is installed", async () => {
    const dir = join(root, "models");
    assert.match(navigatorStatus(manifest("v1", weights), dir), /^navigator model: not installed\n.*model install/);

    const installed = await installNavigator(manifest("v1", weights), dir);
    assert.equal(installed.serverBinary, join(dir, "llama-b1", "llama-b1", "llama-server"));
    assert.deepEqual(installedNavigator(dir), installed);
    assert.ok(!existsSync(join(dir, "llama.tar.gz")), "the archive is removed after extracting");
    assert.doesNotMatch(navigatorStatus(manifest("v1", weights), dir), /newer/);

    // Our own fine-tuned model replaces the base one.
    const tuned = manifest("v2", Buffer.from("tuned weights"));
    assert.match(navigatorStatus(tuned, dir), /^navigator model: v1 .*\n[^]*a newer navigator is available: Model v2/);
    await installNavigator(tuned, dir);
    assert.equal(installedNavigator(dir)?.model, "v2");
    assert.ok(!existsSync(join(dir, "v1.gguf")), "the old model is deleted");
  });
});

describe("pickDevice", () => {
  test("picks the dedicated GPU over an integrated one", () => {
    const listing = `Available devices:
  Vulkan0: Intel(R) UHD Graphics (TGL GT1) (23786 MiB, 19016 MiB free)
  Vulkan1: NVIDIA GeForce GTX 1650 (4342 MiB, 3966 MiB free)`;
    assert.equal(pickDevice(listing), "Vulkan1");
  });

  test("leaves a single device, or only integrated ones, to llama.cpp", () => {
    assert.equal(pickDevice("Available devices:\n  Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 11000 MiB free)"), undefined);
    assert.equal(pickDevice("  Vulkan0: Intel(R) UHD Graphics (8000 MiB, 6000 MiB free)\n  Vulkan1: llvmpipe (LLVM 19) (16000 MiB, 16000 MiB free)"), undefined);
  });
});
