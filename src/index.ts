import { Plugin } from "@opencode/plugin"
import type { WebSearch } from "@opencode/schema/websearch"

/**
 * Plugin options, passed via the object form in `opencode.json(c)`:
 *
 *   { "package": "./plugins/searxng", "options": { "baseURL": "https://searx.example.org" } }
 *
 * With no options at all, the plugin uses the defaults below and talks to
 * http://localhost:8080. Only `baseURL` (or the SEARXNG_URL env var) and,
 * optionally, `apiKey` (or SEARXNG_API_KEY) normally need configuring.
 *
 * Search params (categories, language, safesearch, time_range) are only sent
 * when explicitly configured; the SearXNG instance's own defaults apply
 * otherwise.
 */
interface SearXNGPluginOptions {
  /** SearXNG instance base URL. Falls back to SEARXNG_URL. Default: http://localhost:8080 */
  baseURL?: string
  /** Comma-separated categories or an array (e.g. "general,it" or ["general","it"]). Omitted unless configured. */
  categories?: string | readonly string[]
  /** Search language (e.g. "en", "de"). SearXNG also accepts "all". Omitted unless configured. */
  language?: string
  /** Safe search filter: 0 = off, 1 = moderate, 2 = strict. Omitted unless configured. */
  safesearch?: number
  /** Limit results to a period: "day", "week", "month", or "year". Omitted unless configured. */
  time_range?: string
  /** Maximum number of results returned to the agent. Default: 8 */
  maxResults?: number
  /** Optional bearer token sent as Authorization header. Falls back to SEARXNG_API_KEY. */
  apiKey?: string
  /** Select SearXNG as the default websearch provider. Default: true */
  useAsDefault?: boolean
}

/** Shape of a single entry in the SearXNG `/search` JSON response. */
interface SearXNGRawResult {
  url?: string
  title?: string
  content?: string
  publishedDate?: string | number
}

/** Hard cap on the JSON response body, matching builtin websearch providers. */
const MAX_RESPONSE_BYTES = 262_144

const TIME_RANGES = new Set(["day", "week", "month", "year"])

function resolveOptions(options: SearXNGPluginOptions) {
  const baseURL = (options.baseURL ?? process.env.SEARXNG_URL ?? "http://localhost:8080")
    .trim()
    .replace(/\/+$/, "")
  const apiKey = (options.apiKey ?? process.env.SEARXNG_API_KEY ?? "").trim()
  const categories = Array.isArray(options.categories)
    ? (options.categories as readonly string[]).join(",")
    : typeof options.categories === "string" && options.categories.length > 0
      ? options.categories
      : undefined
  if (options.time_range !== undefined && !TIME_RANGES.has(options.time_range)) {
    throw new Error("searxng: time_range must be one of day, week, month, year")
  }
  const maxResults =
    typeof options.maxResults === "number" && Number.isFinite(options.maxResults) && options.maxResults > 0
      ? Math.floor(options.maxResults)
      : 8
  return {
    baseURL,
    apiKey,
    categories,
    language: options.language,
    safesearch: options.safesearch,
    time_range: options.time_range,
    maxResults,
    useAsDefault: options.useAsDefault !== false,
  }
}

/**
 * Bounded response read, mirroring opencode core's collectBoundedResponseBody:
 * refuse to buffer more than MAX_RESPONSE_BYTES, using content-length when
 * declared and otherwise counting bytes as they stream in.
 */
async function collectBoundedResponseBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`SearXNG response exceeded ${MAX_RESPONSE_BYTES} bytes`)
  }
  if (!response.body) throw new Error("SearXNG returned an empty response body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error(`SearXNG response exceeded ${MAX_RESPONSE_BYTES} bytes`)
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return text
}

/** SearXNG reports `publishedDate` as an ISO string or numeric timestamp, engine dependent. */
function toPublishedMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const millis = Date.parse(value)
    if (Number.isFinite(millis)) return millis
  }
  return undefined
}

export default Plugin.define({
  id: "searxng",
  async setup(ctx) {
    const resolved = resolveOptions(ctx.options as SearXNGPluginOptions)

    await ctx.websearch.transform((editor) => {
      editor.add({
        id: "searxng",
        name: "SearXNG",
        execute: async ({ query }, { signal }) => {
          const url = new URL("/search", `${resolved.baseURL}/`)
          url.searchParams.set("q", query)
          url.searchParams.set("format", "json")
          if (resolved.categories) url.searchParams.set("categories", resolved.categories)
          if (resolved.language !== undefined) url.searchParams.set("language", resolved.language)
          if (resolved.safesearch !== undefined) url.searchParams.set("safesearch", String(resolved.safesearch))
          if (resolved.time_range !== undefined) url.searchParams.set("time_range", resolved.time_range)

          const headers: Record<string, string> = { accept: "application/json" }
          if (resolved.apiKey) headers.authorization = `Bearer ${resolved.apiKey}`

          const response = await fetch(url, {
            headers,
            signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
          })
          if (!response.ok) {
            throw new Error(
              `SearXNG request failed (${response.status} ${response.statusText}) for ${url.origin}` +
                (response.status === 403
                  ? " — is the JSON format enabled on this instance (search.formats: [html, json])?"
                  : ""),
            )
          }

          const data = JSON.parse(await collectBoundedResponseBody(response)) as {
            results?: SearXNGRawResult[]
          }
          const results: WebSearch.Result[] = (data.results ?? [])
            .filter((r): r is SearXNGRawResult & { url: string } => typeof r.url === "string" && r.url.length > 0)
            .slice(0, resolved.maxResults)
            .map((r) => {
              const published = toPublishedMillis(r.publishedDate)
              return {
                url: r.url,
                title: r.title,
                content: r.content,
                time: published !== undefined ? { published } : {},
              }
            })

          return results
        },
      })

      if (resolved.useAsDefault) editor.default.set("searxng")
    })
  },
})
