// Starts the server with the exact command/args written to claude_desktop_config.json
// (passed via MCP_CMD / MCP_ARG) and confirms the five tools are listed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "desktop-launch-check", version: "0" });
await client.connect(new StdioClientTransport({ command: process.env.MCP_CMD, args: [process.env.MCP_ARG], env: process.env }));
const { tools } = await client.listTools();
await client.close();
console.log("Tools:", tools.map((t) => t.name).join(", "));
process.exit(tools.length === 5 ? 0 : 1);
