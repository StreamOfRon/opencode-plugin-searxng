/**
 * Dependency-free smoke test. Run with: npm test
 *
 * Exercises the plugin against a fake OpenCode context and a mocked
 * SearXNG JSON API: registration, option handling, URL building,
 * result mapping, maxResults clamping, and the bounded response read.
 */
import assert from "node:assert/strict"
import plugin from "../src/index.ts"

const MAX_RESPONSE_BYTES = 262_144

/** Mock response exposing only what execute() reads: headers and body. */
const jsonResponse = (body, headers = []) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: new Headers(headers),
  body: new Blob([JSON.stringify(body)]).stream(),
})

const transformCtx = (options) => {
  let registered
  let defaultSet
  const ctx = {
    options,
    websearch: {
      transform: async (cb) => {
        cb({
          add: (definition) => {
            registered = definition
          },
          default: { get: () => undefined, set: (value) => { defaultSet = value } },
        })
      },
    },
  }
  return { ctx, get registered() { return registered }, get defaultSet() { return defaultSet } }
}

const originalFetch = globalThis.fetch

// Configured path: every configured param must appear in the request URL.
const configured = transformCtx({
  baseURL: "https://searx.test/",
  categories: ["general", "news"],
  language: "all",
  safesearch: 1,
  time_range: "week",
  maxResults: 3,
})
await plugin.setup(configured.ctx)

assert.equal(configured.registered?.id, "searxng")
assert.equal(configured.registered?.name, "SearXNG")
assert.equal(configured.defaultSet, "searxng")

let requestedUrl
globalThis.fetch = async (url) => {
  requestedUrl = String(url)
  return jsonResponse({
    results: [
      { url: "https://a.example", title: "A", content: "aaa", publishedDate: "2026-01-02T03:04:05" },
      { url: "https://b.example", title: "B" },
      { title: "no url — should be dropped" },
      { url: "https://d.example", publishedDate: 1700000000 },
      { url: "https://e.example", title: "E" },
    ],
  })
}

const results = await configured.registered.execute(
  { query: "hello world" },
  { signal: new AbortController().signal },
)

assert.equal(
  requestedUrl,
  "https://searx.test/search?q=hello+world&format=json&categories=general%2Cnews&language=all&safesearch=1&time_range=week",
)
assert.deepEqual(results, [
  { url: "https://a.example", title: "A", content: "aaa", time: { published: Date.parse("2026-01-02T03:04:05") } },
  { url: "https://b.example", title: "B", content: undefined, time: {} },
  { url: "https://d.example", title: undefined, content: undefined, time: { published: 1700000000 } },
])

// Error path: 403 should mention the JSON format setting.
globalThis.fetch = async () => ({ ok: false, status: 403, statusText: "Forbidden", url: "https://searx.test" })
await assert.rejects(
  () => configured.registered.execute({ query: "x" }, { signal: new AbortController().signal }),
  /JSON format/,
)

globalThis.fetch = originalFetch

// Defaults path: only baseURL configured — no search params beyond q/format,
// and maxResults falls back to 8.
const defaults = transformCtx({ baseURL: "https://searx.test" })
await plugin.setup(defaults.ctx)
let defaultUrl
globalThis.fetch = async (url) => {
  defaultUrl = String(url)
  return jsonResponse({
    results: Array.from({ length: 10 }, (_, i) => ({ url: `https://r${i}.example`, title: `R${i}` })),
  })
}
const defaultResults = await defaults.registered.execute(
  { query: "go" },
  { signal: new AbortController().signal },
)
assert.equal(defaultUrl, "https://searx.test/search?q=go&format=json")
assert.equal(defaultResults.length, 8)
assert.deepEqual(defaultResults[0], { url: "https://r0.example", title: "R0", content: undefined, time: {} })
globalThis.fetch = originalFetch

// Response body cap: a declared content-length over 256 KB is rejected unread.
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: new Headers({ "content-length": String(MAX_RESPONSE_BYTES + 1) }),
})
await assert.rejects(
  () => configured.registered.execute({ query: "big" }, { signal: new AbortController().signal }),
  /exceeded 262144/,
)

// Response body cap: a streamed body growing past 256 KB is cancelled.
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: new Headers(),
  body: new Blob([new Uint8Array(MAX_RESPONSE_BYTES + 1)]).stream(),
})
await assert.rejects(
  () => configured.registered.execute({ query: "bigger" }, { signal: new AbortController().signal }),
  /exceeded 262144/,
)

globalThis.fetch = originalFetch

// Invalid time_range must fail at setup time.
const badRange = transformCtx({ baseURL: "https://searx.test", time_range: "hour" })
await assert.rejects(() => plugin.setup(badRange.ctx), /time_range/)

console.log("smoke test passed")
