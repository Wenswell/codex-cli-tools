import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { ChatToResponsesSseTransform, chatToResponses, createResponsesChatToolContext, responsesToChat } from "../dist/lib/responses-to-chat.js";

test("Responses request maps to the Chat Completions contract", () => {
  const converted = responsesToChat({
    model: "stealth/ox-alpha",
    instructions: "Be concise.",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Weather" }, { type: "input_image", image_url: "https://example.test/image.png", detail: "low" }] },
      { type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"Shanghai"}' },
      { type: "function_call_output", call_id: "call_1", output: "sunny" },
    ],
    stream: true,
    max_output_tokens: 120,
    reasoning: { effort: "high" },
    tools: [{ type: "function", name: "weather", description: "Get weather", parameters: { type: "object" }, strict: true }],
    tool_choice: { type: "function", name: "weather" },
    text: { format: { type: "json_schema", name: "result", schema: { type: "object" }, strict: true } },
  });

  assert.deepEqual(converted, {
    model: "stealth/ox-alpha",
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: [{ type: "text", text: "Weather" }, { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "low" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"Shanghai"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ],
    max_completion_tokens: 120,
    reasoning_effort: "high",
    tools: [{ type: "function", function: { name: "weather", description: "Get weather", parameters: { type: "object" }, strict: true } }],
    tool_choice: { type: "function", function: { name: "weather" } },
    response_format: { type: "json_schema", json_schema: { name: "result", schema: { type: "object" }, strict: true } },
  });
});

test("Responses request rejects unsupported message content", () => {
  assert.throws(() => responsesToChat({
    model: "stealth/ox-alpha",
    input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file_1" }] }],
  }), /unsupported Responses message content: input_file/);
});

test("namespace tools flatten for Chat and restore for Responses", () => {
  const context = createResponsesChatToolContext();
  const request = responsesToChat({
    model: "stealth/ox-alpha",
    input: "Read the file",
    tools: [{
      type: "namespace",
      name: "mcp__files__",
      tools: [{ type: "function", name: "read", description: "Read a file", parameters: { type: "object" } }],
    }],
  }, context);
  assert.equal(request.tools[0].function.name, "mcp__files____read");

  const response = chatToResponses({
    id: "chatcmpl_namespace",
    choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "call_1", function: { name: "mcp__files____read", arguments: "{}" } }] } }],
  }, context);
  assert.equal(response.output[0].name, "read");
  assert.equal(response.output[0].namespace, "mcp__files__");
});

test("hosted web search is omitted from Chat tools", () => {
  const converted = responsesToChat({
    model: "stealth/ox-alpha",
    input: "Hello",
    tools: [{ type: "web_search" }, { type: "function", name: "local", parameters: { type: "object" } }],
  });
  assert.deepEqual(converted.tools, [{ type: "function", function: { name: "local", parameters: { type: "object" } } }]);
});

test("Chat Completions JSON maps to a Responses object", () => {
  const converted = chatToResponses({
    id: "chatcmpl_1",
    created: 123,
    model: "stealth/ox-alpha",
    choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "Checking", tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"Shanghai"}' } }] } }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 1 } },
  });

  assert.equal(converted.object, "response");
  assert.equal(converted.status, "completed");
  assert.equal(converted.model, "stealth/ox-alpha");
  assert.equal(converted.output[0].type, "message");
  assert.deepEqual(converted.output[0].content, [{ type: "output_text", text: "Checking", annotations: [] }]);
  assert.deepEqual({ ...converted.output[1], id: "fixed" }, { id: "fixed", type: "function_call", status: "completed", call_id: "call_1", name: "weather", arguments: '{"city":"Shanghai"}' });
  assert.deepEqual(converted.usage, { input_tokens: 4, input_tokens_details: { cached_tokens: 1 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 6 });
});

test("Chat SSE maps incrementally and terminates with response.completed", async () => {
  const transform = new ChatToResponsesSseTransform();
  const chunks = [];
  transform.on("data", (chunk) => chunks.push(chunk.toString()));
  await new Promise((resolve, reject) => Readable.from([
    'data: {"id":"chatcmpl_1","created":123,"model":"stealth/ox-alpha","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl_1","model":"stealth/ox-alpha","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl_1","model":"stealth/ox-alpha","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
    "data: [DONE]\n\n",
  ]).pipe(transform).on("finish", resolve).on("error", reject));

  const events = chunks.join("");
  assert.match(events, /event: response\.created/);
  assert.match(events, /"type":"response.output_text.delta".*"delta":"Hel"/);
  assert.match(events, /"type":"response.output_text.done".*"text":"Hello"/);
  assert.match(events, /event: response\.completed/);
  assert.match(events, /"status":"completed"/);
  assert.doesNotMatch(events, /data: \[DONE\]/);
});

test("Chat stream completion is emitted when finish_reason precedes a closed stream", async () => {
  const transform = new ChatToResponsesSseTransform();
  const chunks = [];
  transform.on("data", (chunk) => chunks.push(chunk.toString()));
  await new Promise((resolve, reject) => Readable.from([
    'data: {"id":"chatcmpl_1","model":"stealth/ox-alpha","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
  ]).pipe(transform).on("finish", resolve).on("error", reject));
  assert.match(chunks.join(""), /event: response\.completed/);
});

test("Chat stream completion is emitted when upstream disconnects after finish_reason", async () => {
  const transform = new ChatToResponsesSseTransform();
  const chunks = [];
  transform.on("data", (chunk) => chunks.push(chunk.toString()));
  transform.write('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n');
  assert.equal(transform.endAfterUpstreamDisconnect(), true);
  await new Promise((resolve, reject) => transform.on("finish", resolve).on("error", reject));
  assert.match(chunks.join(""), /event: response\.completed/);
});

test("Chat refusal stream maps to refusal content events", async () => {
  const transform = new ChatToResponsesSseTransform();
  const chunks = [];
  transform.on("data", (chunk) => chunks.push(chunk.toString()));
  await new Promise((resolve, reject) => Readable.from([
    'data: {"id":"chatcmpl_1","model":"stealth/ox-alpha","choices":[{"index":0,"delta":{"refusal":"No"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ]).pipe(transform).on("finish", resolve).on("error", reject));

  const events = chunks.join("");
  assert.match(events, /"type":"response.content_part.added".*"type":"refusal","refusal":""/);
  assert.match(events, /"type":"response.refusal.delta".*"delta":"No"/);
  assert.match(events, /"type":"response.refusal.done".*"refusal":"No"/);
  assert.doesNotMatch(events, /response.output_text.done/);
});

test("Chat stream preserves UTF-8 characters split across buffers", async () => {
  const transform = new ChatToResponsesSseTransform();
  const chunks = [];
  transform.on("data", (chunk) => chunks.push(chunk.toString()));
  const event = Buffer.from('data: {"choices":[{"delta":{"content":"中文"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  const split = event.indexOf(Buffer.from("中")) + 1;
  await new Promise((resolve, reject) => Readable.from([
    event.subarray(0, split),
    event.subarray(split),
  ]).pipe(transform).on("finish", resolve).on("error", reject));
  assert.match(chunks.join(""), /"text":"中文"/);
});
