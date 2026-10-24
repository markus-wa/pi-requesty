import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

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

/** Stub `fetch`, recording the discovery request instead of making it. */
function stubFetch(models = [{ id: "policy/deepseek-v4.1-flash" }], failure) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, authorization: init?.headers?.Authorization, signal: init?.signal });
    if (failure) {
      throw failure;
    }
    return {
      ok: true,
      status: 200,
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

/** Capture console.warn, so a silent startup can be asserted. */
function captureWarnings() {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  return {
    warnings,
    restore() {
      console.warn = original;
    },
  };
}

beforeEach(() => {
  clearConfigValueCache();
  fs.rmSync(AUTH_PATH, { force: true });
  fs.rmSync(MODELS_PATH, { force: true });
});

after(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("resolveConfigValue", () => {
  it("runs a !command and uses its trimmed stdout", () => {
    assert.equal(resolveConfigValue("!printf '  sk-from-secret-tool\\n'"), "sk-from-secret-tool");
  });

  it("resolves an unset variable or failing command to undefined", () => {
    assert.equal(resolveConfigValue("$PI_REQUESTY_DEFINITELY_UNSET"), undefined);
    assert.equal(resolveConfigValue("!exit 1"), undefined);
    assert.equal(resolveConfigValue("!command-that-does-not-exist"), undefined);
  });

  it("interpolates $NAME and ${NAME}", () => {
    const env = { REQUESTY_API_KEY: "sk-env" };
    assert.equal(resolveConfigValue("$REQUESTY_API_KEY", env), "sk-env");
    assert.equal(resolveConfigValue("${REQUESTY_API_KEY}", env), "sk-env");
    assert.equal(resolveConfigValue("prefix-$REQUESTY_API_KEY-suffix", env), "prefix-sk-env-suffix");
    assert.equal(resolveConfigValue("$REQUESTY_API_KEY_OTHER", env), undefined);
  });

  it("unescapes $$ and $!", () => {
    assert.equal(resolveConfigValue("sk-$$literal", {}), "sk-$literal");
    assert.equal(resolveConfigValue("!not-a-command", {}), undefined);
    assert.equal(resolveConfigValue("sk-$!", {}), "sk-!");
  });

  it("passes a literal through", () => {
    assert.equal(resolveConfigValue("rqsty-sk-abc", {}), "rqsty-sk-abc");
    assert.equal(resolveConfigValue("", {}), undefined);
    assert.equal(resolveConfigValue(undefined, {}), undefined);
  });

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
  it("resolves a secret-manager command from auth.json", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "!printf sk-from-keyring" } });
    const result = await readStoredApiKey("requesty");
    assert.deepEqual(result, { key: "sk-from-keyring", source: AUTH_PATH });
  });

  it("resolves a literal and a $VAR key from auth.json", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "rqsty-sk-literal" } });
    assert.equal((await readStoredApiKey("requesty")).key, "rqsty-sk-literal");

    writeAuthJson({ requesty: { type: "api_key", key: "$REQUESTY_TEST_KEY" } });
    clearConfigValueCache();
    assert.equal((await readStoredApiKey("requesty", { env: { REQUESTY_TEST_KEY: "sk-env" } })).key, "sk-env");
  });

  it("explains what is missing instead of throwing", async () => {
    assert.match((await readStoredApiKey("requesty")).reason, /no "requesty" credential/);

    writeAuthJson({ requesty: { type: "oauth", access: "token" } });
    assert.match((await readStoredApiKey("requesty")).reason, /is of type "oauth"/);

    writeAuthJson({ requesty: { type: "api_key" } });
    assert.match((await readStoredApiKey("requesty")).reason, /has no key/);

    writeAuthJson({ requesty: { type: "api_key", key: "!exit 1" } });
    assert.match((await readStoredApiKey("requesty")).reason, /did not resolve/);
  });

  it("ignores an unreadable auth.json", async () => {
    fs.writeFileSync(AUTH_PATH, "not json");
    assert.match((await readStoredApiKey("requesty")).reason, /no "requesty" credential/);
  });
});

