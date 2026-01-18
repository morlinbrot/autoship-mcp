# Autoship MCP

## The Vision

**A drop-in feedback-to-code pipeline for developers.**

You're building an app. You want tight feedback cycles where user requests go directly to an AI that implements them. Here's how it works:

1. **Drop-in React components** - Add a floating feedback button, task entry popup, and task list to your app in minutes
2. **Supabase backend** - Provide your credentials, run the migrations, done. Tasks are stored in your database.
3. **GitHub Action** - Install the action in your repo. It wakes up periodically, checks for new tasks, and spawns Claude instances to work on them.
4. **Two-way communication** - Claude can ask clarifying questions through the same UI. Users answer, Claude continues.
5. **PRs, not commits** - When Claude finishes a task, it opens a PR. You review and merge. A new feature ships.

**The result**: Your users submit feedback → AI implements it → You review a PR → Feature deployed. No tickets, no backlog grooming, no context switching.

---

This document outlines how to set up an autonomous Claude agent that wakes up on a schedule, reads todos from a Supabase database, works on them, and creates branches with the changes.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     GitHub Actions (Scheduled)                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  1. Checkout repo                                          │  │
│  │  2. Start MCP server (subprocess)                          │  │
│  │  3. Run Claude Code with --print                           │  │
│  │  4. Push branch if changes made                            │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ stdio (JSON-RPC)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Server (todo-db)                         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Tools:                                                    │  │
│  │  - list_pending_todos    → SELECT * FROM agent_todos       │  │
│  │  - claim_todo            → UPDATE status = 'in_progress'   │  │
│  │  - complete_todo         → UPDATE status = 'complete'      │  │
│  │  - fail_todo             → UPDATE status = 'failed'        │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Supabase (PostgreSQL)                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Table: agent_todos                                        │  │
│  │  - id, title, description, priority, status, branch_name   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Database Schema

Create a new migration for the agent todos table.

### File: `supabase/migrations/YYYYMMDDHHMMSS_add_agent_todos.sql`

```sql
-- Agent todos table for autonomous Claude agent
CREATE TABLE IF NOT EXISTS agent_todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    priority INTEGER DEFAULT 0,  -- Higher = more urgent
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'complete', 'failed')),
    branch_name TEXT,
    pr_url TEXT,
    notes TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- Index for finding pending todos quickly
CREATE INDEX idx_agent_todos_status_priority ON agent_todos(status, priority DESC);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_agent_todos_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_todos_updated_at
    BEFORE UPDATE ON agent_todos
    FOR EACH ROW
    EXECUTE FUNCTION update_agent_todos_updated_at();

-- RLS policies (assuming you want admin-only access via service key)
ALTER TABLE agent_todos ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (used by the MCP server)
CREATE POLICY "Service role has full access to agent_todos"
    ON agent_todos
    FOR ALL
    USING (true)
    WITH CHECK (true);
```

Run the migration:

```bash
supabase db push
# or
supabase migration up
```

---

## Phase 2: MCP Server Implementation

### Directory Structure

```
mcp-servers/
└── todo-db/
    ├── package.json
    ├── tsconfig.json
    └── src/
        └── index.ts
```

### File: `mcp-servers/todo-db/package.json`

```json
{
  "name": "todo-db-mcp",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@supabase/supabase-js": "^2.90.1"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.8.0"
  }
}
```

### File: `mcp-servers/todo-db/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

### File: `mcp-servers/todo-db/src/index.ts`

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Validate environment
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables",
  );
  process.exit(1);
}

const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
);

// Types
interface AgentTodo {
  id: string;
  title: string;
  description: string;
  priority: number;
  status: "pending" | "in_progress" | "complete" | "failed";
  branch_name: string | null;
  pr_url: string | null;
  notes: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// Create MCP server
const server = new McpServer({
  name: "todo-db",
  version: "1.0.0",
});

// Tool: List pending todos
server.tool(
  "list_pending_todos",
  "List all pending todos from the database, ordered by priority (highest first)",
  {},
  async () => {
    const { data, error } = await supabase
      .from("agent_todos")
      .select("*")
      .eq("status", "pending")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true });

    if (error) {
      return {
        content: [
          { type: "text", text: `Error fetching todos: ${error.message}` },
        ],
        isError: true,
      };
    }

    if (!data || data.length === 0) {
      return {
        content: [{ type: "text", text: "No pending todos found." }],
      };
    }

