/**
 * Credential resolution for the Requesty extension.
 *
 * Pi resolves a provider's credentials itself for inference: a runtime
 * `--api-key`, then a stored credential in `auth.json`, then
 * `providers.<id>.apiKey` in `models.json`, then environment variables. Model
 * discovery sits outside that pipeline — it calls `<baseUrl>/models` directly —
 * so it needs the same key up front, and it must understand the same value
 * syntax, including a secret-manager command:
 *
 *   {
 *     "requesty": {
 *       "type": "api_key",
 *       "key": "!secret-tool lookup requesty api-key"
 *     }
 *   }
 *
 * This module mirrors Pi's `resolveConfigValue` semantics so a value means the
 * same thing here as it does for inference requests:
 *
 * - a leading `!` runs the rest as a shell command and uses its trimmed stdout
 *   (cached for the lifetime of the process, 10s timeout, `undefined` on failure)
 * - `$NAME` / `${NAME}` interpolate environment variables, and a value naming an
 *   unset variable resolves to `undefined` rather than a partial string
 * - `$$` and `$!` escape a literal `$` and `!`
 * - anything else is a literal
 *
 * A resolved key is only ever held in memory: it is never written back to
 * `models.json`.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const COMMAND_TIMEOUT_MS = 10_000;

/** Shell-command results, cached for the process lifetime. */
const commandResultCache = new Map();

/** Pi's agent directory, honoring `PI_CODING_AGENT_DIR`. */
export function agentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (typeof configured === "string" && configured.length > 0) {
    return configured;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export function authJsonPath() {
  return path.join(agentDir(), "auth.json");
}

export function modelsJsonPath() {
  return path.join(agentDir(), "models.json");
}

/** Whether a config value is a `!command` reference. */
export function isCommandConfigValue(config) {
  return typeof config === "string" && config.startsWith("!");
}

/** Clear cached shell-command results. Exported for tests. */
export function clearConfigValueCache() {
  commandResultCache.clear();
}

/**
 * Resolve an API key or header value to its actual value.
 *
 * Returns `undefined` when a command fails or an interpolated variable is unset,
 * matching Pi: an unresolvable value is treated as "not configured" rather than
 * as an empty credential.
 */
export function resolveConfigValue(config, env) {
  if (typeof config !== "string" || config.length === 0) {
    return undefined;
  }
  return isCommandConfigValue(config) ? executeCommand(config) : resolveTemplate(config, env);
}

/**
 * Read the stored `api_key` credential for a provider from `auth.json`.
 *
 * Uses Pi's own reader through the package's public export, so `auth.json`
 * parsing (including its file lock and BOM handling) stays Pi's concern; a plain
 * JSON read is the fallback for a Pi version that does not export it.
 */
export async function readStoredApiKey(providerId, options = {}) {
  const authPath = options.authPath ?? authJsonPath();
  const credential = await readCredential(providerId, authPath);

  if (!credential) {
    return { reason: `no "${providerId}" credential in ${authPath}` };
  }
  if (credential.type !== "api_key") {
    return {
      reason: `the "${providerId}" credential in ${authPath} is of type "${credential.type}"; model discovery needs an "api_key" credential`,
    };
  }
  if (typeof credential.key !== "string" || credential.key.length === 0) {
    return { reason: `the "${providerId}" credential in ${authPath} has no key` };
  }

  const key = resolveConfigValue(credential.key, credential.env ?? options.env);
  if (key === undefined) {
    return {
      reason: `the "${providerId}" key in ${authPath} did not resolve (a failing command or an unset variable resolves to nothing)`,
    };
  }

  return { key, source: authPath };
}

let storedCredentialReader;

async function readCredential(providerId, authPath) {
  if (storedCredentialReader === undefined) {
    storedCredentialReader = await loadStoredCredentialReader();
  }
  if (storedCredentialReader) {
    return storedCredentialReader(providerId, authPath);
  }
  return readCredentialFromFile(providerId, authPath);
}

async function loadStoredCredentialReader() {
  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    return typeof pi.readStoredCredential === "function" ? pi.readStoredCredential : null;
  } catch {
    return null;
  }
}

/** Fallback reader: `auth.json` holds one credential per provider id. */
function readCredentialFromFile(providerId, authPath) {
  try {
    const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    if (!data || typeof data !== "object") {
      return undefined;
    }
    const credential = data[providerId];
    return credential && typeof credential === "object" ? credential : undefined;
  } catch {
    return undefined;
  }
}

/** Execute a `!command` value, caching the result for the process lifetime. */
function executeCommand(config) {
  if (commandResultCache.has(config)) {
    return commandResultCache.get(config);
  }
  const result = executeCommandUncached(config);
  commandResultCache.set(config, result);
  return result;
}

function executeCommandUncached(config) {
  try {
    const output = execSync(config.slice(1), {
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveTemplate(config, env) {
  let resolved = "";
  for (const part of parseTemplate(config)) {
    if (part.literal !== undefined) {
      resolved += part.literal;
      continue;
    }
    const value = env?.[part.name] || process.env[part.name];
    if (value === undefined) {
      return undefined;
    }
    resolved += value;
  }
  return resolved;
}

/**
 * Split a value into literal and `$NAME`/`${NAME}` parts, applying the `$$` and
 * `$!` escapes. A lone or malformed `$` stays literal.
 */
function parseTemplate(config) {
  const parts = [];
  let index = 0;

  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      parts.push({ literal: config.slice(index) });
      break;
    }
    if (dollarIndex > index) {
      parts.push({ literal: config.slice(index, dollarIndex) });
    }

    const nextChar = config[dollarIndex + 1];
    if (nextChar === "$" || nextChar === "!") {
      parts.push({ literal: nextChar });
      index = dollarIndex + 2;
      continue;
    }
    if (nextChar === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        parts.push({ literal: "$" });
        index = dollarIndex + 1;
        continue;
      }
      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) {
        parts.push({ name });
      } else {
        parts.push({ literal: config.slice(dollarIndex, endIndex + 1) });
      }
      index = endIndex + 1;
      continue;
    }

    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }
    parts.push({ literal: "$" });
    index = dollarIndex + 1;
  }

  return parts;
}
