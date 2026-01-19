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

This document outlines how to set up an autonomous Claude agent that wakes up on a schedule, reads tasks from a Supabase database, works on them, and creates branches with the changes.

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
│                     MCP Server (autoship-mcp)                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Tools:                                                    │  │
│  │  - list_pending_tasks    → SELECT * FROM agent_tasks       │  │
│  │  - claim_task            → UPDATE status = 'in_progress'   │  │
│  │  - complete_task         → UPDATE status = 'complete'      │  │
│  │  - fail_task             → UPDATE status = 'failed'        │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Supabase (PostgreSQL)                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Table: agent_tasks                                        │  │
│  │  - id, title, description, priority, status, branch_name   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Database Schema

Create a new migration for the agent tasks table.

### File: `supabase/migrations/YYYYMMDDHHMMSS_initial_schema.sql`

```sql
-- Agent tasks table for autonomous Claude agent
CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    priority INTEGER DEFAULT 0,  -- Higher = more urgent
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'complete', 'failed', 'blocked', 'needs_info')),
    branch_name TEXT,
    pr_url TEXT,
    notes TEXT,
    error_message TEXT,
    submitted_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- Index for finding pending tasks quickly
CREATE INDEX idx_agent_tasks_status_priority ON agent_tasks(status, priority DESC);

-- Questions table for two-way communication
CREATE TABLE IF NOT EXISTS task_questions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT,
    asked_by TEXT DEFAULT 'agent',
    asked_at TIMESTAMPTZ DEFAULT NOW(),
    answered_at TIMESTAMPTZ
);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_agent_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_tasks_updated_at
    BEFORE UPDATE ON agent_tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_agent_tasks_updated_at();

-- RLS policies (assuming you want admin-only access via service key)
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (used by the MCP server)
CREATE POLICY "Service role has full access to agent_tasks"
    ON agent_tasks
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
└── autoship-mcp/
    ├── package.json
    ├── tsconfig.json
    └── src/
        └── index.ts
```

### Build the MCP Server

```bash
cd mcp-servers/autoship-mcp
npm install
npm run build
```

---

## Phase 3: MCP Configuration

### File: `.mcp.json` (repository root)

```json
{
  "mcpServers": {
    "autoship-mcp": {
      "command": "node",
      "args": ["./mcp-servers/autoship-mcp/dist/index.js"],
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
  work-on-tasks:
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
          cd mcp-servers/autoship-mcp
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

          1. Use the list_pending_tasks tool to see available tasks
          2. If there are pending tasks, pick the highest priority one
          3. Use claim_task to mark it as in progress
          4. Read the task description carefully and implement the requested changes
          5. Create a new git branch with a descriptive name (e.g., 'agent/add-logout-button')
          6. Make the necessary code changes
          7. Commit your changes with a clear commit message
          8. Use complete_task to mark the task as done, including the branch name
          9. If you encounter an error you cannot resolve, use fail_task with a clear explanation

          Important guidelines:
          - Only work on ONE task per run
          - Make minimal, focused changes
          - Write clean, well-tested code
          - If a task is unclear, use ask_question to get clarification

          Start by listing the pending tasks."

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

              See the agent_tasks table for task details." \
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

**Important**: Use the service role key, not the anon key. The service role key bypasses RLS and is required for the agent to access `agent_tasks`.

---

## Phase 6: Testing Locally

### 1. Test the MCP server standalone

```bash
# Set environment variables
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_KEY="your-service-key"

# Run the server (it communicates via stdio, so this will just hang waiting for input)
node mcp-servers/autoship-mcp/dist/index.js
```

### 2. Test with Claude Code locally

```bash
# Add a test task via Supabase dashboard or SQL:
# INSERT INTO agent_tasks (id, title, description, priority)
# VALUES ('test-001', 'Add hello world', 'Add a console.log("Hello World") to src/main.tsx', 5);

# Run Claude with the MCP server
claude "Use the autoship-mcp tools to list pending tasks and tell me what you see"
```

### 3. Full local test

```bash
claude --print "List pending tasks from the database using the autoship-mcp tools. If there are any, claim the highest priority one and implement it."
```

---

## Usage: Adding Tasks

### Via Supabase Dashboard

Go to Table Editor → agent_tasks → Insert row

### Via SQL

```sql
INSERT INTO agent_tasks (id, title, description, priority) VALUES
  ('task-001', 'Add dark mode toggle', 'Add a dark mode toggle to the settings page. Store preference in localStorage.', 5),
  ('task-002', 'Fix budget rounding', 'Budget amounts sometimes show too many decimal places. Round to 2 places.', 3);
```

### Via API (e.g., from another app)

```typescript
const { data, error } = await supabase.from("agent_tasks").insert({
  id: `task_${Date.now()}`,
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
FROM agent_tasks
ORDER BY updated_at DESC
LIMIT 10;

-- Failed tasks that need attention
SELECT id, title, error_message, created_at
FROM agent_tasks
WHERE status = 'failed';

-- In-progress tasks (might be stuck)
SELECT id, title, started_at
FROM agent_tasks
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
- A typical task might cost $0.10-$1.00 depending on complexity
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
│   ├── TaskDetailDialog.tsx
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
      .from("agent_tasks")
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
      .channel("agent_tasks_changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_tasks",
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
      .from("agent_tasks")
      .select(
        `
        *,
        task_questions (
          id,
          question,
          answer,
          asked_at,
          answered_at
        )
      `,
      )
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
export { TaskDetailDialog } from "./TaskDetailDialog";
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
6. [ ] Add a test task and trigger the workflow manually
7. [ ] Review the PR created by the agent
8. [ ] Create the `@autoship/react` package
9. [ ] Publish to npm
10. [ ] Create installable GitHub Action for easy adoption
