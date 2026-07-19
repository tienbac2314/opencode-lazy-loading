import { afterAll, expect, mock, test } from "bun:test"

type NativeTool = {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

type PluginHooks = {
  "tool.definition": (
    input: { toolID: string },
    output: { description: string; jsonSchema?: unknown },
  ) => Promise<void>
}

const upstreamBySession = new Map<string, string>()
const requests: Array<{ sessionID: string; body: { tools?: NativeTool[] } }> = []

const originalFetch = globalThis.fetch

function sseTool(name: string, args: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_1",
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  })}\n\n`
}

function finish(reason = "stop"): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`
}

function events(output: string): Array<Record<string, any>> {
  return output
    .split(/\r?\n\r?\n/)
    .map((event) => event.trim())
    .filter((event) => event.startsWith("data:") && event !== "data: [DONE]")
    .map((event) => JSON.parse(event.slice("data:".length).trim()))
}

function toolNames(output: string): string[] {
  return events(output).flatMap((event) =>
    event.choices[0]?.delta?.tool_calls?.map((call: any) => call.function.name) ?? [],
  )
}

async function runRequest(sessionID: string, tools: NativeTool[], upstreamSSE: string) {
  const response = await startRequest(sessionID, tools, upstreamSSE)
  const output = await response.text()
  const providerRequest = requests.at(-1)?.body
  if (!providerRequest) throw new Error("Provider request was not captured")
  return { providerRequest, output }
}

async function startRequest(sessionID: string, tools: NativeTool[], upstreamSSE: string) {
  upstreamBySession.set(sessionID, upstreamSSE)
  return globalThis.fetch("https://example.test/chat/completions", {
    method: "POST",
    headers: { "x-opencode-session": sessionID },
    body: JSON.stringify({ tools }),
  })
}

mock.module("@opencode-ai/plugin", () => ({
  tool: Object.assign(
    () => ({}),
    { schema: { string: () => ({ describe: () => ({}) }) } },
  ),
}))

globalThis.fetch = async (_input, init) => {
  const headers = new Headers(init?.headers)
  const sessionID = headers.get("x-opencode-session")
  if (!sessionID) throw new Error("Missing x-opencode-session")
  const body = JSON.parse(String(init?.body))
  requests.push({ sessionID, body })
  const upstream = upstreamBySession.get(sessionID)
  if (!upstream) throw new Error(`Missing upstream response for ${sessionID}`)
  return new Response(upstream, { headers: { "content-type": "text/event-stream" } })
}

const { default: lazyLoad } = await import("../plugins/opencode-lazy-load.ts")
const plugin = await lazyLoad.server({}, {})
const hooks = plugin as unknown as PluginHooks

await hooks["tool.definition"](
  { toolID: "read" },
  {
    description: "Read a file.",
    jsonSchema: { type: "object", properties: { path: { type: "string" } } },
  },
)

const loadTool: NativeTool = {
  type: "function",
  function: { name: "load_tool", description: "Gateway", parameters: {} },
}

const namespacedLoadTool: NativeTool = {
  type: "function",
  function: { name: "opencode-lazy-load_load_tool", description: "Gateway", parameters: {} },
}

const readTool: NativeTool = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
}

const codegraphTool: NativeTool = {
  type: "function",
  function: {
    name: "codegraph_explore",
    description: "Explore indexed code.",
    parameters: { type: "object" },
  },
}

test("keeps only load_tool in provider request and preserves a plain gateway call", async () => {
  const { providerRequest, output } = await runRequest(
    "plain-gateway",
    [loadTool, readTool],
    sseTool("load_tool", { name: "read" }) + finish() + "data: [DONE]\n\n",
  )

  expect(providerRequest.tools?.map((tool) => tool.function.name)).toEqual(["load_tool"])
  expect(toolNames(output)).toEqual(["load_tool"])
})

test("keeps only a namespaced gateway in provider request and preserves its response name", async () => {
  const { providerRequest, output } = await runRequest(
    "namespaced-gateway",
    [namespacedLoadTool, readTool],
    sseTool("opencode-lazy-load_load_tool", { name: "read" }) + finish() + "data: [DONE]\n\n",
  )

  expect(providerRequest.tools?.map((tool) => tool.function.name)).toEqual(["opencode-lazy-load_load_tool"])
  expect(toolNames(output)).toEqual(["opencode-lazy-load_load_tool"])
})

test("keeps interleaved gateway aliases isolated per response", async () => {
  const responseA = await startRequest(
    "plain-interleaved",
    [loadTool, readTool],
    sseTool("read", { path: "/plain" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  const responseB = await startRequest(
    "namespaced-interleaved",
    [namespacedLoadTool, readTool],
    sseTool("read", { path: "/namespaced" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )

  const outputA = await responseA.text()
  const outputB = await responseB.text()

  expect(toolNames(outputA)).toEqual(["load_tool"])
  expect(toolNames(outputB)).toEqual(["opencode-lazy-load_load_tool"])
})

test("passes a request-captured MCP tool through directly", async () => {
  const { output } = await runRequest(
    "mcp-pass-through",
    [loadTool, codegraphTool],
    sseTool("codegraph_explore", { query: "tool call compatibility" }) + finish() + "data: [DONE]\n\n",
  )

  expect(toolNames(output)).toEqual(["codegraph_explore"])
})

test("rewrites unloaded built-ins, permits them within the turn, and resets on stop", async () => {
  const first = await runRequest(
    "built-in-turn",
    [loadTool, readTool],
    sseTool("read", { path: "/first" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  const second = await runRequest(
    "built-in-turn",
    [loadTool, readTool],
    sseTool("read", { path: "/second" }) + finish() + "data: [DONE]\n\n",
  )
  const third = await runRequest(
    "built-in-turn",
    [loadTool, readTool],
    sseTool("read", { path: "/third" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )

  expect(toolNames(first.output)).toEqual(["load_tool"])
  expect(toolNames(second.output)).toEqual(["read"])
  expect(toolNames(third.output)).toEqual(["load_tool"])
})

afterAll(() => {
  globalThis.fetch = originalFetch
})
