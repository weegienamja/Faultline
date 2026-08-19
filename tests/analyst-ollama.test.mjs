import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import {
  AnalystTransportError,
  assertLoopbackEndpoint,
  createOllamaClient,
  isLocalModel,
  streamJsonLines
} from "../src/analyst/ollama.mjs";
import { DEFAULT_MODEL, assertModelName, parsePullProgress, resolveStatus } from "../src/analyst/lifecycle.mjs";

// Transport + lifecycle. Every test drives an injected fetch, so nothing here
// needs Ollama, a model, a GPU or the Internet.

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(payload) };
}

function ndjsonResponse(frames, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    body: Readable.from(frames.map(frame => `${JSON.stringify(frame)}\n`))
  };
}

// --- endpoint boundary ------------------------------------------------------

test("loopback endpoints are accepted", () => {
  assert.equal(assertLoopbackEndpoint("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(assertLoopbackEndpoint("http://[::1]:11434"), "http://[::1]:11434");
});

test("a non-loopback Ollama host is refused", () => {
  for (const endpoint of [
    "http://10.0.0.5:11434",
    "http://ollama.internal:11434",
    "https://api.openai.com",
    "http://evil.example",
    // "localhost" is a name and can be re-pointed, so it is not accepted.
    "http://localhost:11434"
  ]) {
    assert.throws(() => assertLoopbackEndpoint(endpoint), AnalystTransportError, `expected refusal for ${endpoint}`);
  }
});

test("an endpoint carrying a path, query or credentials is refused", () => {
  assert.throws(() => assertLoopbackEndpoint("http://127.0.0.1:11434/api/chat"), AnalystTransportError);
  assert.throws(() => assertLoopbackEndpoint("http://127.0.0.1:11434/?x=1"), AnalystTransportError);
  assert.throws(() => assertLoopbackEndpoint("http://user:pw@127.0.0.1:11434"), AnalystTransportError);
});

test("the client cannot be constructed against a remote host", () => {
  assert.throws(() => createOllamaClient({ endpoint: "http://192.168.1.10:11434", fetchImpl: async () => ({}) }),
    AnalystTransportError);
});

test("every request goes to the configured loopback origin", async () => {
  const seen = [];
  const client = createOllamaClient({
    fetchImpl: async url => {
      seen.push(url);
      return jsonResponse({ models: [] });
    }
  });
  await client.listModels();
  await client.version();
  assert.ok(seen.length >= 2);
  for (const url of seen) assert.ok(url.startsWith("http://127.0.0.1:11434/api/"), `unexpected destination ${url}`);
});

// --- cloud model exclusion --------------------------------------------------

test("remote-backed models are not local", () => {
  assert.equal(isLocalModel({ name: "qwen3:8b" }), true);
  assert.equal(isLocalModel({ name: "kimi-k3:cloud", remote_host: "https://ollama.com" }), false);
  assert.equal(isLocalModel({ name: "glm-5.2:cloud", remote_model: "glm-5.2" }), false);
  // The tag alone is enough, even without the metadata.
  assert.equal(isLocalModel({ name: "something:cloud" }), false);
});

test("model discovery hides cloud models entirely", async () => {
  const client = createOllamaClient({
    fetchImpl: async () => jsonResponse({
      models: [
        { name: "qwen3:8b", size: 5225388164, details: { parameter_size: "8.2B" }, capabilities: ["tools"] },
        { name: "kimi-k3:cloud", remote_host: "https://ollama.com", size: 308 },
        { name: "glm-5.2:cloud", remote_model: "glm-5.2", size: 338 }
      ]
    })
  });
  const discovery = await client.listModels();
  assert.deepEqual(discovery.models.map(entry => entry.name), ["qwen3:8b"]);
  assert.equal(discovery.excludedRemote, 2);
});

test("a cloud model name is refused as configuration", () => {
  assert.throws(() => assertModelName("kimi-k3:cloud"), /Cloud-hosted models are not permitted/);
});

test("model names that are paths, urls or shell fragments are refused", () => {
  for (const name of ["../../etc/passwd", "http://evil/model", "qwen3;rm -rf /", "qwen3 8b", "", "a".repeat(200)]) {
    assert.throws(() => assertModelName(name), /Invalid Analyst model name|Cloud-hosted/);
  }
  assert.equal(assertModelName("qwen3:8b"), "qwen3:8b");
});

// --- lifecycle states -------------------------------------------------------

test("Ollama not running resolves to OLLAMA_UNAVAILABLE", async () => {
  const client = createOllamaClient({
    fetchImpl: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }
  });
  const status = await resolveStatus(client, { model: DEFAULT_MODEL });
  assert.equal(status.state, "OLLAMA_UNAVAILABLE");
  assert.equal(status.ready, false);
  assert.ok(status.remedy);
});

test("model missing resolves to MODEL_NOT_INSTALLED", async () => {
  const client = createOllamaClient({
    fetchImpl: async url => url.endsWith("/api/version")
      ? jsonResponse({ version: "0.32.5" })
      : jsonResponse({ models: [{ name: "llama3:8b", size: 1 }] })
  });
  const status = await resolveStatus(client, { model: "qwen3:8b" });
  assert.equal(status.state, "MODEL_NOT_INSTALLED");
  assert.equal(status.ready, false);
});

test("model installed resolves to MODEL_READY with tool support", async () => {
  const client = createOllamaClient({
    fetchImpl: async url => url.endsWith("/api/version")
      ? jsonResponse({ version: "0.32.5" })
      : jsonResponse({ models: [{ name: "qwen3:8b", size: 5225388164, details: { parameter_size: "8.2B" }, capabilities: ["tools", "thinking"] }] })
  });
  const status = await resolveStatus(client, { model: "qwen3:8b" });
  assert.equal(status.state, "MODEL_READY");
  assert.equal(status.ready, true);
  assert.equal(status.supportsTools, true);
  assert.equal(status.local, true);
});

test("a discovery failure resolves to MODEL_ERROR rather than throwing", async () => {
  const client = createOllamaClient({
    fetchImpl: async url => url.endsWith("/api/version")
      ? jsonResponse({ version: "0.32.5" })
      : jsonResponse({}, { ok: false, status: 500 })
  });
  const status = await resolveStatus(client, { model: "qwen3:8b" });
  assert.equal(status.state, "MODEL_ERROR");
  assert.equal(status.ready, false);
});

// --- pull progress ----------------------------------------------------------

test("pull progress parses byte counters into bounded percentages", () => {
  const progress = parsePullProgress({ status: "pulling 500a1f067a9f", completed: 3_758_096_384, total: 5_225_388_164 });
  assert.equal(progress.phase, "download");
  assert.equal(progress.percent, 72);
  assert.equal(progress.label, "Downloading model weights");
  assert.equal(progress.done, false);
});

test("pull progress clamps impossible counters", () => {
  // A truncated or out-of-order frame must never render a 900% progress bar.
  assert.equal(parsePullProgress({ status: "pulling x", completed: 900, total: 100 }).percent, 100);
  // Nonsensical counters are treated as absent rather than as 0%: showing an
  // empty bar claims progress information the frame did not actually carry.
  assert.equal(parsePullProgress({ status: "pulling x", completed: -50, total: 100 }).percent, null);
  assert.equal(parsePullProgress({ status: "pulling x" }).percent, null);
});

test("pull progress reports terminal and error frames", () => {
  assert.equal(parsePullProgress({ status: "success" }).done, true);
  const failed = parsePullProgress({ error: "model not found" });
  assert.equal(failed.error, true);
  assert.equal(failed.done, true);
});

test("pull streams progress frames from the transport", async () => {
  const client = createOllamaClient({
    fetchImpl: async () => ndjsonResponse([
      { status: "pulling manifest" },
      { status: "pulling abc", completed: 50, total: 100 },
      { status: "success" }
    ])
  });
  const phases = [];
  for await (const frame of client.pull("qwen3:8b")) phases.push(parsePullProgress(frame).phase);
  assert.deepEqual(phases, ["manifest", "download", "done"]);
});

// --- chat + streaming -------------------------------------------------------

test("a successful chat returns the assistant message", async () => {
  const client = createOllamaClient({
    fetchImpl: async () => jsonResponse({ message: { role: "assistant", content: "IPv6 failed at TCP." }, done: true })
  });
  const reply = await client.chat({ model: "qwen3:8b", messages: [] });
  assert.equal(reply.message.content, "IPv6 failed at TCP.");
});

test("chat never enables streaming when the non-streaming call is used", async () => {
  let sentBody = null;
  const client = createOllamaClient({
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return jsonResponse({ message: { content: "ok" } });
    }
  });
  await client.chat({ model: "qwen3:8b", messages: [], stream: true });
  assert.equal(sentBody.stream, false);
});

