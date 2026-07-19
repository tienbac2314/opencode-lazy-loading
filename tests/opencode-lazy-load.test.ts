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

function toolArguments(output: string): Array<Record<string, unknown>> {
  return events(output).flatMap((event) =>
    event.choices[0]?.delta?.tool_calls?.map((call: any) => JSON.parse(call.function.arguments)) ?? [],
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

const typedToolSchema = {
  type: "object",
  properties: {
    offset: { type: "integer" },
    timeout: { type: "number" },
    enabled: { type: "boolean" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: { header: { type: "string" } },
      },
    },
    options: {
      type: "object",
      properties: { retries: { type: "integer" } },
    },
    code: { type: "string" },
    ambiguous: { type: ["string", "number"] },
    invalidObject: { type: "object" },
  },
}

await hooks["tool.definition"](
  { toolID: "typed_tool" },
  {
    description: "Exercise schema-guided normalization.",
    jsonSchema: typedToolSchema,
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

const typedTool: NativeTool = {
  type: "function",
  function: {
    name: "typed_tool",
    description: "Exercise schema-guided normalization.",
    parameters: typedToolSchema,
  },
}

const codegraphTool: NativeTool = {
  type: "function",
  function: {
    name: "codegraph_explore",
    description: "Explore indexed code.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
    },
  },
}

const uppercaseReadMcpTool: NativeTool = {
  type: "function",
  function: {
    name: "READ",
    description: "Read from an MCP source.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer" } },
    },
  },
}

const descriptionlessMcpTool: NativeTool = {
  type: "function",
  function: {
    name: "descriptionless_mcp",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer" } },
    },
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
    sseTool("codegraph_explore", { query: "tool call compatibility", limit: "5" }) + finish() + "data: [DONE]\n\n",
  )

  expect(toolNames(output)).toEqual(["codegraph_explore"])
  expect(toolArguments(output)).toEqual([{ query: "tool call compatibility", limit: 5 }])
})

test("captures an MCP schema even when its description is missing", async () => {
  const { output } = await runRequest(
    "descriptionless-mcp-schema",
    [loadTool, descriptionlessMcpTool],
    sseTool("descriptionless_mcp", { limit: "5" }) + finish() + "data: [DONE]\n\n",
  )

  expect(toolNames(output)).toEqual(["descriptionless_mcp"])
  expect(toolArguments(output)).toEqual([{ limit: 5 }])
})

test("prefers an exact MCP name over a case-folded built-in collision", async () => {
  const { output } = await runRequest(
    "exact-mcp-collision",
    [loadTool, readTool, uppercaseReadMcpTool],
    sseTool("READ", { limit: "5" }) + finish() + "data: [DONE]\n\n",
  )

  expect(toolNames(output)).toEqual(["READ"])
  expect(toolArguments(output)).toEqual([{ limit: 5 }])
})

test("uses an exact MCP name in gateway arguments before case folding", async () => {
  const { output } = await runRequest(
    "exact-gateway-collision",
    [loadTool, readTool, uppercaseReadMcpTool],
    sseTool("load_tool", { name: "READ" }) + finish() + "data: [DONE]\n\n",
  )

  expect(toolArguments(output)).toEqual([{ name: "READ" }])
})

test("leaves an ambiguous case-folded gateway name unchanged", async () => {
  const { output } = await runRequest(
    "ambiguous-gateway-collision",
    [loadTool, readTool, uppercaseReadMcpTool],
    sseTool("load_tool", { name: "Read" }) + finish() + "data: [DONE]\n\n",
  )

  expect(toolArguments(output)).toEqual([{ name: "Read" }])
})

test("repairs a known tool name and recursively normalizes schema-declared arguments", async () => {
  const loaded = await runRequest(
    "typed-normalization",
    [loadTool, typedTool],
    sseTool("load_tool", { name: "TYPED_TOOL" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  const normalized = await runRequest(
    "typed-normalization",
    [loadTool, typedTool],
    sseTool("TYPED_TOOL", {
      offset: "12",
      timeout: "1.5",
      enabled: "true",
      questions: '[{"header":"7"}]',
      options: '{"retries":"3"}',
      code: "007",
      ambiguous: "12",
      invalidObject: "{not-json}",
      unknown: "9",
    }) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  const whitespace = await runRequest(
    "typed-normalization",
    [loadTool, typedTool],
    sseTool("TYPED_TOOL", { offset: "   " }) + finish() + "data: [DONE]\n\n",
  )

  expect(toolArguments(loaded.output)).toEqual([{ name: "typed_tool" }])
  expect(toolNames(normalized.output)).toEqual(["typed_tool"])
  expect(toolArguments(normalized.output)).toEqual([{
    offset: 12,
    timeout: 1.5,
    enabled: true,
    questions: [{ header: "7" }],
    options: { retries: 3 },
    code: "007",
    ambiguous: "12",
    invalidObject: "{not-json}",
    unknown: "9",
  }])
  expect(toolArguments(whitespace.output)).toEqual([{ offset: "   " }])
})

test("leaves unsafe schema-declared integer strings unchanged", async () => {
  await runRequest(
    "unsafe-integer",
    [loadTool, typedTool],
    sseTool("load_tool", { name: "typed_tool" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  const { output } = await runRequest(
    "unsafe-integer",
    [loadTool, typedTool],
    sseTool("typed_tool", { offset: "9007199254740993" }) + finish() + "data: [DONE]\n\n",
  )

  expect(toolArguments(output)).toEqual([{ offset: "9007199254740993" }])
})

test("leaves an unknown tool name and arguments unchanged", async () => {
  const { output } = await runRequest(
    "unknown-tool",
    [loadTool],
    sseTool("UNLISTED_TOOL", { limit: "5", enabled: "false" }) + finish() + "data: [DONE]\n\n",
  )

  expect(toolNames(output)).toEqual(["UNLISTED_TOOL"])
  expect(toolArguments(output)).toEqual([{ limit: "5", enabled: "false" }])
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
