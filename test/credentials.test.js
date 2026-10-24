import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

// The extension resolves the agent directory once per call, so pointing
// PI_CODING_AGENT_DIR at a fixture directory keeps every test off the real
// ~/.pi/agent.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-requesty-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { clearConfigValueCache, isCommandConfigValue, readStoredApiKey, resolveConfigValue } = await import(
  "../credentials.js"
);
const { default: requestyExtension } = await import("../requesty.js");

const AUTH_PATH = path.join(agentDir, "auth.json");
const MODELS_PATH = path.join(agentDir, "models.json");
const KEYRING = { type: "api_key", key: "!printf sk-from-keyring" };

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
  const statuses = [];
  return {
    notifications,
    statuses,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(key, value) {
        statuses.push({ key, value });
      },
    },
  };
}

/** Stub `fetch`, recording the request and answering (or failing) on demand. */
function stubFetch({ models = [{ id: "policy/deepseek-v4.1-flash" }], failure, status = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, authorization: init?.headers?.Authorization, signal: init?.signal });
    if (failure) {
      throw failure;
    }
    if (status !== 200) {
      const statusText = status === 401 ? "Unauthorized" : "";
      return { ok: false, status, statusText, json: async () => ({}) };
    }
    return {
      ok: true,
      status,
      statusText: "OK",
      json: async () => ({
        data: models.map((model) => ({
          supports_reasoning: true,
          input_price: 1,
          output_price: 2,
          cached_price: 0.1,
          caching_price: 0.2,
          context_window: 1000,
          max_output_tokens: 100,
          ...model,
        })),
      }),
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/**
 * Run the extension once against the given fixtures, capturing fetch and warns.
 *
 * `during` runs while the fetch stub is still installed, for tests that exercise
 * the slash command rather than extension startup.
 */
async function runStartup(fetchOptions = {}, fixtures = {}, during) {
  if (fixtures.auth) {
    writeAuthJson({ requesty: fixtures.auth });
  }
  if (fixtures.models !== undefined) {
    writeModelsJson(fixtures.models);
  }

  const fetchStub = stubFetch(fetchOptions);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const pi = createPi();

  try {
    await requestyExtension(pi);
    const result = { pi, calls: fetchStub.calls, warnings };
    if (during) {
      await during(result);
    }
    return result;
  } finally {
    fetchStub.restore();
    console.warn = originalWarn;
  }
}

beforeEach(() => {
  clearConfigValueCache();
  fs.rmSync(AUTH_PATH, { force: true });
  fs.rmSync(MODELS_PATH, { force: true });
});

afterEach(() => {
  clearConfigValueCache();
});

after(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("resolveConfigValue", () => {
  const cases = [
    ["a !command's trimmed stdout", "!printf '  sk-from-secret-tool\\n'", {}, "sk-from-secret-tool"],
    ["an unset variable", "$PI_REQUESTY_DEFINITELY_UNSET", {}, undefined],
    ["a failing command", "!exit 1", {}, undefined],
    ["a command that does not exist", "!command-that-does-not-exist", {}, undefined],
    ["$NAME", "$REQUESTY_API_KEY", { REQUESTY_API_KEY: "sk-env" }, "sk-env"],
    ["${NAME}", "${REQUESTY_API_KEY}", { REQUESTY_API_KEY: "sk-env" }, "sk-env"],
    ["a variable inside a literal", "prefix-$REQUESTY_API_KEY-suffix", { REQUESTY_API_KEY: "sk-env" }, "prefix-sk-env-suffix"],
    ["a variable name that is longer than the one set", "$REQUESTY_API_KEY_OTHER", { REQUESTY_API_KEY: "sk-env" }, undefined],
    ["$$ as a literal $", "sk-$$literal", {}, "sk-$literal"],
    ["$! as a literal !", "sk-$!", {}, "sk-!"],
    ["a literal", "rqsty-sk-abc", {}, "rqsty-sk-abc"],
    ["an empty value", "", {}, undefined],
    ["undefined", undefined, {}, undefined],
  ];

  for (const [name, config, env, expected] of cases) {
    it(`resolves ${name}`, () => {
      assert.equal(resolveConfigValue(config, env), expected);
    });
  }

  it("identifies command values", () => {
    assert.equal(isCommandConfigValue("!secret-tool lookup requesty api-key"), true);
    assert.equal(isCommandConfigValue("rqsty-sk-abc"), false);
  });

  it("caches a command result for the process lifetime", () => {
    const counter = path.join(agentDir, "counter");
    const command = `!sh -c 'echo x >> ${counter}; cat ${counter}'`;
    assert.equal(resolveConfigValue(command), "x");
    assert.equal(resolveConfigValue(command), "x");
    assert.equal(fs.readFileSync(counter, "utf8"), "x\n");
  });
});

describe("readStoredApiKey", () => {
  it("resolves a secret-manager command from auth.json", () => {
    writeAuthJson({ requesty: KEYRING });
    assert.deepEqual(readStoredApiKey("requesty"), { key: "sk-from-keyring", source: AUTH_PATH });
  });

  it("resolves a literal and a $VAR key from auth.json", () => {
    writeAuthJson({ requesty: { type: "api_key", key: "rqsty-sk-literal" } });
    assert.equal(readStoredApiKey("requesty").key, "rqsty-sk-literal");

    writeAuthJson({ requesty: { type: "api_key", key: "$REQUESTY_TEST_KEY" } });
    clearConfigValueCache();
    assert.equal(readStoredApiKey("requesty", { env: { REQUESTY_TEST_KEY: "sk-env" } }).key, "sk-env");
  });

  const reasons = [
    ["a missing credential", undefined, /no "requesty" credential/],
    ["an oauth credential", { type: "oauth", access: "token" }, /is of type "oauth"/],
    ["a credential without a key", { type: "api_key" }, /has no key/],
    ["a key whose command fails", { type: "api_key", key: "!exit 1" }, /did not resolve/],
    ["an unreadable auth.json", "not json", /no "requesty" credential/],
  ];

  for (const [name, credential, pattern] of reasons) {
    it(`explains ${name} instead of throwing`, () => {
      if (credential === "not json") {
        fs.writeFileSync(AUTH_PATH, credential);
      } else if (credential) {
        writeAuthJson({ requesty: credential });
      }
      assert.match(readStoredApiKey("requesty").reason, pattern);
    });
  }
});

describe("startup discovery", () => {
  const sources = [
    ["the auth.json command", { auth: KEYRING }, "Bearer sk-from-keyring"],
    [
      "auth.json over a models.json apiKey",
      { auth: KEYRING, models: { providers: { requesty: { apiKey: "sk-from-models-json" } } } },
      "Bearer sk-from-keyring",
    ],
    [
      "a models.json literal apiKey",
      { models: { providers: { requesty: { apiKey: "sk-from-models-json" } } } },
      "Bearer sk-from-models-json",
    ],
    [
      "a models.json !command apiKey",
      { models: { providers: { requesty: { apiKey: "!printf sk-from-models-command" } } } },
      "Bearer sk-from-models-command",
    ],
  ];

  for (const [name, fixtures, expected] of sources) {
    it(`uses ${name} as the bearer token`, async () => {
      const { calls } = await runStartup({}, fixtures);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://router.requesty.ai/v1/models");
      assert.equal(calls[0].authorization, expected);
    });
  }

  it("registers the discovered models without the key that came from auth.json", async () => {
    const { pi } = await runStartup({}, { auth: KEYRING });

    assert.equal(pi.providers.get("requesty").models.length, 1);
    assert.equal(pi.providers.get("requesty").apiKey, undefined);
  });

  it("stays silent and off the network when no credential is configured", async () => {
    const { pi, calls, warnings } = await runStartup();

    assert.equal(calls.length, 0);
    assert.deepEqual(warnings, []);
    assert.equal(pi.providers.size, 0);
  });

  it("still warns when a configured credential cannot discover models", async () => {
    const { warnings } = await runStartup({ status: 401 }, { auth: KEYRING });

    assert.match(warnings.join("\n"), /HTTP 401/);
  });

  it("bounds the discovery request so an unresponsive endpoint cannot block startup", async () => {
    const { calls } = await runStartup({}, { auth: KEYRING });

    assert.equal(calls[0].signal instanceof AbortSignal, true);
  });

  it("reports a discovery timeout instead of hanging", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    const { warnings } = await runStartup({ failure: timeout }, { auth: KEYRING });

    assert.match(warnings.join("\n"), /no response from https:\/\/router\.requesty\.ai\/v1\/models within 10000ms/);
  });

  const malformed = [
    ["providers as a string", { providers: "not-an-object" }, /does not define providers as an object/],
    ["providers as an array", { providers: [] }, /does not define providers as an object/],
    ["a provider entry that is not an object", { providers: { requesty: "nope" } }, /providers\.requesty in .* is not an object/],
  ];

  for (const [name, models, pattern] of malformed) {
    it(`refuses to discover with ${name} and makes no request`, async () => {
      const { calls, warnings } = await runStartup({}, { auth: KEYRING, models });

      assert.equal(calls.length, 0);
      assert.match(warnings.join("\n"), pattern);
    });
  }
});

describe("/requesty-models-sync", () => {
  async function runCommand(fixtures = { auth: KEYRING }) {
    const context = createContext();
    const { pi } = await runStartup({}, fixtures, async (started) => {
      await started.pi.commands.get("requesty-models-sync").handler("", context);
    });
    return { context, pi };
  }

  const malformed = [
    ["providers as an array", { providers: [] }, /does not define providers as an object/],
    ["a provider entry that is not an object", { providers: { requesty: "nope" } }, /providers\.requesty in .* is not an object/],
  ];

  for (const [name, models, pattern] of malformed) {
    it(`reports ${name} and leaves the file untouched`, async () => {
      writeModelsJson(models);
      const before = fs.readFileSync(MODELS_PATH, "utf8");

      const { context } = await runCommand();

      assert.equal(fs.readFileSync(MODELS_PATH, "utf8"), before);
      assert.equal(context.notifications.at(-1).level, "error");
      assert.match(context.notifications.at(-1).message, pattern);
    });
  }

  it("writes discovered models without persisting a keyring key", async () => {
    const { context } = await runCommand();

    const written = fs.readFileSync(MODELS_PATH, "utf8");
    assert.equal(JSON.parse(written).providers.requesty.models.length, 1);
    assert.equal(JSON.parse(written).providers.requesty.apiKey, undefined);
    assert.equal(written.includes("sk-from-keyring"), false);
    assert.match(context.notifications.at(-1).message, /using the key from/);
  });

  it("keeps existing provider fields while replacing models", async () => {
    writeModelsJson({
      providers: { requesty: { baseUrl: "https://example.test/v1", apiKey: "sk-from-models-json", custom: true } },
    });

    await runCommand();

    const { requesty } = JSON.parse(fs.readFileSync(MODELS_PATH, "utf8")).providers;
    assert.equal(requesty.baseUrl, "https://example.test/v1");
    assert.equal(requesty.custom, true);
    assert.equal(requesty.apiKey, "sk-from-models-json");
    assert.equal(requesty.models.length, 1);
  });

  it("explains both accepted key locations when nothing is configured", async () => {
    const { context } = await runCommand({});

    const message = context.notifications.at(-1);
    assert.equal(message.level, "error");
    assert.match(message.message, /No Requesty credential available/);
    assert.match(message.message, /auth\.json/);
    assert.match(message.message, /secret-tool lookup requesty api-key/);
    assert.match(message.message, /models\.json/);
  });

  it("creates models.json when it does not exist", async () => {
    assert.equal(fs.existsSync(MODELS_PATH), false);

    await runCommand();

    assert.equal(JSON.parse(fs.readFileSync(MODELS_PATH, "utf8")).providers.requesty.models.length, 1);
  });
});
