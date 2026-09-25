import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function worker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

const env = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};

const context = {
  waitUntil() {},
  passThroughOnException() {},
};

test("server-renders the OpsDeck dashboard", async () => {
  const handler = await worker();
  const response = await handler.fetch(new Request("http://localhost/", {
    headers: { accept: "text/html" },
  }), env, context);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>OpsDeck/);
  assert.match(html, /Infrastructure console/);
  assert.match(html, /Limited access/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Codex is working/i);
});

test("health route reports the controlled dashboard", async () => {
  const handler = await worker();
  const response = await handler.fetch(new Request("http://localhost/api/health"), env, context);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "opsdeck-dashboard",
    mode: "controlled",
  });
});

test("snapshot route loads the deployment configuration", async () => {
  process.env.OPSDECK_CONFIG_PATH = fileURLToPath(new URL("../config/opsdeck.json", import.meta.url));
  const handler = await worker();
  const response = await handler.fetch(new Request("http://localhost/api/live/snapshot"), env, context);
  delete process.env.OPSDECK_CONFIG_PATH;
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.mode, "mock");
  assert.equal(payload.configuration.version, 1);
  assert.deepEqual(payload.configuration.applications, []);
});

test("ships a versioned dashboard configuration with a durable data volume", async () => {
  const [configurationText, compose] = await Promise.all([
    readFile(new URL("../config/opsdeck.json", import.meta.url), "utf8"),
    readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
  ]);
  const configuration = JSON.parse(configurationText);
  assert.equal(configuration.version, 1);
  assert.deepEqual(configuration.applications, []);
  assert.deepEqual(configuration.containerAliases, {});
  assert.equal(configuration.settings.refreshIntervalSeconds, 10);
  assert.deepEqual(configuration.savedLogViews, []);
  assert.match(compose, /OPSDECK_CONFIG_PATH:\s*\/var\/lib\/opsdeck\/dashboard\.json/);
  assert.match(compose, /opsdeck-data:\/var\/lib\/opsdeck/);
});

test("administrative authentication mints a token that can persist configuration", async () => {
  const configurationPath = join(tmpdir(), `opsdeck-config-${process.pid}-${Date.now()}.json`);
  process.env.OPSDECK_AUTH_PROVIDER = "secret";
  process.env.OPSDECK_ADMIN_SECRET = "a".repeat(64);
  process.env.OPSDECK_SESSION_SECRET = "b".repeat(64);
  process.env.OPSDECK_CONFIG_PATH = configurationPath;
  const handler = await worker();
  const elevationResponse = await handler.fetch(new Request("http://localhost/api/session/elevate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "test-admin", password: "a".repeat(64) }) }), env, context);
  assert.equal(elevationResponse.status, 200);
  const elevation = await elevationResponse.json();
  assert.equal(elevation.username, "test-admin");
  const configuration = { version: 1, host: { displayName: "Test host" }, applications: [], containerAliases: {}, settings: { refreshIntervalSeconds: 10, elevationTimeoutSeconds: 600, managedServices: ["nginx.service", "docker.service"] }, savedLogViews: [{ id: "errors", name: "Errors", level: "error", query: "" }] };
  const saveResponse = await handler.fetch(new Request("http://localhost/api/configuration", { method: "PUT", headers: { "content-type": "application/json", authorization: `OpsDeck-Elevation ${elevation.token}` }, body: JSON.stringify(configuration) }), env, context);
  assert.equal(saveResponse.status, 200);
  assert.deepEqual(JSON.parse(await readFile(configurationPath, "utf8")), configuration);
  await rm(configurationPath, { force: true });
  delete process.env.OPSDECK_AUTH_PROVIDER;
  delete process.env.OPSDECK_ADMIN_SECRET;
  delete process.env.OPSDECK_SESSION_SECRET;
  delete process.env.OPSDECK_CONFIG_PATH;
});

test("elevated system actions are forwarded only to the constrained agent route", async () => {
  const agent = createServer((request, response) => {
    assert.equal(request.url, "/v1/system/reboot");
    assert.equal(request.headers.authorization, "Bearer agent-token");
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ job: { id: "a".repeat(24), action: "reboot", status: "running", startedAt: new Date().toISOString() } }));
  });
  await new Promise((resolve) => agent.listen(0, "127.0.0.1", resolve));
  const address = agent.address();
  assert.equal(typeof address, "object");
  process.env.OPSDECK_AUTH_PROVIDER = "secret";
  process.env.OPSDECK_ADMIN_SECRET = "c".repeat(64);
  process.env.OPSDECK_SESSION_SECRET = "d".repeat(64);
  process.env.OPSDECK_AGENT_TOKEN = "agent-token";
  process.env.OPSDECK_AGENT_URL = `http://127.0.0.1:${address.port}`;
  try {
    const handler = await worker();
    const elevationResponse = await handler.fetch(new Request("http://localhost/api/session/elevate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "test-admin", password: "c".repeat(64) }) }), env, context);
    const elevation = await elevationResponse.json();
    const denied = await handler.fetch(new Request("http://localhost/api/live/system/reboot", { method: "POST" }), env, context);
    assert.equal(denied.status, 403);
    const accepted = await handler.fetch(new Request("http://localhost/api/live/system/reboot", { method: "POST", headers: { authorization: `OpsDeck-Elevation ${elevation.token}` } }), env, context);
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).job.action, "reboot");
  } finally {
    agent.close();
    delete process.env.OPSDECK_AUTH_PROVIDER;
    delete process.env.OPSDECK_ADMIN_SECRET;
    delete process.env.OPSDECK_SESSION_SECRET;
    delete process.env.OPSDECK_AGENT_TOKEN;
    delete process.env.OPSDECK_AGENT_URL;
  }
});