    const formatted = (data as AgentTodo[])
      .map(
        (todo, i) =>
          `${i + 1}. [${todo.id}] (priority: ${todo.priority}) ${todo.title}\n   ${todo.description}`,
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${data.length} pending todo(s):\n\n${formatted}`,
        },
      ],
    };
  },
);

// Tool: Get todo details
server.tool(
  "get_todo",
  "Get full details of a specific todo by ID",
  {
    todo_id: z.string().describe("The todo ID"),
  },
  async ({ todo_id }) => {
    const { data, error } = await supabase
      .from("agent_todos")
      .select("*")
      .eq("id", todo_id)
      .single();

    if (error) {
      return {
        content: [
          { type: "text", text: `Error fetching todo: ${error.message}` },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },
);

// Tool: Claim a todo (mark as in_progress)
server.tool(
  "claim_todo",
  "Mark a todo as in_progress. Call this before starting work on a todo.",
  {
    todo_id: z.string().describe("The todo ID to claim"),
  },
  async ({ todo_id }) => {
    const { data, error } = await supabase
      .from("agent_todos")
      .update({
        status: "in_progress",
        started_at: new Date().toISOString(),
      })
      .eq("id", todo_id)
      .eq("status", "pending") // Only claim if still pending
      .select()
      .single();

    if (error) {
      return {
        content: [
          { type: "text", text: `Error claiming todo: ${error.message}` },
        ],
        isError: true,
      };
    }

    if (!data) {
      return {
        content: [
          {
            type: "text",
            text: `Todo ${todo_id} is not available (may already be claimed or completed).`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text", text: `Successfully claimed todo: ${data.title}` },
      ],
    };
  },
);

// Tool: Complete a todo
server.tool(
  "complete_todo",
  "Mark a todo as complete. Call this after successfully implementing the changes.",
  {
    todo_id: z.string().describe("The todo ID"),
    branch_name: z.string().describe("The git branch containing the changes"),
    notes: z.string().optional().describe("Implementation notes or summary"),
  },
  async ({ todo_id, branch_name, notes }) => {
    const { data, error } = await supabase
      .from("agent_todos")
      .update({
        status: "complete",
        branch_name,
        notes: notes || null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", todo_id)
      .select()
      .single();

    if (error) {
      return {
        content: [
          { type: "text", text: `Error completing todo: ${error.message}` },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Todo "${data.title}" marked as complete. Branch: ${branch_name}`,
        },
      ],
    };
  },
);

