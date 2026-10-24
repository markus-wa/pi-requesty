import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

// The extension resolves the agent directory once per call, so pointing
// PI_CODING_AGENT_DIR at a fixture directory keeps every test off the real
// ~/.pi/agent.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-requesty-prices-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { clearConfigValueCache } = await import("../credentials.js");
const { default: requestyExtension } = await import("../requesty.js");

const AUTH_PATH = path.join(agentDir, "auth.json");
const MODELS_PATH = path.join(agentDir, "models.json");

function writeAuthJson(value) {
  fs.writeFileSync(AUTH_PATH, JSON.stringify(value, null, 2));
}

function writeModelsJson(value) {
  fs.writeFileSync(MODELS_PATH, JSON.stringify(value, null, 2));
}

function createPi() {
  const commands = new Map();
  const providers = new Map();
  return {
    commands,
    providers,
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerProvider(name, provider) {
      providers.set(name, provider);
    },
  };
}

function createContext() {
  const notifications = [];
  return {
    notifications,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus() {},
    },
  };
}

/**
 * Stub `fetch` with one catalog payload per model.
 *
 * A field the caller omits or sets to `null` is what Requesty returns for a
 * routing alias: the key is simply absent from the payload.
 */
function stubFetch(models) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      data: models.map((model) => ({
        id: "unset/model",
        name: "Unset",
        supports_reasoning: false,
        context_window: 1000,
        max_output_tokens: 100,
        ...model,
      })),
    }),
  });
  return {
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** A models.json holding one requesty model with the given cost. */
function modelsJsonWith(model) {
  return {
    providers: {
      requesty: {
        name: "Requesty",
        baseUrl: "https://router.test/v1",
        api: "openai-completions",
        models: [model],
      },
    },
  };
}

function costOf(pi, id) {
  const models = pi.providers.get("requesty")?.models ?? [];
  return models.find((model) => model.id === id)?.cost;
}

function assertCost(actual, expected, label) {
  assert.ok(actual, `${label}: no cost found`);
  for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
    assert.ok(
      Math.abs(actual[field] - expected[field]) < 1e-6,
      `${label}: ${field} was ${actual[field]}, expected ${expected[field]}`,
    );
  }
}

let activeStub;

beforeEach(() => {
  clearConfigValueCache();
  fs.rmSync(AUTH_PATH, { force: true });
  fs.rmSync(MODELS_PATH, { force: true });
  writeAuthJson({ requesty: { type: "api_key", key: "sk-test" } });
});

afterEach(() => {
  activeStub?.restore();
  activeStub = undefined;
});

after(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("catalog price fallback", () => {
  it("keeps the models.json price of a model the catalog does not price", async () => {
    activeStub = stubFetch([{ id: "policy/deepseek-v4.1-flash" }]);
    writeModelsJson(
      modelsJsonWith({
        id: "policy/deepseek-v4.1-flash",
        cost: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0 },
      }),
    );

    const pi = createPi();
    await requestyExtension(pi);

    assertCost(
      costOf(pi, "policy/deepseek-v4.1-flash"),
      { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0 },
      "routing alias",
    );
  });

  it("prefers the catalog price when the catalog publishes one", async () => {
    activeStub = stubFetch([
      {
        id: "melious/deepseek-v4.1-flash",
        input_price: 0.23,
        output_price: 1.14,
        cached_price: 0.02,
        caching_price: 0,
      },
    ]);
    writeModelsJson(
      modelsJsonWith({
        id: "melious/deepseek-v4.1-flash",
        cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
      }),
    );

    const pi = createPi();
    await requestyExtension(pi);

    // Costs are per million tokens here: Pi divides by 1e6 when it prices.
    assertCost(
      costOf(pi, "melious/deepseek-v4.1-flash"),
      { input: 230_000, output: 1_140_000, cacheRead: 20_000, cacheWrite: 0 },
      "catalog-priced model",
    );
  });

  it("registers zeros when neither the catalog nor models.json prices a model", async () => {
    activeStub = stubFetch([{ id: "brand-new/model" }]);
    writeModelsJson(modelsJsonWith({ id: "policy/other" }));

    const pi = createPi();
    await requestyExtension(pi);

    assertCost(
      costOf(pi, "brand-new/model"),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      "unpriced new model",
    );
  });

  it("keeps the preserved price when the sync command rewrites models.json", async () => {
    activeStub = stubFetch([{ id: "policy/deepseek-v4.1-flash" }]);
    writeModelsJson(
      modelsJsonWith({
        id: "policy/deepseek-v4.1-flash",
        cost: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0 },
      }),
    );

    const pi = createPi();
    await requestyExtension(pi);
    const ctx = createContext();
    await pi.commands.get("requesty-models-sync").handler([], ctx);

    const written = JSON.parse(fs.readFileSync(MODELS_PATH, "utf8"));
    const cost = written.providers.requesty.models.find((model) => model.id === "policy/deepseek-v4.1-flash")?.cost;
    assertCost(cost, { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0 }, "synced file");
    assert.equal(ctx.notifications.at(-1)?.level, "success");
  });
});
