# Autoship MCP

A drop-in autonomous coding agent that reads tasks from a Supabase database and implements them via Claude Code.

## How It Works

1. You add tasks to a Supabase table (via dashboard, API, or a UI you build)
2. A GitHub Action wakes up periodically and runs Claude Code
3. Claude picks up the highest priority task, implements it, and creates a PR
4. If Claude needs clarification, it asks a question and blocks the task until you answer
5. You review the PR and merge

## Quick Start for Your Project

### 1. Copy the Required Files

Copy these files/folders into your project:

```
mcp-servers/autoship-mcp/  # The MCP server
.mcp.json                  # MCP configuration
.github/workflows/claude-agent.yml  # GitHub Actions workflow
```

### 2. Set Up Supabase

Create a new Supabase project (or use an existing one) and run the migration:

```sql
-- Copy contents of supabase/migrations/20250118000000_initial_schema.sql
-- and run it in the Supabase SQL Editor
```

Or if you have the Supabase CLI configured:

```bash
supabase db push
```

### 3. Add GitHub Secrets

Go to your repository's Settings > Secrets and variables > Actions, and add:

| Secret                 | Description                                                 |
| ---------------------- | ----------------------------------------------------------- |
| `ANTHROPIC_API_KEY`    | Your Anthropic API key                                      |
| `SUPABASE_URL`         | Your Supabase project URL (e.g., `https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (not the anon key)                |

### 4. Install MCP Server Dependencies

Add this to your project's root `package.json` scripts (or create one):

```json
{
  "scripts": {
    "build:mcp": "cd mcp-servers/autoship-mcp && npm install && npm run build"
  }
}
```

Then run:

```bash
npm run build:mcp
```

### 5. Test Locally

```bash
# Set environment variables
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_KEY="your-service-key"

# Test the MCP tools
claude "Use the autoship-mcp tools to list pending tasks"
```

## Adding Tasks

### Via Supabase Dashboard

Go to Table Editor > agent_tasks > Insert row

### Via SQL

```sql
INSERT INTO agent_tasks (id, title, description, priority) VALUES
  ('task-001', 'Add dark mode toggle', 'Add a dark mode toggle to the settings page. Store preference in localStorage.', 5),
  ('task-002', 'Fix button alignment', 'The submit button on the contact form is misaligned on mobile.', 3);
```

### Via API (from your app)

```typescript
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

await supabase.from("agent_tasks").insert({
  id: `task_${Date.now()}`,
  title: "Implement feature X",
  description: "Detailed description of what needs to be done...",
  priority: 5,
});
```

## Using Categories

Tag tasks with categories for organization:

```sql
-- Create categories
INSERT INTO task_categories (id, name, description, color) VALUES
  ('cat-bug', 'bug', 'Bug fixes', '#FF0000'),
  ('cat-feature', 'feature', 'New features', '#00FF00'),
  ('cat-refactor', 'refactor', 'Code improvements', '#0000FF');

-- Assign category to a task
INSERT INTO task_category_assignments (task_id, category_id) VALUES
  ('task-001', 'cat-feature');
```

## Two-Way Communication

When Claude needs clarification, it will ask a question and mark the task as needing info:

```sql
-- Check for unanswered questions
SELECT q.*, t.title as task_title
FROM task_questions q
JOIN agent_tasks t ON t.id = q.task_id
WHERE q.answer IS NULL;

-- Answer a question
UPDATE task_questions
SET answer = 'Use the existing Button component from src/components/ui',
    answered_at = NOW()
WHERE id = 'q_xxx';

-- The agent will pick up the task on its next run
```

## Customizing the Schedule

Edit `.github/workflows/claude-agent.yml` to change when the agent runs:

```yaml
on:
  schedule:
    # Every 6 hours (default)
    - cron: "0 */6 * * *"

    # Every hour
    # - cron: "0 * * * *"

    # Every day at midnight
    # - cron: "0 0 * * *"
```

## Manual Trigger

You can manually trigger the agent from the GitHub Actions tab, optionally with a custom prompt:

1. Go to Actions > Claude Agent
2. Click "Run workflow"
3. Optionally enter a custom prompt
4. Click "Run workflow"

## Monitoring

### Check Task Status

```sql
-- Recent activity
SELECT id, title, status, started_at, completed_at, branch_name
FROM agent_tasks
ORDER BY updated_at DESC
LIMIT 10;

-- Failed tasks
SELECT id, title, error_message, created_at
FROM agent_tasks
WHERE status = 'failed';

-- Tasks waiting for answers
SELECT t.id, t.title, q.question
FROM agent_tasks t
JOIN task_questions q ON q.task_id = t.id
WHERE t.status = 'needs_info' AND q.answer IS NULL;
```

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

## Security Notes

- Use the **service role key**, not the anon key. The service role bypasses RLS.
- Never commit secrets. Use GitHub Secrets or environment variables.
- The agent creates branches and PRs. Always review before merging.
- Consider adding constraints to the agent prompt to prevent modifying sensitive files.

## Cost Estimation

- Each run uses API tokens based on context length and task complexity
- A typical task costs $0.10-$1.00
- With 4 runs/day, expect ~$10-30/month (varies by task complexity)
- Monitor usage at console.anthropic.com