// Tool: Fail a todo
server.tool(
  "fail_todo",
  "Mark a todo as failed. Call this if you cannot complete the task.",
  {
    todo_id: z.string().describe("The todo ID"),
    error_message: z
      .string()
      .describe("Explanation of why the todo could not be completed"),
  },
  async ({ todo_id, error_message }) => {
    const { data, error } = await supabase
      .from("agent_todos")
      .update({
        status: "failed",
        error_message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", todo_id)
      .select()
      .single();

    if (error) {
      return {
        content: [
          { type: "text", text: `Error updating todo: ${error.message}` },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text", text: `Todo "${data.title}" marked as failed.` },
      ],
    };
  },
);

// Tool: Add a new todo (useful for the agent to create follow-up tasks)
server.tool(
  "add_todo",
  "Add a new todo to the queue. Use this for follow-up tasks discovered during implementation.",
  {
    title: z.string().describe("Short title for the todo"),
    description: z
      .string()
      .describe("Detailed description of what needs to be done"),
    priority: z
      .number()
      .default(0)
      .describe("Priority level (higher = more urgent)"),
  },
  async ({ title, description, priority }) => {
    const id = `todo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const { data, error } = await supabase
      .from("agent_todos")
      .insert({
        id,
        title,
        description,
        priority,
        status: "pending",
      })
      .select()
      .single();

    if (error) {
      return {
        content: [
          { type: "text", text: `Error adding todo: ${error.message}` },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: `Created new todo [${id}]: ${title}` }],
    };
  },
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Todo DB MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
```

### Build the MCP Server

```bash
cd mcp-servers/todo-db
npm install
npm run build
```

---

## Phase 3: MCP Configuration

### File: `.mcp.json` (repository root)

```json
{
  "mcpServers": {
    "todo-db": {
      "command": "node",
      "args": ["./mcp-servers/todo-db/dist/index.js"],
      "env": {
        "SUPABASE_URL": "${SUPABASE_URL}",
        "SUPABASE_SERVICE_KEY": "${SUPABASE_SERVICE_KEY}"
      }
    }
  }
}
```

---

## Phase 4: GitHub Actions Workflow

### File: `.github/workflows/claude-agent.yml`

```yaml
name: Claude Agent

on:
  # Run every 6 hours
  schedule:
    - cron: "0 */6 * * *"

  # Allow manual trigger
  workflow_dispatch:
    inputs:
      prompt_override:
        description: "Custom prompt for Claude (optional)"
        required: false
        type: string

permissions:
  contents: write
  pull-requests: write

jobs:
  work-on-todos:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Full history for git operations

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Build MCP server
        run: |
          cd mcp-servers/todo-db
          npm ci
          npm run build

      - name: Configure git
        run: |
          git config user.name "Claude Agent"
          git config user.email "claude-agent@example.com"

      - name: Run Claude Agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
        run: |
          # Default prompt
          PROMPT="You are an autonomous coding agent. Your job is to:

          1. Use the list_pending_todos tool to see available tasks
          2. If there are pending todos, pick the highest priority one
          3. Use claim_todo to mark it as in progress
          4. Read the todo description carefully and implement the requested changes
          5. Create a new git branch with a descriptive name (e.g., 'agent/add-logout-button')
          6. Make the necessary code changes
          7. Commit your changes with a clear commit message
          8. Use complete_todo to mark the task as done, including the branch name
          9. If you encounter an error you cannot resolve, use fail_todo with a clear explanation

          Important guidelines:
          - Only work on ONE todo per run
          - Make minimal, focused changes
          - Write clean, well-tested code
          - If a task is unclear, mark it as failed with questions rather than guessing

          Start by listing the pending todos."

          # Use override if provided
          if [ -n "${{ inputs.prompt_override }}" ]; then
            PROMPT="${{ inputs.prompt_override }}"
          fi

          npx @anthropic-ai/claude-code --print "$PROMPT"

      - name: Push branch if created
        run: |
          # Check if we're on a new branch (not main)
          CURRENT_BRANCH=$(git branch --show-current)
          if [ "$CURRENT_BRANCH" != "main" ] && [ -n "$CURRENT_BRANCH" ]; then
            echo "Pushing branch: $CURRENT_BRANCH"
            git push -u origin "$CURRENT_BRANCH"
            
            # Create PR using GitHub CLI
            gh pr create \
              --title "$(git log -1 --pretty=%s)" \
              --body "This PR was created by the Claude Agent.

              See the agent_todos table for task details." \
              --base main \
              --head "$CURRENT_BRANCH"
          else
            echo "No new branch to push"
          fi
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Phase 5: GitHub Secrets Setup

Add these secrets to your repository (Settings → Secrets and variables → Actions):

| Secret Name            | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `ANTHROPIC_API_KEY`    | Your Anthropic API key                                 |
| `SUPABASE_URL`         | Supabase project URL (e.g., `https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (NOT the anon key)           |

**Important**: Use the service role key, not the anon key. The service role key bypasses RLS and is required for the agent to access `agent_todos`.

---

## Phase 6: Testing Locally

### 1. Test the MCP server standalone

```bash
# Set environment variables
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_KEY="your-service-key"

# Run the server (it communicates via stdio, so this will just hang waiting for input)
node mcp-servers/todo-db/dist/index.js
```

### 2. Test with Claude Code locally

```bash
# Add a test todo via Supabase dashboard or SQL:
# INSERT INTO agent_todos (id, title, description, priority)
# VALUES ('test-001', 'Add hello world', 'Add a console.log("Hello World") to src/main.tsx', 5);

# Run Claude with the MCP server
claude "Use the todo-db tools to list pending todos and tell me what you see"
```

### 3. Full local test

```bash
claude --print "List pending todos from the database using the todo-db tools. If there are any, claim the highest priority one and implement it."
```

---

## Usage: Adding Todos

### Via Supabase Dashboard

Go to Table Editor → agent_todos → Insert row

### Via SQL

```sql
INSERT INTO agent_todos (id, title, description, priority) VALUES
  ('todo-001', 'Add dark mode toggle', 'Add a dark mode toggle to the settings page. Store preference in localStorage.', 5),
  ('todo-002', 'Fix budget rounding', 'Budget amounts sometimes show too many decimal places. Round to 2 places.', 3);
```

### Via API (e.g., from another app)

```typescript
const { data, error } = await supabase.from("agent_todos").insert({
  id: `todo_${Date.now()}`,
  title: "Implement feature X",
  description: "Detailed description of what needs to be done...",
  priority: 5,
});
```

---

## Monitoring

### Check agent activity

```sql
-- Recent activity
SELECT id, title, status, started_at, completed_at, branch_name
FROM agent_todos
ORDER BY updated_at DESC
LIMIT 10;

-- Failed tasks that need attention
SELECT id, title, error_message, created_at
FROM agent_todos
WHERE status = 'failed';

-- In-progress tasks (might be stuck)
SELECT id, title, started_at
FROM agent_todos
WHERE status = 'in_progress'
AND started_at < NOW() - INTERVAL '1 hour';
```

### GitHub Actions logs

Check the Actions tab in your repository to see Claude's output for each run.

---

## Security Considerations

1. **Service Key Protection**: The Supabase service key is highly privileged. Only use it in GitHub Actions secrets, never commit it.

2. **Code Review**: The agent creates branches and PRs, but humans should review before merging.

3. **Rate Limiting**: The 6-hour schedule is conservative. Adjust based on your needs and API costs.

4. **Scope Limiting**: Consider adding constraints to the agent's prompt to prevent it from modifying sensitive files.

5. **Sandboxing**: GitHub Actions run in isolated containers, providing natural sandboxing.

---

## Cost Estimation

- Each Claude Code run uses API tokens based on context length and output
- A typical todo might cost $0.10-$1.00 depending on complexity
- With 4 runs/day, expect roughly $10-30/month (varies widely by task complexity)
- Monitor your Anthropic dashboard for actual usage

---

## Next Steps

1. [ ] Apply the database migration
2. [ ] Create the MCP server directory and files
3. [ ] Build and test the MCP server locally
4. [ ] Add the GitHub secrets
5. [ ] Create the GitHub Actions workflow
6. [ ] Add a test todo and trigger the workflow manually
7. [ ] Review the PR created by the agent
