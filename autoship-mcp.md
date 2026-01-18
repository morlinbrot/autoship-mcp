# Autoship

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

## Phase 7: React Components

Autoship provides drop-in React components that let users submit feedback and track tasks directly from your app.

### Package Structure

```
@autoship/react/
├── src/
│   ├── index.ts
│   ├── AutoshipProvider.tsx
│   ├── AutoshipButton.tsx
│   ├── TaskDialog.tsx
│   ├── TaskList.tsx
│   ├── QuestionDialog.tsx
│   └── hooks/
│       ├── useAutoship.ts
│       └── useTasks.ts
├── package.json
└── tsconfig.json
```

### Installation

```bash
npm install @autoship/react @supabase/supabase-js
```

### Quick Start

```tsx
// App.tsx
import { AutoshipProvider, AutoshipButton } from "@autoship/react";

function App() {
  return (
    <AutoshipProvider
      supabaseUrl={import.meta.env.VITE_SUPABASE_URL}
      supabaseAnonKey={import.meta.env.VITE_SUPABASE_ANON_KEY}
    >
      <YourApp />
      <AutoshipButton />
    </AutoshipProvider>
  );
}
```

That's it. Users now see a floating button to submit feedback, and can track their requests.

---

### Component: `AutoshipProvider`

Wraps your app and provides Supabase context for all Autoship components.

```tsx
// src/AutoshipProvider.tsx
import React, { createContext, useContext, useMemo } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

interface AutoshipContextValue {
  supabase: SupabaseClient;
  userId?: string;
}

const AutoshipContext = createContext<AutoshipContextValue | null>(null);

export function useAutoshipContext() {
  const ctx = useContext(AutoshipContext);
  if (!ctx)
    throw new Error("useAutoshipContext must be used within AutoshipProvider");
  return ctx;
}

interface AutoshipProviderProps {
  supabaseUrl: string;
  supabaseAnonKey: string;
  userId?: string; // Optional: associate tasks with a user
  children: React.ReactNode;
}

export function AutoshipProvider({
  supabaseUrl,
  supabaseAnonKey,
  userId,
  children,
}: AutoshipProviderProps) {
  const supabase = useMemo(
    () => createClient(supabaseUrl, supabaseAnonKey),
    [supabaseUrl, supabaseAnonKey],
  );

  return (
    <AutoshipContext.Provider value={{ supabase, userId }}>
      {children}
    </AutoshipContext.Provider>
  );
}
```

---

### Component: `AutoshipButton`

A floating action button that opens the task dialog. Positioned in the bottom-right corner by default.

```tsx
// src/AutoshipButton.tsx
import React, { useState } from "react";
import { TaskDialog } from "./TaskDialog";
import { TaskList } from "./TaskList";

interface AutoshipButtonProps {
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  showTaskList?: boolean; // Show list of existing tasks
}

export function AutoshipButton({
  position = "bottom-right",
  showTaskList = true,
}: AutoshipButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<"menu" | "new" | "list">("menu");

  const positionStyles: Record<string, React.CSSProperties> = {
    "bottom-right": { bottom: 20, right: 20 },
    "bottom-left": { bottom: 20, left: 20 },
    "top-right": { top: 20, right: 20 },
    "top-left": { top: 20, left: 20 },
  };

  return (
    <>
      {/* Floating Button */}
      <button
        onClick={() => setIsOpen(true)}
        style={{
          position: "fixed",
          ...positionStyles[position],
          width: 56,
          height: 56,
          borderRadius: "50%",
          backgroundColor: "#6366f1",
          color: "white",
          border: "none",
          cursor: "pointer",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 24,
          zIndex: 9999,
        }}
        aria-label="Open Autoship"
      >
        +
      </button>

      {/* Modal */}
      {isOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10000,
          }}
          onClick={() => {
            setIsOpen(false);
            setView("menu");
          }}
        >
          <div
            style={{
              backgroundColor: "white",
              borderRadius: 12,
              padding: 24,
              minWidth: 400,
              maxWidth: "90vw",
              maxHeight: "80vh",
              overflow: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {view === "menu" && (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <h2 style={{ margin: 0 }}>Autoship</h2>
                <button onClick={() => setView("new")}>
                  Submit New Request
                </button>
                {showTaskList && (
                  <button onClick={() => setView("list")}>
                    View My Requests
                  </button>
                )}
              </div>
            )}
            {view === "new" && (
              <TaskDialog
                onClose={() => {
                  setIsOpen(false);
                  setView("menu");
                }}
                onBack={() => setView("menu")}
              />
            )}
            {view === "list" && <TaskList onBack={() => setView("menu")} />}
          </div>
        </div>
      )}
    </>
  );
}
```