describe("startup discovery", () => {
  it("uses the auth.json command as the bearer token", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "!printf sk-from-keyring" } });
    const fetchStub = stubFetch();
    const pi = createPi();

    try {
      await requestyExtension(pi);
    } finally {
      fetchStub.restore();
    }

    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0].url, "https://router.requesty.ai/v1/models");
    assert.equal(fetchStub.calls[0].authorization, "Bearer sk-from-keyring");
    assert.equal(pi.providers.get("requesty").models.length, 1);
  });

  it("prefers the auth.json credential over models.json apiKey", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "!printf sk-from-keyring" } });
    writeModelsJson({ providers: { requesty: { apiKey: "sk-from-models-json" } } });
    const fetchStub = stubFetch();

    try {
      await requestyExtension(createPi());
    } finally {
      fetchStub.restore();
    }

    assert.equal(fetchStub.calls[0].authorization, "Bearer sk-from-keyring");
  });

  it("falls back to a models.json apiKey, including a command value", async () => {
    writeModelsJson({ providers: { requesty: { apiKey: "sk-from-models-json" } } });
    let fetchStub = stubFetch();
    try {
      await requestyExtension(createPi());
    } finally {
      fetchStub.restore();
    }
    assert.equal(fetchStub.calls[0].authorization, "Bearer sk-from-models-json");

    writeModelsJson({ providers: { requesty: { apiKey: "!printf sk-from-models-command" } } });
    fetchStub = stubFetch();
    try {
      await requestyExtension(createPi());
    } finally {
      fetchStub.restore();
    }
    assert.equal(fetchStub.calls[0].authorization, "Bearer sk-from-models-command");
  });

  it("keeps the registered provider free of a key that came from auth.json", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "!printf sk-from-keyring" } });
    const fetchStub = stubFetch();
    const pi = createPi();

    try {
      await requestyExtension(pi);
    } finally {
      fetchStub.restore();
    }

    assert.equal(pi.providers.get("requesty").apiKey, undefined);
  });

  it("stays silent and off the network when no credential is configured", async () => {
    const fetchStub = stubFetch();
    const warnings = captureWarnings();
    const pi = createPi();

    try {
      await requestyExtension(pi);
    } finally {
      fetchStub.restore();
      warnings.restore();
    }

    assert.equal(fetchStub.calls.length, 0);
    assert.deepEqual(warnings.warnings, []);
    assert.equal(pi.providers.size, 0);
  });

  it("still warns when a configured credential cannot discover models", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "!printf sk-from-keyring" } });
    const warnings = captureWarnings();
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized" });

    try {
      await requestyExtension(createPi());
    } finally {
      globalThis.fetch = original;
      warnings.restore();
    }

    assert.match(warnings.warnings.join("\n"), /HTTP 401/);
  });

  it("bounds the discovery request so an unresponsive endpoint cannot block startup", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "!printf sk-from-keyring" } });
    const fetchStub = stubFetch();

    try {
      await requestyExtension(createPi());
    } finally {
      fetchStub.restore();
    }

    assert.equal(fetchStub.calls[0].signal instanceof AbortSignal, true);
  });

  it("reports a discovery timeout instead of hanging", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "!printf sk-from-keyring" } });
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    const fetchStub = stubFetch(undefined, timeout);
    const warnings = captureWarnings();

    try {
      await requestyExtension(createPi());
    } finally {
      fetchStub.restore();
      warnings.restore();
    }

    assert.match(warnings.warnings.join("\n"), /no response from https:\/\/router\.requesty\.ai\/v1\/models within 10000ms/);
  });

  it("refuses to proceed past a malformed models.json", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "!printf sk-from-keyring" } });
    writeModelsJson({ providers: "not-an-object" });
    const fetchStub = stubFetch();
    const warnings = captureWarnings();

    try {
      await requestyExtension(createPi());
    } finally {
      fetchStub.restore();
      warnings.restore();
    }

    assert.equal(fetchStub.calls.length, 0);
    assert.match(warnings.warnings.join("\n"), /does not define providers as an object/);
  });
});

describe("/requesty-models-sync", () => {
  async function runCommand() {
    const pi = createPi();
    const fetchStub = stubFetch();
    const warnings = captureWarnings();
    try {
      await requestyExtension(pi);
      const context = createContext();
      await pi.commands.get("requesty-models-sync").handler("", context);
      return { context, pi };
    } finally {
      fetchStub.restore();
      warnings.restore();
    }
  }

  it("leaves a malformed models.json untouched", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "!printf sk-from-keyring" } });
    writeModelsJson({ providers: [] });
    const before = fs.readFileSync(MODELS_PATH, "utf8");

    const { context } = await runCommand();

    assert.equal(fs.readFileSync(MODELS_PATH, "utf8"), before);
    assert.equal(context.notifications.at(-1).level, "error");
    assert.match(context.notifications.at(-1).message, /does not define providers as an object/);
  });

  it("rejects a provider entry that is not an object", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "!printf sk-from-keyring" } });
    writeModelsJson({ providers: { requesty: "nope" } });
    const before = fs.readFileSync(MODELS_PATH, "utf8");

    const { context } = await runCommand();

    assert.equal(fs.readFileSync(MODELS_PATH, "utf8"), before);
    assert.match(context.notifications.at(-1).message, /providers\.requesty in .* is not an object/);
  });

  it("writes discovered models without persisting a keyring key", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "!printf sk-from-keyring" } });
    const { context } = await runCommand();

    const written = JSON.parse(fs.readFileSync(MODELS_PATH, "utf8"));
    assert.equal(written.providers.requesty.models.length, 1);
    assert.equal(written.providers.requesty.apiKey, undefined);
    assert.equal(fs.readFileSync(MODELS_PATH, "utf8").includes("sk-from-keyring"), false);
    assert.match(context.notifications.at(-1).message, /using the key from/);
  });

  it("keeps existing provider fields while replacing models", async () => {
    writeModelsJson({
      providers: { requesty: { baseUrl: "https://example.test/v1", apiKey: "sk-from-models-json", custom: true } },
    });
    await runCommand();

    const written = JSON.parse(fs.readFileSync(MODELS_PATH, "utf8"));
    assert.equal(written.providers.requesty.baseUrl, "https://example.test/v1");
    assert.equal(written.providers.requesty.custom, true);
    assert.equal(written.providers.requesty.apiKey, "sk-from-models-json");
    assert.equal(written.providers.requesty.models.length, 1);
  });

  it("explains both accepted key locations when nothing is configured", async () => {
    const { context } = await runCommand();

    const message = context.notifications.at(-1);
    assert.equal(message.level, "error");
    assert.match(message.message, /No Requesty credential available/);
    assert.match(message.message, /auth\.json/);
    assert.match(message.message, /secret-tool lookup requesty api-key/);
    assert.match(message.message, /models\.json/);
  });

  it("creates models.json when it does not exist", async () => {
    writeAuthJson({ requesty: { type: "api_key", key: "!printf sk-from-keyring" } });
    assert.equal(fs.existsSync(MODELS_PATH), false);
    await runCommand();
    assert.equal(JSON.parse(fs.readFileSync(MODELS_PATH, "utf8")).providers.requesty.models.length, 1);
  });
});

afterEach(() => {
  clearConfigValueCache();
});
