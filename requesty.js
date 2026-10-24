import fs from "node:fs";
import path from "node:path";

import { authJsonPath, modelsJsonPath, readStoredApiKey, resolveConfigValue } from "./credentials.js";

const PROVIDER = "requesty";
const DEFAULT_BASE_URL = "https://router.requesty.ai/v1";
const DEFAULT_NAME = "Requesty";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const DISCOVERY_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Read models.json.
 *
 * A missing file is not an error: a stored `auth.json` credential is enough to
 * discover models, and the write path creates the provider entry if needed. A
 * malformed one still is: nothing here may quietly replace configuration it did
 * not understand, because `/requesty-models-sync` writes this file back.
 */
function readModelsJson() {
  const modelsPath = modelsJsonPath();
  if (!fs.existsSync(modelsPath)) {
    return { providers: {} };
  }

  const data = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  if (!data.providers || typeof data.providers !== "object" || Array.isArray(data.providers)) {
    throw new Error(`${modelsPath} does not define providers as an object`);
  }

  const configured = data.providers[PROVIDER];
  if (configured !== undefined && (typeof configured !== "object" || configured === null || Array.isArray(configured))) {
    throw new Error(`providers.${PROVIDER} in ${modelsPath} is not an object`);
  }

  return data;
}

/**
 * The key for model discovery: a stored `auth.json` credential first, then
 * `providers.requesty.apiKey`. Either may be a `!command`, `$VAR` or a literal.
 */
function resolveRequestyKey(provider, options = {}) {
  const stored = readStoredApiKey(PROVIDER, options);
  if (stored.key) {
    return stored;
  }

  const fromModelsJson = resolveConfigValue(provider?.apiKey, options.env);
  if (fromModelsJson) {
    return { key: fromModelsJson, source: `providers.${PROVIDER}.apiKey in ${modelsJsonPath()}` };
  }

  return { reason: stored.reason };
}

/**
 * The provider settings plus the key used to reach `<baseUrl>/models`. A key that
 * came from `auth.json` stays out of `provider`, so it cannot reach the registered
 * provider or a `models.json` write.
 */
function getRequestyConfig(options = {}) {
  const data = readModelsJson();
  const provider = data.providers[PROVIDER] ?? {};

  const name = typeof provider.name === "string" && provider.name.length > 0 ? provider.name : DEFAULT_NAME;

  const baseUrl = normalizeBaseUrl(
    typeof provider.baseUrl === "string" && provider.baseUrl.length > 0 ? provider.baseUrl : DEFAULT_BASE_URL,
  );

  const resolved = resolveRequestyKey(provider, options);

  return {
    data,
    provider: { ...provider, name, baseUrl },
    key: resolved.key,
    keySource: resolved.source,
    keyProblem: resolved.key ? undefined : resolved.reason,
  };
}

async function discoverModels({ baseUrl, apiKey }) {
  let response;

  try {
    // Bounded on purpose: this runs while pi is still starting up, and pi awaits
    // the extension while loading it, so an endpoint that accepts and never
    // answers would otherwise keep the TUI from ever appearing.
    response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`no response from ${baseUrl}/models within ${DISCOVERY_TIMEOUT_MS}ms`);
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error("Expected OpenAI-compatible response with a data array");
  }

  return payload.data
    .filter((model) => model && typeof model.id === "string" && model.id.length > 0)
    .map((model) => ({
      id: model.id,
      name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
      reasoning: model.supports_reasoning === true,
      input: model.supports_vision === true ? ["text", "image"] : ["text"],
      cost: {
        input: pricePerMillionTokens(model.input_price),
        output: pricePerMillionTokens(model.output_price),
        cacheRead: pricePerMillionTokens(model.cached_price),
        cacheWrite: pricePerMillionTokens(model.caching_price),
      },
      contextWindow: model.context_window || DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.max_output_tokens || DEFAULT_MAX_TOKENS,
    }));
}

function pricePerMillionTokens(value) {
  return (value ?? 0) * 1_000_000;
}

function writeModelsJson(data) {
  const modelsPath = modelsJsonPath();
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
  const tmpPath = `${modelsPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, modelsPath);
}

/**
 * Write the discovered models back to models.json.
 *
 * Only `models` is replaced: a key that came from `auth.json` stays out of the
 * file, and a malformed or hand-edited provider entry keeps its other fields.
 */
function updateModelsJson(data, models) {
  data.providers = data.providers && typeof data.providers === "object" ? data.providers : {};
  data.providers[PROVIDER] = {
    ...data.providers[PROVIDER],
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  };
  writeModelsJson(data);
}

const KEY_HELP = [
  "Set the Requesty key in either place:",
  `  ${authJsonPath()}`,
  '    { "requesty": { "type": "api_key", "key": "!secret-tool lookup requesty api-key" } }',
  `  ${modelsJsonPath()}`,
  '    { "providers": { "requesty": { "apiKey": "rqsty-sk-..." } } }',
  'Both accept a "!command", a "$VARIABLE" reference, or a literal value.',
].join("\n");

export default async function (pi) {
  pi.registerCommand("requesty-models-sync", {
    description: "Dynamically discover Requesty models and update the local models.json.",
    async handler(_args, ctx) {
      ctx.ui.setStatus("requesty-models-sync", "Discovering Requesty models...");

      try {
        const { data, provider, key, keySource, keyProblem } = getRequestyConfig();

        if (!key) {
          ctx.ui.notify(`No Requesty credential available.\n\n${keyProblem}\n\n${KEY_HELP}`, "error");
          return;
        }

        const models = await discoverModels({ baseUrl: provider.baseUrl, apiKey: key });
        updateModelsJson(data, models);
        ctx.ui.notify(
          `Discovered ${models.length} Requesty model(s) using the key from ${keySource}. Run /reload to use models.json changes.`,
          "success",
        );
      } catch (error) {
        ctx.ui.notify(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        ctx.ui.setStatus("requesty-models-sync", undefined);
      }
    },
  });

  try {
    const { provider, key } = getRequestyConfig();

    // No credential is not a failure: Pi resolves credentials for inference
    // itself, and models already listed in models.json keep working. Discovery
    // is the only thing that needs the key, so skip it quietly.
    if (!key) {
      return;
    }

    const models = await discoverModels({ baseUrl: provider.baseUrl, apiKey: key });

    if (models.length > 0) {
      pi.registerProvider(PROVIDER, {
        ...provider,
        models,
      });
    }
  } catch (error) {
    console.warn(
      `[pi-requesty-model-discovery] startup discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
