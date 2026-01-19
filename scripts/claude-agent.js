#!/usr/bin/env node

/**
 * Claude Agent Script (Self-contained)
 *
 * This script runs Claude as an autonomous agent that:
 * 1. Downloads and sets up the autoship MCP server automatically
 * 2. Connects to the MCP server to get tasks
 * 3. Works on the highest priority task
 * 4. Can execute bash commands, read/write files, and use git
 * 5. Creates branches and commits for completed work
 *
 * Usage:
 *   npx github:morlinbrot/autoship/scripts
 *   # or
 *   curl -sL https://raw.githubusercontent.com/morlinbrot/autoship/main/scripts/claude-agent.js | node
 *
 * Required environment variables:
 *   - ANTHROPIC_API_KEY
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_KEY
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawn, execSync } from "child_process";
import { readFile, writeFile, access, mkdir, rm } from "fs/promises";
import { constants, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const MODEL = "claude-sonnet-4-20250514";
const MAX_TURNS = 50;
const MAX_TOKENS = 8096;

const AUTOSHIP_REPO = "https://github.com/morlinbrot/autoship-mcp.git";
const MCP_SERVER_PATH = "mcp-servers/autoship-mcp";

// Initialize Anthropic client
const anthropic = new Anthropic();

/**
 * Downloads and builds the MCP server from the autoship repository
 * Returns the path to the built MCP server
 */
async function setupMcpServer() {
  // First, check if we're running inside the autoship repo itself
  const localMcpPath = path.resolve(
    __dirname,
    "../mcp-servers/autoship-mcp/dist/index.js",
  );
  if (existsSync(localMcpPath)) {
    console.log("Found local MCP server, using it directly.\n");
    return localMcpPath;
  }

  // Otherwise, download to temp directory
  const tempDir = path.join(tmpdir(), "autoship-mcp-" + Date.now());
  const mcpDir = path.join(tempDir, MCP_SERVER_PATH);

  console.log("Setting up MCP server...");
  console.log(`  Temp directory: ${tempDir}\n`);

  try {
    // Clone only the MCP server directory (sparse checkout)
    execSync(
      `git clone --depth 1 --filter=blob:none --sparse ${AUTOSHIP_REPO} ${tempDir}`,
      {
        stdio: "pipe",
      },
    );
    execSync(`git -C ${tempDir} sparse-checkout set ${MCP_SERVER_PATH}`, {
      stdio: "pipe",
    });

    // Install dependencies and build
    console.log("  Installing dependencies...");
    execSync("npm ci", { cwd: mcpDir, stdio: "pipe" });

    console.log("  Building MCP server...");
    execSync("npm run build", { cwd: mcpDir, stdio: "pipe" });

    const serverPath = path.join(mcpDir, "dist/index.js");
    console.log("  MCP server ready.\n");

    return serverPath;
  } catch (err) {
    console.error("Failed to setup MCP server:", err.message);
    throw err;
  }
}

// MCP Client for autoship server
class McpClient {
  constructor() {
    this.process = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.buffer = "";
  }

  async connect(mcpServerPath) {
    // Check if the MCP server exists
    try {
      await access(mcpServerPath, constants.F_OK);
    } catch {
      throw new Error(`MCP server not found at ${mcpServerPath}`);
    }

    this.process = spawn("node", [mcpServerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
      },
    });

