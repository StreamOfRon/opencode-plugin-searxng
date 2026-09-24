# opencode-plugin-searxng

[OpenCode V2](https://opencode.ai/v2/docs/) plugin that registers a self-hosted
[SearXNG](https://docs.searxng.org/) instance as a websearch provider, replacing
the built-in web search backend.

## Prerequisites

Your SearXNG instance must allow the JSON API. In its `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

Without this, requests return `403`.

## Install

### Local path (any project)

```sh
git clone https://github.com/StreamOfRon/opencode-plugin-searxng.git ~/Work/opencode-plugin-searxng
```

Then reference it from `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/Users/rmiller/Work/opencode-plugin-searxng",
      "options": {
        "baseURL": "https://searx.example.org"
      }
    }
  ]
}
```

Or drop a copy under `.opencode/plugins/searxng/` in the project — those load
automatically.

## Configuration options

Only `baseURL` normally needs configuring; everything else has sane
defaults. With zero options the plugin talks to `http://localhost:8080`.

| Option         | Type             | Default                 | Env fallback      | Notes                                             |
| -------------- | ---------------- | ----------------------- | ----------------- | ------------------------------------------------- |
| `baseURL`      | string           | `http://localhost:8080` | `SEARXNG_URL`     | Instance base URL (no trailing slash needed)      |
| `categories`   | string \| array  | `"general,news,it"`     | —                 | e.g. `"general,it"` or `["general", "news"]`      |
| `language`     | string           | `"all"`                 | —                 | `"en"`, `"de"`, …                                 |
| `safesearch`   | number           | `0` (off)               | —                 | `0` off, `1` moderate, `2` strict                 |
| `maxResults`   | number           | `10`                    | —                 | Results handed to the agent                       |
| `apiKey`       | string           | — (optional)            | `SEARXNG_API_KEY` | Sent as `Authorization: Bearer …` only when set   |
| `useAsDefault` | boolean          | `true`                  | —                 | `false` registers the provider without selecting it |

The `SEARXNG_URL` / `SEARXNG_API_KEY` env fallbacks match the conventions used
by `hermes-plugin-searxng-search`.

## How it works

The plugin uses OpenCode V2's
[`ctx.websearch`](https://opencode.ai/v2/docs/build/plugins#websearch)
extension point:

1. `editor.add({ id: "searxng", … })` registers a provider whose `execute`
   calls `GET {baseURL}/search?q=…&format=json`, maps SearXNG results to the
   `WebSearch.Result` schema (`url`, `title`, `content`, `time.published` in
   epoch millis), and forwards the abort `signal` so stopping a session
   cancels the in-flight request.
2. `editor.default.set("searxng")` makes it the active provider for the
   built-in `websearch` tool. Set `useAsDefault: false` to leave selection to
   the user/other plugins.

A failed request surfaces a readable error; `403` specifically hints at the
JSON format setting above.

## Development

```sh
npm install
npm run typecheck
npm test          # dependency-free smoke test with a mocked SearXNG API
```

To try it against a live instance before wiring it into a project:

```sh
curl -s "$SEARXNG_URL/search?q=hello&format=json" | jq '.results[0]'
```

## License

MIT
