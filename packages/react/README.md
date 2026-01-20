# Autoship

A drop-in autonomous coding agent that records tasks in your app and implements them in a Github Action.

## How It Works

1. Users submit tasks via React components (or directly via Supabase)
2. A GitHub Action wakes up periodically and runs Claude Code
3. Claude picks up the highest priority task, implements it, and creates a PR
4. If Claude needs clarification, it asks a question and blocks the task until you answer
5. You review the PR and merge

## Packages

- **`@autoship/react`** - React components and CLI for task submission
- **`mcp-servers/autoship-mcp`** - MCP server for Claude Code integration

## Quick Start

### 1. Create Supabase Project

Create a new Supabase project (or use an existing one). Get the SUPABASE_URL and your database password.

### 2. Set Up Supabase Database

Run the migrations using the CLI:

```bash
npx @autoship/react init
```

The CLI will prompt you for credentials. You can provide them in two ways:

**Option A: Full DATABASE_URL**

```bash
# Find this in Supabase Dashboard > Project Settings > Database > Connection string > URI
npx @autoship/react init --database-url "postgresql://postgres.xxx:password@aws-0-region.pooler.supabase.com:6543/postgres"
```

**Option B: Supabase URL + Database Password**

```bash
npx @autoship/react init --supabase-url https://xxx.supabase.co --db-password yourpassword
```

**Using environment variables:**

```bash
# Option A
DATABASE_URL="postgresql://..." npx @autoship/react init

# Option B
SUPABASE_URL="https://xxx.supabase.co" DB_PASSWORD="yourpassword" npx @autoship/react init
```

### 3. Expose the Autoship Schema in Supabase

Autoship uses a dedicated `autoship` database schema to avoid conflicts with your existing tables. You need to expose this schema via the Supabase API:

1. Go to your Supabase project dashboard
2. Navigate to **Project Settings** (gear icon) → **API**
3. Scroll down to **Data API Settings**
4. Find **Extra search path** and add `autoship` to the list
5. Save the changes

This allows the Supabase client to access the `autoship` schema via the REST API.

### 4. Add React Components (Optional)

Install the package:

```bash
npm install @autoship/react
```

Add the provider and button to your app:

```tsx
import { AutoshipProvider, AutoshipButton } from "@autoship/react";

function App() {
  return (
    <AutoshipProvider
      supabaseUrl={process.env.SUPABASE_URL}
      supabaseAnonKey={process.env.SUPABASE_ANON_KEY}
      userId="optional-user-id"
    >
      <YourApp />
      <AutoshipButton />
    </AutoshipProvider>
  );
}
```

Available components:

- `AutoshipProvider` - Context provider for Supabase connection
- `AutoshipButton` - Floating button to open task submission dialog
- `TaskDialog` - Modal for submitting new tasks
- `TaskList` - List of submitted tasks with status
- `TaskDetailDialog` - View task details and answer questions
- `QuestionDialog` - Answer clarifying questions from Claude

### 5. Set Up GitHub Action

Copy these files into your project:

```
mcp-servers/autoship-mcp/  # The MCP server
.mcp.json                  # MCP configuration
.github/workflows/claude-agent.yml  # GitHub Actions workflow
```

Add GitHub Secrets (Settings > Secrets and variables > Actions):

| Secret                 | Description                                                 |
| ---------------------- | ----------------------------------------------------------- |
| `ANTHROPIC_API_KEY`    | Your Anthropic API key                                      |
| `SUPABASE_URL`         | Your Supabase project URL (e.g., `https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (not the anon key)                |

### 6. Test Locally (Optional)

Build the MCP server:

```bash
cd mcp-servers/autoship-mcp && npm install && npm run build
```

```bash
# Set environment variables
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_KEY="your-service-key"

# Test the MCP tools
claude "Use the autoship-mcp tools to list pending tasks"
```

## Manual Trigger

You can manually trigger the agent from the GitHub Actions tab, optionally with a custom prompt:

1. Go to Actions > Claude Agent
2. Click "Run workflow"
3. Optionally enter a custom prompt
4. Click "Run workflow"

## Monitoring

### GitHub Actions Logs

Check the Actions tab in your repository to see Claude's output for each run.

## Available MCP Tools

| Tool                       | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `list_pending_tasks`       | List all pending tasks by priority                   |
| `get_task`                 | Get full details including categories and questions  |
| `claim_task`               | Mark a task as in_progress                           |
| `complete_task`            | Mark as complete with branch name                    |
| `fail_task`                | Mark as failed with error message                    |
| `add_task`                 | Create new tasks                                     |
| `list_categories`          | List all categories                                  |
| `create_category`          | Create a new category                                |
| `assign_category`          | Tag a task with a category                           |
| `ask_question`             | Ask a clarifying question (marks task as needs_info) |
| `get_unanswered_questions` | List all unanswered questions                        |
| `check_answered_questions` | Check answers for a specific task                    |
| `resume_task`              | Move a needs_info task back to pending               |

## Cost Estimation

- Each run uses API tokens based on context length and task complexity
- A typical task costs $0.10-$1.00
- With 4 runs/day, expect ~$10-30/month (varies by task complexity)
- Monitor usage at console.anthropic.com