---

### Component: `TaskDialog`

The form for submitting a new task/feature request.

```tsx
// src/TaskDialog.tsx
import React, { useState } from "react";
import { useAutoshipContext } from "./AutoshipProvider";

interface TaskDialogProps {
  onClose: () => void;
  onBack: () => void;
}

export function TaskDialog({ onClose, onBack }: TaskDialogProps) {
  const { supabase, userId } = useAutoshipContext();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;

    setIsSubmitting(true);
    try {
      const id = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const { error } = await supabase.from("agent_todos").insert({
        id,
        title: title.trim(),
        description: description.trim(),
        priority: 0,
        status: "pending",
        submitted_by: userId || null,
      });

      if (error) throw error;

      setSubmitted(true);
      setTimeout(() => onClose(), 2000);
    } catch (err) {
      console.error("Failed to submit task:", err);
      alert("Failed to submit. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div style={{ textAlign: "center", padding: 20 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
        <h3>Request Submitted!</h3>
        <p>We'll get to work on this soon.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <button type="button" onClick={onBack} style={{ marginRight: 12 }}>
          ←
        </button>
        <h2 style={{ margin: 0 }}>New Request</h2>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>
          Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g., Add dark mode"
          style={{
            width: "100%",
            padding: 8,
            borderRadius: 6,
            border: "1px solid #ddd",
          }}
          required
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe what you'd like in detail..."
          rows={5}
          style={{
            width: "100%",
            padding: 8,
            borderRadius: 6,
            border: "1px solid #ddd",
            resize: "vertical",
          }}
          required
        />
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        style={{
          width: "100%",
          padding: 12,
          backgroundColor: "#6366f1",
          color: "white",
          border: "none",
          borderRadius: 6,
          cursor: isSubmitting ? "not-allowed" : "pointer",
        }}
      >
        {isSubmitting ? "Submitting..." : "Submit Request"}
      </button>
    </form>
  );
}
```

---

### Component: `TaskList`

Shows the user's submitted tasks and their status. Also surfaces questions from the AI.

```tsx
// src/TaskList.tsx
import React, { useEffect, useState } from "react";
import { useAutoshipContext } from "./AutoshipProvider";
import { QuestionDialog } from "./QuestionDialog";

interface Task {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "complete" | "failed" | "needs_info";
  branch_name: string | null;
  pr_url: string | null;
  questions: Question[] | null;
  created_at: string;
}

interface Question {
  id: string;
  question: string;
  answer: string | null;
  asked_at: string;
}

interface TaskListProps {
  onBack: () => void;
}

export function TaskList({ onBack }: TaskListProps) {
  const { supabase, userId } = useAutoshipContext();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  useEffect(() => {
    loadTasks();
  }, []);

  const loadTasks = async () => {
    setLoading(true);
    try {
      let query = supabase
        .from("agent_todos")
        .select("*")
        .order("created_at", { ascending: false });

      // If userId is set, only show that user's tasks
      if (userId) {
        query = query.eq("submitted_by", userId);
      }

      const { data, error } = await query;
      if (error) throw error;
      setTasks(data || []);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setLoading(false);
    }
  };

  const statusColors: Record<string, string> = {
    pending: "#f59e0b",
    in_progress: "#3b82f6",
    complete: "#10b981",
    failed: "#ef4444",
    needs_info: "#8b5cf6",
  };

  const statusLabels: Record<string, string> = {
    pending: "Pending",
    in_progress: "In Progress",
    complete: "Complete",
    failed: "Failed",
    needs_info: "Needs Info",
  };

  if (selectedTask) {
    return (
      <QuestionDialog
        task={selectedTask}
        onBack={() => {
          setSelectedTask(null);
          loadTasks();
        }}
        onAnswered={loadTasks}
      />
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <button type="button" onClick={onBack} style={{ marginRight: 12 }}>
          ←
        </button>
        <h2 style={{ margin: 0 }}>My Requests</h2>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : tasks.length === 0 ? (
        <p style={{ color: "#666" }}>No requests yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {tasks.map((task) => (
            <div
              key={task.id}
              style={{
                padding: 12,
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                cursor: task.status === "needs_info" ? "pointer" : "default",
              }}
              onClick={() =>
                task.status === "needs_info" && setSelectedTask(task)
              }
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "start",
                }}
              >
                <h4 style={{ margin: 0 }}>{task.title}</h4>
                <span
                  style={{
                    backgroundColor: statusColors[task.status],
                    color: "white",
                    padding: "2px 8px",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                >
                  {statusLabels[task.status]}
                </span>
              </div>

              <p style={{ margin: "8px 0", fontSize: 14, color: "#666" }}>
                {task.description.length > 100
                  ? task.description.slice(0, 100) + "..."
                  : task.description}
              </p>

              {task.status === "needs_info" && (
                <p
                  style={{
                    margin: 0,
                    fontSize: 12,
                    color: "#8b5cf6",
                    fontWeight: 500,
                  }}
                >
                  Click to answer questions
                </p>
              )}

              {task.pr_url && (
                <a
                  href={task.pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 12, color: "#3b82f6" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  View Pull Request →
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

### Component: `QuestionDialog`

Allows users to answer clarifying questions from the AI agent.

```tsx
// src/QuestionDialog.tsx
import React, { useState } from "react";
import { useAutoshipContext } from "./AutoshipProvider";

