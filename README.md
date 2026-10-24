# pi-requesty (Official Requesty extension for Pi)

The official Requesty extension for the Pi Coding Agent

## (Recommended) Install from Github Repo

```bash
pi install git:github.com/requestyai/pi-requesty@c28e2f8
```

NOTE: Version c28e2f8 points to out latest v0.2.7 version, and keeps you safe from supply chain attack.

## Install locally

Check out the code from the official code repository `https://github.com/requestyai/pi-requesty`, and then:

```bash
pi install ./pi-requesty
```

To run once without installing:

```bash
pi -e ./pi-requesty
```

## Configuration

The extension resolves the `requesty` key exactly like pi does, in this order:

1. a stored `api_key` credential in the agent directory's `auth.json`
2. `providers.requesty.apiKey` in `models.json`

Both accept a literal value, a `$VARIABLE` reference, or a `!command` that prints
the key — so the key can stay in your secret manager:

```json
{
  "requesty": {
    "type": "api_key",
    "key": "!secret-tool lookup requesty api-key"
  }
}
```

Only the provider settings are read from `~/.pi/agent/models.json`; when the file
does not exist yet, defaults are used (`https://router.requesty.ai/v1`).

Example using a literal key instead:

```json
{
  "providers": {
    "requesty": {
      "name": "Requesty",
      "baseUrl": "https://router.requesty.ai/v1",
      "apiKey": "rqsty-sk-...",
      "api": "openai-completions",
      "models": []
    }
  }
}
```

On startup, the extension fetches `<baseUrl>/models` using the resolved key as the
bearer token and registers discovered models with pi. Without a credential
discovery is skipped silently: pi resolves credentials for inference itself, and
the models already listed in `models.json` keep working. The key is never written
to `models.json`.

## Command

Inside pi:

```text
/requesty-models-sync
```

The command resolves the key as described above, fetches the Requesty models and
writes the discovered model IDs back to `~/.pi/agent/models.json`.
Run `/reload` after syncing.

## Tests

```bash
npm test
```
