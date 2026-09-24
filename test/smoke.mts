/**
 * Dependency-free smoke test. Run with: npm test
 *
 * Exercises the plugin against a fake OpenCode context and a mocked
 * SearXNG JSON API: registration, option handling, URL building,
 * result mapping, and maxResults clamping.
 */
import assert from "node:assert/strict"
import plugin from "../src/index.ts"

const ctx = {
  options: { baseURL: "https://searx.test/", categories: ["general", "news"], safesearch: 1, maxResults: 3 },
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

let registered
let defaultSet
await plugin.setup(ctx)

assert.equal(registered?.id, "searxng")
assert.equal(registered?.name, "SearXNG")
assert.equal(defaultSet, "searxng")

const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  requestedUrl = String(url)
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: [
        { url: "https://a.example", title: "A", content: "aaa", publishedDate: "2026-01-02T03:04:05" },
        { url: "https://b.example", title: "B" },
        { title: "no url — should be dropped" },
        { url: "https://d.example", publishedDate: 1700000000 },
        { url: "https://e.example", title: "E" },
      ],
    }),
  }
}
let requestedUrl

const results = await registered.execute({ query: "hello world" }, { signal: new AbortController().signal })

assert.equal(
  requestedUrl,
  "https://searx.test/search?q=hello+world&format=json&categories=general%2Cnews&language=all&safesearch=1",
)
assert.deepEqual(results, [
  { url: "https://a.example", title: "A", content: "aaa", time: { published: Date.parse("2026-01-02T03:04:05") } },
  { url: "https://b.example", title: "B", content: undefined, time: {} },
  { url: "https://d.example", title: undefined, content: undefined, time: { published: 1700000000 } },
])

// Error path: 403 should mention the JSON format setting.
globalThis.fetch = async () => ({ ok: false, status: 403, statusText: "Forbidden", url: "https://searx.test" })
await assert.rejects(
  () => registered.execute({ query: "x" }, { signal: new AbortController().signal }),
  /JSON format/,
)

globalThis.fetch = originalFetch

// Defaults path: no options besides the instance URL.
let defaultRegistered
const defaultsCtx = {
  options: { baseURL: "https://searx.test" },
  websearch: {
    transform: async (cb) => {
      cb({
        add: (definition) => {
          defaultRegistered = definition
        },
        default: { get: () => undefined, set: () => {} },
      })
    },
  },
}
await plugin.setup(defaultsCtx)
let defaultUrl
globalThis.fetch = async (url) => {
  defaultUrl = String(url)
  return { ok: true, status: 200, json: async () => ({ results: [] }) }
}
await defaultRegistered.execute({ query: "go" }, { signal: new AbortController().signal })
assert.equal(
  defaultUrl,
  "https://searx.test/search?q=go&format=json&categories=general%2Cnews%2Cit&language=all&safesearch=0",
)
globalThis.fetch = originalFetch

console.log("smoke test passed")