test("streamed chat yields each chunk", async () => {
  const client = createOllamaClient({
    fetchImpl: async () => ndjsonResponse([
      { message: { content: "IPv4 " } },
      { message: { content: "remained healthy." } },
      { done: true }
    ])
  });
  let text = "";
  for await (const chunk of client.chatStream({ model: "qwen3:8b", messages: [] })) {
    text += chunk?.message?.content || "";
  }
  assert.equal(text, "IPv4 remained healthy.");
});

test("a malformed stream line is skipped without killing the stream", async () => {
  const body = Readable.from([
    `${JSON.stringify({ message: { content: "good" } })}\n`,
    "{ not json at all\n",
    `${JSON.stringify({ done: true })}\n`
  ]);
  const frames = [];
  for await (const frame of streamJsonLines(body)) frames.push(frame);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].message.content, "good");
});

test("a malformed non-streaming response is reported, not thrown raw", async () => {
  const client = createOllamaClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>nope" }) });
  await assert.rejects(() => client.chat({ model: "qwen3:8b", messages: [] }), /malformed/);
});

test("an HTTP error from Ollama becomes a transport error", async () => {
  const client = createOllamaClient({ fetchImpl: async () => jsonResponse({}, { ok: false, status: 500 }) });
  await assert.rejects(() => client.chat({ model: "qwen3:8b", messages: [] }), AnalystTransportError);
});

test("a model call that never responds times out", async () => {
  const client = createOllamaClient({
    timeoutMs: 40,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  });
  await assert.rejects(() => client.chat({ model: "qwen3:8b", messages: [] }), /did not respond in time/);
});