interface Question {
  id: string;
  question: string;
  answer: string | null;
  asked_at: string;
}

interface Task {
  id: string;
  title: string;
  questions: Question[] | null;
}

interface QuestionDialogProps {
  task: Task;
  onBack: () => void;
  onAnswered: () => void;
}

export function QuestionDialog({
  task,
  onBack,
  onAnswered,
}: QuestionDialogProps) {
  const { supabase } = useAutoshipContext();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const unansweredQuestions = (task.questions || []).filter((q) => !q.answer);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      // Update questions with answers
      const updatedQuestions = (task.questions || []).map((q) => ({
        ...q,
        answer: answers[q.id] || q.answer,
        answered_at: answers[q.id] ? new Date().toISOString() : null,
      }));

      // Check if all questions are now answered
      const allAnswered = updatedQuestions.every((q) => q.answer);

      const { error } = await supabase
        .from("agent_todos")
        .update({
          questions: updatedQuestions,
          status: allAnswered ? "pending" : "needs_info", // Move back to pending if all answered
        })
        .eq("id", task.id);

      if (error) throw error;

      onAnswered();
      onBack();
    } catch (err) {
      console.error("Failed to submit answers:", err);
      alert("Failed to submit. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <button type="button" onClick={onBack} style={{ marginRight: 12 }}>
          ←
        </button>
        <h2 style={{ margin: 0 }}>Questions for: {task.title}</h2>
      </div>

      <p style={{ color: "#666", marginBottom: 16 }}>
        The AI needs some clarification before proceeding. Please answer the
        questions below.
      </p>

      {unansweredQuestions.length === 0 ? (
        <p>All questions have been answered!</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {unansweredQuestions.map((q, index) => (
            <div key={q.id}>
              <label
                style={{ display: "block", marginBottom: 4, fontWeight: 500 }}
              >
                {index + 1}. {q.question}
              </label>
              <textarea
                value={answers[q.id] || ""}
                onChange={(e) =>
                  setAnswers({ ...answers, [q.id]: e.target.value })
                }
                placeholder="Your answer..."
                rows={3}
                style={{
                  width: "100%",
                  padding: 8,
                  borderRadius: 6,
                  border: "1px solid #ddd",
                  resize: "vertical",
                }}
              />
            </div>
          ))}

          <button
            onClick={handleSubmit}
            disabled={isSubmitting || Object.keys(answers).length === 0}
            style={{
              padding: 12,
              backgroundColor: "#6366f1",
              color: "white",
              border: "none",
              borderRadius: 6,
              cursor: isSubmitting ? "not-allowed" : "pointer",
            }}
          >
            {isSubmitting ? "Submitting..." : "Submit Answers"}
          </button>
        </div>
      )}
    </div>
  );
}
```

---

### Updated Database Schema for Q&A

Add these columns to the `agent_todos` table:

```sql
-- Add to the migration or run separately
ALTER TABLE agent_todos
  ADD COLUMN IF NOT EXISTS submitted_by TEXT,
  ADD COLUMN IF NOT EXISTS questions JSONB DEFAULT '[]';

-- Index for user's tasks
CREATE INDEX IF NOT EXISTS idx_agent_todos_submitted_by ON agent_todos(submitted_by);

-- RLS policy for users to see their own tasks (using anon key)
CREATE POLICY "Users can view their own tasks"
    ON agent_todos
    FOR SELECT
    USING (submitted_by = auth.uid()::text OR submitted_by IS NULL);

CREATE POLICY "Users can insert tasks"
    ON agent_todos
    FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Users can update their own tasks"
    ON agent_todos
    FOR UPDATE
    USING (submitted_by = auth.uid()::text);
```

The `questions` column stores an array of questions:

```json
[
  {
    "id": "q_123",
    "question": "Should the dark mode toggle persist across sessions?",
    "answer": null,
    "asked_at": "2026-01-18T10:00:00Z",
    "answered_at": null
  }
]
```

---

### MCP Server: Ask Question Tool

Add this tool to the MCP server so Claude can ask clarifying questions:

```typescript
// Add to mcp-servers/todo-db/src/index.ts

