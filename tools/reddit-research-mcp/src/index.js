#!/usr/bin/env node
// Reddit Research MCP server (stdio entry point). Read-only search over the
// public Reddit archives (Arctic Shift primary, PullPush fallback). See README.md.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";

await createServer().connect(new StdioServerTransport());
console.error(`reddit-research MCP ${VERSION} running on stdio`);
