import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

const client = new Client({
  name: "graphmind-scribe-smoke-client",
  version: "0.1.0",
});

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/mcpServer.ts"],
  cwd: process.cwd(),
  env: Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ),
  stderr: "pipe",
});

transport.stderr?.on("data", (chunk) => {
  process.stderr.write(chunk);
});

await client.connect(transport);

try {
  const tools = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
  for (const toolName of ["scribe.query", "scribe.lint", "scribe.export_obsidian"]) {
    if (!tools.tools.some((tool) => tool.name === toolName)) {
      throw new Error(`${toolName} was not listed.`);
    }
  }

  const query = await callTool("scribe.query", { query: "GraphMind", limit: 1 });
  const lint = await callTool("scribe.lint", {});
  const exportResult = await callTool("scribe.export_obsidian", {});

  const parsedQuery = parseTextContent(query);
  const parsedLint = parseTextContent(lint);
  const parsedExport = parseTextContent(exportResult);

  if (!Array.isArray(parsedQuery.nodes)) throw new Error("scribe.query did not return nodes.");
  if (!parsedLint.summary || !Array.isArray(parsedLint.findings)) throw new Error("scribe.lint did not return a report.");
  if (!parsedExport.files?.["GraphMind.canvas"] || !parsedExport.manifest) {
    throw new Error("scribe.export_obsidian did not return an Obsidian projection.");
  }

  console.log(JSON.stringify({
    ok: true,
    scribeTools: tools.tools.map((tool) => tool.name).filter((name) => name.startsWith("scribe.")),
    lintSummary: parsedLint.summary,
    exportFileCount: parsedExport.manifest.fileCount,
  }, null, 2));
} finally {
  await transport.close();
}

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await client.request(
    {
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    },
    CallToolResultSchema,
  );
  if (result.isError) throw new Error(`${name} returned error: ${JSON.stringify(result)}`);
  return result;
}

function parseTextContent(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Tool result did not contain text JSON.");
  return JSON.parse(text);
}