server.tool(
  "ask_question",
  "Ask a clarifying question about a todo. The user will be notified and can answer via the UI.",
  {
    todo_id: z.string().describe("The todo ID"),
    question: z.string().describe("The question to ask the user"),
  },
  async ({ todo_id, question }) => {
    // First, get the current todo
    const { data: todo, error: fetchError } = await supabase
      .from("agent_todos")
      .select("questions")
      .eq("id", todo_id)
      .single();

    if (fetchError) {
      return {
        content: [
          { type: "text", text: `Error fetching todo: ${fetchError.message}` },
        ],
        isError: true,
      };
    }

    const questionId = `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newQuestion = {
      id: questionId,
      question,
      answer: null,
      asked_at: new Date().toISOString(),
      answered_at: null,
    };

    const existingQuestions = todo.questions || [];
    const updatedQuestions = [...existingQuestions, newQuestion];

    const { error: updateError } = await supabase
      .from("agent_todos")
      .update({
        questions: updatedQuestions,
        status: "needs_info",
      })
      .eq("id", todo_id);

    if (updateError) {
      return {
        content: [
          {
            type: "text",
            text: `Error asking question: ${updateError.message}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Question asked. Todo marked as 'needs_info'. The user will be prompted to answer: "${question}"`,
        },
      ],
    };
  },
);

server.tool(
  "check_answers",
  "Check if a todo has any unanswered questions or newly provided answers.",
  {
    todo_id: z.string().describe("The todo ID"),
  },
  async ({ todo_id }) => {
    const { data, error } = await supabase
      .from("agent_todos")
      .select("questions, status")
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

    const questions = data.questions || [];
    const unanswered = questions.filter((q: any) => !q.answer);
    const answered = questions.filter((q: any) => q.answer);

    if (questions.length === 0) {
      return {
        content: [
          { type: "text", text: "No questions have been asked for this todo." },
        ],
      };
    }

    let response = `Questions for this todo:\n\n`;

    for (const q of questions) {
      response += `Q: ${q.question}\n`;
      response += q.answer ? `A: ${q.answer}\n\n` : `A: (awaiting answer)\n\n`;
    }

    response += `Status: ${unanswered.length} unanswered, ${answered.length} answered`;

    return {
      content: [{ type: "text", text: response }],
    };
  },
);
```

---

### Hooks for Custom Integrations

```tsx
// src/hooks/useAutoship.ts
import { useAutoshipContext } from "../AutoshipProvider";

export function useAutoship() {
  const { supabase, userId } = useAutoshipContext();

  const submitTask = async (
    title: string,
    description: string,
    priority = 0,
  ) => {
    const id = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const { data, error } = await supabase
      .from("agent_todos")
      .insert({
        id,
        title,
        description,
        priority,
        status: "pending",
        submitted_by: userId || null,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  };

  return { submitTask };
}

// src/hooks/useTasks.ts
import { useEffect, useState } from "react";
import { useAutoshipContext } from "../AutoshipProvider";

export function useTasks() {
  const { supabase, userId } = useAutoshipContext();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTasks();

    // Subscribe to realtime updates
    const subscription = supabase
      .channel("agent_todos_changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_todos",
          filter: userId ? `submitted_by=eq.${userId}` : undefined,
        },
        () => {
          loadTasks();
        },
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [userId]);

  const loadTasks = async () => {
    let query = supabase
      .from("agent_todos")
      .select("*")
      .order("created_at", { ascending: false });

    if (userId) {
      query = query.eq("submitted_by", userId);
    }

    const { data } = await query;
    setTasks(data || []);
    setLoading(false);
  };

  return { tasks, loading, refresh: loadTasks };
}
```

---

### Package Export

```tsx
// src/index.ts
export { AutoshipProvider, useAutoshipContext } from "./AutoshipProvider";
export { AutoshipButton } from "./AutoshipButton";
export { TaskDialog } from "./TaskDialog";
export { TaskList } from "./TaskList";
export { QuestionDialog } from "./QuestionDialog";
export { useAutoship } from "./hooks/useAutoship";
export { useTasks } from "./hooks/useTasks";
```

---

## Next Steps

1. [ ] Apply the database migration
2. [ ] Create the MCP server directory and files
3. [ ] Build and test the MCP server locally
4. [ ] Add the GitHub secrets
5. [ ] Create the GitHub Actions workflow
6. [ ] Add a test todo and trigger the workflow manually
7. [ ] Review the PR created by the agent
8. [ ] Create the `@autoship/react` package
9. [ ] Publish to npm
10. [ ] Create installable GitHub Action for easy adoption