    this.process.stdout.on("data", (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr.on("data", (data) => {
      // MCP servers often log to stderr, only show errors
      const msg = data.toString();
      if (msg.toLowerCase().includes("error")) {
        console.error("[MCP]", msg);
      }
    });

    this.process.on("error", (err) => {
      console.error("[MCP process error]", err);
    });

    this.process.on("close", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[MCP process closed with code ${code}]`);
      }
    });

    // Initialize the MCP connection
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "claude-agent", version: "1.0.0" },
    });

    // Send initialized notification
    this.sendNotification("notifications/initialized", {});

    return this;
  }

  processBuffer() {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          if (
            message.id !== undefined &&
            this.pendingRequests.has(message.id)
          ) {
            const { resolve, reject } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);
            if (message.error) {
              reject(new Error(message.error.message));
            } else {
              resolve(message.result);
            }
          }
        } catch (e) {
          // Ignore non-JSON lines
        }
      }
    }
  }

  sendNotification(method, params) {
    const message = { jsonrpc: "2.0", method, params };
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }

  sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });
      const message = { jsonrpc: "2.0", id, method, params };
      this.process.stdin.write(JSON.stringify(message) + "\n");

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  async listTools() {
    const result = await this.sendRequest("tools/list", {});
    return result.tools || [];
  }

  async callTool(name, args) {
    const result = await this.sendRequest("tools/call", {
      name,
      arguments: args,
    });
    return result;
  }

  close() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}

// Built-in tools for file operations and bash
const BUILTIN_TOOLS = [
  {
    name: "bash",
    description:
      "Execute a bash command. Use this for git operations, running tests, and other shell commands.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the file to read",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file (creates or overwrites)",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the file to write",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List files in a directory",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The directory path to list (defaults to current directory)",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list recursively",
        },
      },
    },
  },
];

// Execute a bash command
async function executeBash(command) {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", command], {
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
      resolve({
        success: code === 0,
        output: output || "(no output)",
        exitCode: code,
      });
    });

    proc.on("error", (err) => {
      resolve({
        success: false,
        output: `Error spawning process: ${err.message}`,
        exitCode: -1,
      });
    });
  });
}

// Execute a built-in tool
async function executeBuiltinTool(name, input) {
  switch (name) {
    case "bash": {
      const result = await executeBash(input.command);
      return `Exit code: ${result.exitCode}\n${result.output}`;
    }
    case "read_file": {
      try {
        const content = await readFile(input.path, "utf-8");
        return content;
      } catch (err) {
        return `Error reading file: ${err.message}`;
      }
    }
    case "write_file": {
      try {
        await writeFile(input.path, input.content, "utf-8");
        return `Successfully wrote to ${input.path}`;
      } catch (err) {
        return `Error writing file: ${err.message}`;
      }
    }
    case "list_files": {
      const listPath = input.path || ".";
      const flags = input.recursive ? "-laR" : "-la";
      const result = await executeBash(`ls ${flags} "${listPath}"`);
      return result.output;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// Main agent loop
async function runAgent(prompt) {
  console.log("=".repeat(60));
  console.log("Claude Agent Starting");
  console.log("=".repeat(60) + "\n");

  // Validate environment variables
  const requiredEnvVars = [
    "ANTHROPIC_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_KEY",
  ];
  const missing = requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
    process.exit(1);
  }

  // Setup MCP server
  let mcpServerPath;
  try {
    mcpServerPath = await setupMcpServer();
  } catch (err) {
    console.error("Failed to setup MCP server:", err.message);
    process.exit(1);
  }

  // Connect to MCP server
  const mcp = new McpClient();
  try {
    await mcp.connect(mcpServerPath);
    console.log("Connected to MCP server\n");
  } catch (err) {
    console.error("Failed to connect to MCP server:", err.message);
    process.exit(1);
  }

  // Get MCP tools
  let mcpTools = [];
  try {
    mcpTools = await mcp.listTools();
    console.log(`Loaded ${mcpTools.length} MCP tools\n`);
  } catch (err) {
    console.error("Failed to list MCP tools:", err.message);
    process.exit(1);
  }

  // Convert MCP tools to Anthropic format
  const mcpToolsFormatted = mcpTools.map((tool) => ({
    name: `mcp_${tool.name}`,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));

  // Combine all tools
  const allTools = [...BUILTIN_TOOLS, ...mcpToolsFormatted];

  // Initialize conversation
  const messages = [{ role: "user", content: prompt }];

  let turn = 0;
  while (turn < MAX_TURNS) {
    turn++;
    console.log(`\n${"─".repeat(40)}`);
    console.log(`Turn ${turn}`);
    console.log("─".repeat(40) + "\n");

    // Call Claude
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: allTools,
      messages,
    });

    // Process response
    const assistantContent = [];
    let hasToolUse = false;

    for (const block of response.content) {
      if (block.type === "text") {
        console.log("Claude:", block.text);
        assistantContent.push(block);
      } else if (block.type === "tool_use") {
        hasToolUse = true;
        assistantContent.push(block);
        console.log(`\n🔧 Tool: ${block.name}`);
        console.log(
          "   Input:",
          JSON.stringify(block.input, null, 2).split("\n").join("\n   "),
        );
      }
    }

    // Add assistant message to conversation
    messages.push({ role: "assistant", content: assistantContent });

    // If no tool use, we're done
    if (!hasToolUse || response.stop_reason === "end_turn") {
      console.log("\n" + "=".repeat(60));
      console.log("Agent completed");
      console.log("=".repeat(60));
      break;
    }

    // Execute tools and collect results
    const toolResults = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        let result;

        if (block.name.startsWith("mcp_")) {
          // MCP tool
          const mcpToolName = block.name.slice(4); // Remove 'mcp_' prefix
          try {
            const mcpResult = await mcp.callTool(mcpToolName, block.input);
            result =
              mcpResult.content?.map((c) => c.text).join("\n") ||
              JSON.stringify(mcpResult);
          } catch (err) {
            result = `MCP tool error: ${err.message}`;
          }
        } else {
          // Built-in tool
          result = await executeBuiltinTool(block.name, block.input);
        }

        const truncatedResult =
          result.length > 500
            ? result.slice(0, 500) + "\n... (truncated)"
            : result;
        console.log(
          `\n   Result: ${truncatedResult.split("\n").join("\n   ")}`,
        );

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    // Add tool results to conversation
    messages.push({ role: "user", content: toolResults });
  }

  // Cleanup
  mcp.close();

  if (turn >= MAX_TURNS) {
    console.log("\n⚠️  Max turns reached, stopping agent.");
  }
}

// Default system prompt
const DEFAULT_PROMPT = `You are an autonomous coding agent. Your job is to:

1. Use the mcp_list_pending_tasks tool to see available tasks
2. If there are pending tasks, pick the highest priority one
3. Use mcp_claim_task to mark it as in progress
4. Read the task description carefully and implement the requested changes
5. Create a new git branch with a descriptive name (e.g., 'agent/add-logout-button')
6. Make the necessary code changes
7. Commit your changes with a clear commit message
8. Use mcp_complete_task to mark the task as done, including the branch name
9. If you encounter an error you cannot resolve, use mcp_fail_task with a clear explanation
10. If you need clarification, use mcp_ask_question to ask and the task will be marked as needing info until answered

Important guidelines:
- Only work on ONE task per run
- Make minimal, focused changes
- Write clean, well-tested code
- If a task is unclear, use mcp_ask_question rather than guessing
- Check mcp_check_answered_questions if working on a previously blocked task

Start by listing the pending tasks.`;

// Entry point
const prompt = process.argv[2] || DEFAULT_PROMPT;

runAgent(prompt).catch((err) => {
  console.error("Agent error:", err);
  process.exit(1);
});
