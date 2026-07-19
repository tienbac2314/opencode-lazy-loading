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

function sseText(field: "content" | "reasoning_content", text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { [field]: text } }] })}\n\n`
}

function sseTextFinish(field: "content" | "reasoning_content", text: string, reason = "stop"): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { [field]: text }, finish_reason: reason }] })}\n\n`
}

function sseToolFragment(argumentsFragment: string, name?: string, id?: string): string {
  return `data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          ...(id ? { id, type: "function" } : {}),
          function: { ...(name ? { name } : {}), arguments: argumentsFragment },
        }],
      },
    }],
  })}\n\n`
}

function sseRawToolCall(call: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`
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

function toolIndexes(output: string): number[] {
  return events(output).flatMap((event) =>
    event.choices[0]?.delta?.tool_calls?.map((call: any) => call.index) ?? [],
  )
}

function toolCallDeltas(output: string): any[] {
  return events(output).flatMap((event) => event.choices[0]?.delta?.tool_calls ?? [])
}

function expectOnlyFinalFinish(output: string, reason: string): void {
  const parsedEvents = events(output)
  expect(parsedEvents.filter((event) => event.choices[0]?.finish_reason != null)).toHaveLength(1)
  expect(parsedEvents.at(-1)?.choices[0]).toEqual({ delta: {}, finish_reason: reason })
}

function streamedText(output: string, field: "content" | "reasoning_content"): string {
  return events(output)
    .map((event) => event.choices[0]?.delta?.[field])
    .filter((value): value is string => typeof value === "string")
    .join("")
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

test("converts a split DSML block to a loaded built-in call while preserving surrounding content", async () => {
  await runRequest(
    "dsml-typed",
    [loadTool, typedTool],
    sseTool("load_tool", { name: "typed_tool" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  const { output } = await runRequest(
    "dsml-typed",
    [loadTool, typedTool],
    sseText("content", "before <｜｜DS")
      + sseText("content", "ML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"offset\" string=\"true\">230</｜｜DSML｜｜para")
      + sseText("content", "meter><｜｜DSML｜｜parameter name=\"code\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DS")
      + sseText("content", "ML｜｜tool_calls> after")
      + finish()
      + "data: [DONE]\n\n",
  )

  expect(streamedText(output, "content")).toBe("before  after")
  expect(toolNames(output)).toEqual(["typed_tool"])
  expect(toolArguments(output)).toEqual([{ offset: 230, code: "230" }])
  expect(events(output).at(-1)).toEqual({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })
  expect(output).toContain("data: [DONE]\n\n")
})

test("preserves a complete invocation-free DSML-looking block as ordinary text", async () => {
  const block = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜parameter name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜tool_calls>"
  const { output } = await runRequest(
    "dsml-no-invoke",
    [loadTool, typedTool],
    sseText("content", block) + finish() + "data: [DONE]\n\n",
  )

  expect(streamedText(output, "content")).toBe(block)
  expect(toolNames(output)).toEqual([])
})

test("preserves ordinary reasoning content unchanged", async () => {
  const reasoning = "Compare <xml-like> text without invoking a tool."
  const { output } = await runRequest(
    "ordinary-reasoning",
    [loadTool, typedTool],
    sseText("reasoning_content", reasoning) + finish() + "data: [DONE]\n\n",
  )

  expect(streamedText(output, "reasoning_content")).toBe(reasoning)
  expect(toolNames(output)).toEqual([])
})

test("flushes a partial DSML marker as text when the stream closes", async () => {
  const partial = "before <｜｜DSML"
  const { output } = await runRequest(
    "dsml-partial-marker",
    [loadTool, typedTool],
    sseText("content", partial),
  )

  expect(streamedText(output, "content")).toBe(partial)
  expect(toolNames(output)).toEqual([])
})

test("flushes an incomplete DSML block as text when the stream closes", async () => {
  const partial = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\">"
  const { output } = await runRequest(
    "dsml-incomplete-block",
    [loadTool, typedTool],
    sseText("content", partial),
  )

  expect(streamedText(output, "content")).toBe(partial)
  expect(toolNames(output)).toEqual([])
})

test("converts a DSML MCP call directly with MCP schema normalization", async () => {
  const block = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"codegraph_explore\"><｜｜DSML｜｜parameter name=\"query\">compatibility</｜｜DSML｜｜parameter><｜｜DSML｜｜parameter name=\"limit\" string=\"true\">5</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>"
  const { output } = await runRequest(
    "dsml-mcp",
    [loadTool, codegraphTool],
    sseText("content", block) + finish() + "data: [DONE]\n\n",
  )

  expect(streamedText(output, "content")).toBe("")
  expect(toolNames(output)).toEqual(["codegraph_explore"])
  expect(toolArguments(output)).toEqual([{ query: "compatibility", limit: 5 }])
})

test("preserves fragmented native tool-call arguments", async () => {
  await runRequest(
    "native-fragments",
    [loadTool, typedTool],
    sseTool("load_tool", { name: "typed_tool" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  const { output } = await runRequest(
    "native-fragments",
    [loadTool, typedTool],
    sseToolFragment('{"offset":"', "typed_tool", "call_fragmented")
      + sseToolFragment('230","code":"230"}')
      + finish()
      + "data: [DONE]\n\n",
  )

  expect(toolNames(output)).toEqual(["typed_tool"])
  expect(toolArguments(output)).toEqual([{ offset: 230, code: "230" }])
})

test("preserves DSML-looking blocks with malformed tag or attribute names", async () => {
  const malformedBlocks = [
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke-other name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"><｜｜DSML｜｜parameter-more name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke data-name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
  ]

  for (const [index, block] of malformedBlocks.entries()) {
    const { output } = await runRequest(
      `dsml-malformed-${index}`,
      [loadTool, typedTool],
      sseText("content", block) + finish() + "data: [DONE]\n\n",
    )

    expect(streamedText(output, "content")).toBe(block)
    expect(toolNames(output)).toEqual([])
  }
})

test("preserves DSML blocks with duplicate attributes or parameter names", async () => {
  const malformedBlocks = [
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\" name=\"other\"><｜｜DSML｜｜parameter name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"offset\" name=\"other\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"offset\">230</｜｜DSML｜｜parameter><｜｜DSML｜｜parameter name=\"offset\">231</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\" __proto__=\"first\" __proto__=\"second\"><｜｜DSML｜｜parameter name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"offset\" __proto__=\"first\" __proto__=\"second\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"__proto__\">first</｜｜DSML｜｜parameter><｜｜DSML｜｜parameter name=\"__proto__\">second</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
  ]

  for (const [index, block] of malformedBlocks.entries()) {
    const { output } = await runRequest(
      `dsml-duplicate-${index}`,
      [loadTool, typedTool],
      sseText("content", block) + finish() + "data: [DONE]\n\n",
    )

    expect(streamedText(output, "content")).toBe(block)
    expect(toolCallDeltas(output)).toEqual([])
  }
})

test("accepts unique extra DSML attributes", async () => {
  const block = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"codegraph_explore\" mode=\"fast\"><｜｜DSML｜｜parameter name=\"query\" string=\"true\">compatibility</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>"
  const { output } = await runRequest(
    "dsml-unique-extra-attributes",
    [loadTool, codegraphTool],
    sseText("content", block) + finish("tool_calls") + "data: [DONE]\n\n",
  )

  expect(streamedText(output, "content")).toBe("")
  expect(toolNames(output)).toEqual(["codegraph_explore"])
  expect(toolArguments(output)).toEqual([{ query: "compatibility" }])
})

test("treats unique __proto__ DSML keys as ordinary data", async () => {
  const block = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"codegraph_explore\" __proto__=\"invoke-metadata\"><｜｜DSML｜｜parameter name=\"query\" __proto__=\"parameter-metadata\">compatibility</｜｜DSML｜｜parameter><｜｜DSML｜｜parameter name=\"__proto__\">argument-value</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>"
  const { output } = await runRequest(
    "dsml-proto-data",
    [loadTool, codegraphTool],
    sseText("content", block) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  const args = toolArguments(output).at(0)

  expect(toolNames(output)).toEqual(["codegraph_explore"])
  expect(args?.query).toBe("compatibility")
  expect(Object.prototype.hasOwnProperty.call(args, "__proto__")).toBe(true)
  expect(args?.["__proto__"]).toBe("argument-value")
})

test("turns a DSML gateway load coalesced with stop into a tool-call continuation", async () => {
  const converted = await runRequest(
    "dsml-coalesced-stop",
    [loadTool, typedTool],
    sseText("content", "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>")
      + sseTextFinish("content", "</｜｜DSML｜｜tool_calls>")
      + "data: [DONE]\n\n",
  )
  const nextTurn = await runRequest(
    "dsml-coalesced-stop",
    [loadTool, typedTool],
    sseTool("typed_tool", { offset: "231" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  const genuineStop = await runRequest(
    "dsml-coalesced-stop",
    [loadTool, typedTool],
    finish() + "data: [DONE]\n\n",
  )
  const afterStop = await runRequest(
    "dsml-coalesced-stop",
    [loadTool, typedTool],
    sseTool("typed_tool", { offset: "232" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )

  expect(streamedText(converted.output, "content")).toBe("")
  expect(toolNames(converted.output)).toEqual(["load_tool"])
  expect(toolArguments(converted.output)).toEqual([{ name: "typed_tool" }])
  expect(events(converted.output).at(-1)?.choices[0]?.finish_reason).toBe("tool_calls")
  expect(toolNames(nextTurn.output)).toEqual(["typed_tool"])
  expect(events(genuineStop.output)).toEqual([{ choices: [{ delta: {}, finish_reason: "stop" }] }])
  expect(toolNames(afterStop.output)).toEqual(["load_tool"])
})

test("turns a DSML gateway load followed by a separate stop into a tool-call continuation", async () => {
  const block = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>"
  const converted = await runRequest(
    "dsml-separated-stop",
    [loadTool, typedTool],
    sseText("content", block) + finish() + "data: [DONE]\n\n",
  )
  const continuation = await runRequest(
    "dsml-separated-stop",
    [loadTool, typedTool],
    sseTool("typed_tool", { offset: "231" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  await runRequest(
    "dsml-separated-stop",
    [loadTool, typedTool],
    finish() + "data: [DONE]\n\n",
  )
  const afterGenuineStop = await runRequest(
    "dsml-separated-stop",
    [loadTool, typedTool],
    sseTool("typed_tool", { offset: "232" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )

  expect(toolNames(converted.output)).toEqual(["load_tool"])
  expect(events(converted.output).at(-1)?.choices[0]?.finish_reason).toBe("tool_calls")
  expect(toolNames(continuation.output)).toEqual(["typed_tool"])
  expect(toolNames(afterGenuineStop.output)).toEqual(["load_tool"])
})

test("preserves a delta-less stop event and clears loaded state", async () => {
  await runRequest(
    "delta-less-stop",
    [loadTool, typedTool],
    sseTool("load_tool", { name: "typed_tool" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  const deltaLessStop = `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n`
  const stopped = await runRequest(
    "delta-less-stop",
    [loadTool, typedTool],
    deltaLessStop + "data: [DONE]\n\n",
  )
  const nextTurn = await runRequest(
    "delta-less-stop",
    [loadTool, typedTool],
    sseTool("typed_tool", { offset: "230" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )

  expect(events(stopped.output)).toEqual([{ choices: [{ finish_reason: "stop" }] }])
  expect(toolNames(nextTurn.output)).toEqual(["load_tool"])
})

test("assigns distinct emitted indexes to DSML and later native calls", async () => {
  const block = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"codegraph_explore\"><｜｜DSML｜｜parameter name=\"query\">first</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>"
  const { output } = await runRequest(
    "dsml-native-indexes",
    [loadTool, codegraphTool, uppercaseReadMcpTool],
    sseText("content", block)
      + sseTool("READ", { limit: "7" })
      + finish()
      + "data: [DONE]\n\n",
  )

  expect(toolNames(output)).toEqual(["codegraph_explore", "READ"])
  expect(toolIndexes(output)).toEqual([0, 1])
  expect(toolArguments(output)).toEqual([{ query: "first" }, { limit: 7 }])
})

test("assigns indexes in emission order when split DSML closes beside a native call", async () => {
  const firstHalf = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"codegraph_explore\"><｜｜DSML｜｜parameter name=\"query\">first</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>"
  const coalesced = `data: ${JSON.stringify({
    choices: [{
      delta: {
        content: "</｜｜DSML｜｜tool_calls>",
        tool_calls: [{
          index: 0,
          id: "call_native_after_dsml",
          type: "function",
          function: { name: "READ", arguments: JSON.stringify({ limit: "7" }) },
        }],
      },
    }],
  })}\n\n`
  const { output } = await runRequest(
    "split-dsml-native-order",
    [loadTool, codegraphTool, uppercaseReadMcpTool],
    sseText("content", firstHalf) + coalesced + finish() + "data: [DONE]\n\n",
  )
  const calls = toolCallDeltas(output)

  expect(calls.map((call) => call.function.name)).toEqual(["codegraph_explore", "READ"])
  expect(calls.map((call) => call.index)).toEqual([0, 1])
  expect(calls.at(1)?.id).toBe("call_native_after_dsml")
})

test("orders a complete same-envelope DSML call before its native call", async () => {
  const block = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"codegraph_explore\"><｜｜DSML｜｜parameter name=\"query\">first</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>"
  const combined = `data: ${JSON.stringify({
    choices: [{
      delta: {
        content: block,
        tool_calls: [{
          index: 0,
          id: "call_native_same_envelope",
          type: "function",
          function: { name: "READ", arguments: JSON.stringify({ limit: "7" }) },
        }],
      },
    }],
  })}\n\n`
  const { output } = await runRequest(
    "same-envelope-dsml-native-order",
    [loadTool, codegraphTool, uppercaseReadMcpTool],
    combined + finish() + "data: [DONE]\n\n",
  )
  const calls = toolCallDeltas(output)

  expect(calls.map((call) => call.function.name)).toEqual(["codegraph_explore", "READ"])
  expect(calls.map((call) => call.index)).toEqual([0, 1])
  expect(calls.at(1)?.id).toBe("call_native_same_envelope")
})

test("rewrites same-envelope calls for one unloaded built-in in emission order", async () => {
  const block = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"read\"><｜｜DSML｜｜parameter name=\"path\">/dsml</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>"
  const combined = `data: ${JSON.stringify({
    choices: [{
      delta: {
        content: block,
        tool_calls: [{
          index: 0,
          id: "call_native_same_builtin",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "/native" }) },
        }],
      },
    }],
  })}\n\n`
  const { output } = await runRequest(
    "same-envelope-same-builtin-order",
    [loadTool, readTool],
    combined + finish("tool_calls") + "data: [DONE]\n\n",
  )

  expect(toolNames(output)).toEqual(["load_tool", "read"])
  expect(toolIndexes(output)).toEqual([0, 1])
  expect(toolArguments(output)).toEqual([{ name: "read" }, { path: "/native" }])
})

test("rejects unconsumed invoke and parameter attribute text", async () => {
  const malformedBlocks = [
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"junk><｜｜DSML｜｜parameter name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke junk name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"offset\"junk>230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"><｜｜DSML｜｜parameter junk name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
  ]

  for (const [index, block] of malformedBlocks.entries()) {
    const { output } = await runRequest(
      `dsml-malformed-attributes-${index}`,
      [loadTool, typedTool],
      sseText("content", block) + finish() + "data: [DONE]\n\n",
    )

    expect(streamedText(output, "content")).toBe(block)
    expect(toolCallDeltas(output)).toEqual([])
  }
})

test("emits a final tool-calls finish after content before a complete DSML call", async () => {
  await runRequest(
    "finish-before-dsml",
    [loadTool, typedTool],
    sseTool("load_tool", { name: "typed_tool" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  const block = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>"
  const { output } = await runRequest(
    "finish-before-dsml",
    [loadTool, typedTool],
    sseTextFinish("content", `before ${block}`) + "data: [DONE]\n\n",
  )

  expect(streamedText(output, "content")).toBe("before ")
  expect(toolNames(output)).toEqual(["typed_tool"])
  expectOnlyFinalFinish(output, "tool_calls")
})

test("emits a final tool-calls finish after trailing content following a complete DSML call", async () => {
  await runRequest(
    "finish-after-dsml",
    [loadTool, typedTool],
    sseTool("load_tool", { name: "typed_tool" }) + finish("tool_calls") + "data: [DONE]\n\n",
  )
  const block = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"typed_tool\"><｜｜DSML｜｜parameter name=\"offset\">230</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>"
  const { output } = await runRequest(
    "finish-after-dsml",
    [loadTool, typedTool],
    sseTextFinish("content", `${block} after`) + "data: [DONE]\n\n",
  )

  expect(streamedText(output, "content")).toBe(" after")
  expect(toolNames(output)).toEqual(["typed_tool"])
  expectOnlyFinalFinish(output, "tool_calls")
})

test("emits a final stop after flushing a partial marker suffix", async () => {
  const { output } = await runRequest(
    "finish-partial-marker",
    [loadTool, typedTool],
    sseTextFinish("content", "safe <｜｜DS") + "data: [DONE]\n\n",
  )

  expect(streamedText(output, "content")).toBe("safe <｜｜DS")
  expect(toolCallDeltas(output)).toEqual([])
  expectOnlyFinalFinish(output, "stop")
})

test("emits a final stop after content and reasoning content", async () => {
  const upstream = `data: ${JSON.stringify({
    id: "finish-content-reasoning",
    choices: [{ delta: { content: "answer", reasoning_content: "thought" }, finish_reason: "stop" }],
  })}\n\n`
  const { output } = await runRequest(
    "finish-content-reasoning",
    [loadTool],
    upstream + "data: [DONE]\n\n",
  )

  expect(streamedText(output, "content")).toBe("answer")
  expect(streamedText(output, "reasoning_content")).toBe("thought")
  expect(events(output).at(-1)?.id).toBe("finish-content-reasoning")
  expectOnlyFinalFinish(output, "stop")
})

test("keeps one downstream index and id across native identity and completed function fragments", async () => {
  const { output } = await runRequest(
    "native-fragment-identity",
    [loadTool, codegraphTool],
    sseRawToolCall({ index: 0, id: "call_native_identity", type: "function" })
      + sseRawToolCall({
        index: 0,
        function: { name: "codegraph_explore", arguments: '{"query":"normal","limit":"5"}' },
      })
      + finish()
      + "data: [DONE]\n\n",
  )
  const calls = toolCallDeltas(output)

  expect(calls.map((call) => call.index)).toEqual([0, 0])
  expect(calls.map((call) => call.id)).toEqual(["call_native_identity", "call_native_identity"])
  expect(calls.at(-1)?.function).toEqual({
    name: "codegraph_explore",
    arguments: JSON.stringify({ query: "normal", limit: 5 }),
  })
})

test("keeps one downstream index and id when native function arguments remain incomplete", async () => {
  const { output } = await runRequest(
    "native-fragment-incomplete",
    [loadTool, codegraphTool],
    sseRawToolCall({ index: 0, id: "call_native_incomplete", type: "function" })
      + sseRawToolCall({
        index: 0,
        function: { name: "codegraph_explore", arguments: '{"query":"partial"' },
      }),
  )
  const calls = toolCallDeltas(output)

  expect(calls.map((call) => call.index)).toEqual([0, 0])
  expect(calls.map((call) => call.id)).toEqual(["call_native_incomplete", "call_native_incomplete"])
  expect(calls.at(-1)?.function).toEqual({
    name: "codegraph_explore",
    arguments: '{"query":"partial"',
  })
})

afterAll(() => {
  globalThis.fetch = originalFetch
})
