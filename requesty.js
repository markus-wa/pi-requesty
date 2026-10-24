import fs from "node:fs";
import path from "node:path";

import { authJsonPath, modelsJsonPath, readStoredApiKey, resolveConfigValue } from "./credentials.js";

const PROVIDER = "requesty";
const DEFAULT_BASE_URL = "https://router.requesty.ai/v1";
const DEFAULT_NAME = "Requesty";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Read models.json.
 *
 * A missing file is not an error: a stored `auth.json` credential is enough to
 * discover models, and the write path creates the provider entry if needed.
 */
function readModelsJson() {
  const modelsPath = modelsJsonPath();
  if (!fs.existsSync(modelsPath)) {
    return { providers: {} };
  }

  const data = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  if (!data.providers || typeof data.providers !== "object") {
    data.providers = {};
  }

  return data;
}

/**
 * Resolve the key used for model discovery, following Pi's own order: a stored
 * `auth.json` credential first, then `providers.requesty.apiKey` in models.json.
 *
 * Either value may be a `!command`, a `$VAR` reference, or a literal, so
 *
 *   { "requesty": { "type": "api_key", "key": "!secret-tool lookup requesty api-key" } }
 *
 * works without writing the key to disk.
 */
async function resolveRequestyKey(provider, options = {}) {
  const stored = await readStoredApiKey(PROVIDER, options);
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
 * Collect the provider settings and the key used to reach `<baseUrl>/models`.
 *
 * `provider` is returned unchanged apart from `name`/`baseUrl` defaults, so a
 * key resolved from `auth.json` is never copied into the registered provider or
 * written back to `models.json`: Pi resolves credentials for inference itself.
 */
async function getRequestyConfig(options = {}) {
  const data = readModelsJson();
  const configured = data.providers[PROVIDER];
  const provider = configured && typeof configured === "object" ? configured : {};

  const name = typeof provider.name === "string" && provider.name.length > 0 ? provider.name : DEFAULT_NAME;

  const baseUrl = normalizeBaseUrl(
    typeof provider.baseUrl === "string" && provider.baseUrl.length > 0 ? provider.baseUrl : DEFAULT_BASE_URL,
  );

  const resolved = await resolveRequestyKey(provider, options);

  return {
    data,
    provider: { ...provider, name, baseUrl },
    key: resolved.key,
    keySource: resolved.source,
    keyProblem: resolved.key ? undefined : resolved.reason,
  };
}

async function discoverModels({ baseUrl, apiKey }) {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

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
        const { data, provider, key, keySource, keyProblem } = await getRequestyConfig();

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
    const { provider, key } = await getRequestyConfig();

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
