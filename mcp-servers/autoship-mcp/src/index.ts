import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// Validate environment
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables"
  );
  process.exit(1);
}

/**
 * The database schema used by Autoship.
 * All tables are created in this schema to avoid conflicts with other schemas.
 */
const AUTOSHIP_SCHEMA = "autoship";

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  {
    db: {
      schema: AUTOSHIP_SCHEMA,
    },
  }
);

// Types
interface AgentTask {
  id: string;
  title: string;
  description: string;
  priority: number;
  status: "pending" | "in_progress" | "complete" | "failed" | "blocked" | "needs_info";
  branch_name: string | null;
  pr_url: string | null;
  notes: string | null;
  error_message: string | null;
  submitted_by: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface TaskCategory {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
}

interface TaskQuestion {
  id: string;
  task_id: string;
  question: string;
  answer: string | null;
  asked_by: "agent" | "user";
  asked_at: string;
  answered_at: string | null;
}

// Create MCP server
const server = new McpServer({
  name: "autoship-mcp",
  version: "1.0.0",
});

// =============================================================================
// Task Tools
// =============================================================================

// Tool: List pending tasks
server.tool(
  "list_pending_tasks",
  "List all pending tasks from the database, ordered by priority (highest first)",
  {},
  async () => {
    const { data, error } = await supabase
      .from("agent_tasks")
      .select("*, task_category_assignments(category_id, task_categories(name))")
      .eq("status", "pending")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true });

    if (error) {
      return {
        content: [
          { type: "text" as const, text: `Error fetching tasks: ${error.message}` },
        ],
        isError: true,
      };
    }

    if (!data || data.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No pending tasks found." }],
      };
    }

    const formatted = data
      .map((task: AgentTask & { task_category_assignments?: Array<{ task_categories: { name: string } }> }, i: number) => {
        const categories = task.task_category_assignments
          ?.map((a) => a.task_categories?.name)
          .filter(Boolean)
          .join(", ");
        const categoryStr = categories ? ` [${categories}]` : "";
        return `${i + 1}. [${task.id}] (priority: ${task.priority})${categoryStr} ${task.title}\n   ${task.description}`;
      })
      .join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${data.length} pending task(s):\n\n${formatted}`,
        },
      ],
    };
  }
);

// Tool: Get task details
server.tool(
  "get_task",
  "Get full details of a specific task by ID, including categories and questions",
  {
    task_id: z.string().describe("The task ID"),
  },
  async ({ task_id }) => {
    const { data: task, error: taskError } = await supabase
      .from("agent_tasks")
      .select("*")
      .eq("id", task_id)
      .single();

    if (taskError) {
      return {
        content: [
          { type: "text" as const, text: `Error fetching task: ${taskError.message}` },
        ],
        isError: true,
      };
    }

    // Get categories
    const { data: categories } = await supabase
      .from("task_category_assignments")
      .select("task_categories(id, name, color)")
      .eq("task_id", task_id);

    // Get questions
    const { data: questions } = await supabase
      .from("task_questions")
      .select("*")
      .eq("task_id", task_id)
      .order("asked_at", { ascending: true });

    const result = {
      ...task,
      categories: categories?.map((c: unknown) => (c as { task_categories: TaskCategory }).task_categories) || [],
      questions: questions || [],
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: Claim a task (mark as in_progress)
server.tool(
  "claim_task",
  "Mark a task as in_progress. Call this before starting work on a task.",
  {
    task_id: z.string().describe("The task ID to claim"),
  },
  async ({ task_id }) => {
    const { data, error } = await supabase
      .from("agent_tasks")
      .update({
        status: "in_progress",
        started_at: new Date().toISOString(),
      })
      .eq("id", task_id)
      .eq("status", "pending")
      .select()
      .single();

    if (error) {
      return {
        content: [
          { type: "text" as const, text: `Error claiming task: ${error.message}` },
        ],
        isError: true,
      };
    }

    if (!data) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Task ${task_id} is not available (may already be claimed or completed).`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text" as const, text: `Successfully claimed task: ${data.title}` },
      ],
    };
  }
);

// Tool: Complete a task
server.tool(
  "complete_task",
  "Mark a task as complete. Call this after successfully implementing the changes.",
  {
    task_id: z.string().describe("The task ID"),
    branch_name: z.string().describe("The git branch containing the changes"),
    notes: z.string().optional().describe("Implementation notes or summary"),
  },
  async ({ task_id, branch_name, notes }) => {
    const { data, error } = await supabase
      .from("agent_tasks")
      .update({
        status: "complete",
        branch_name,
        notes: notes || null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", task_id)
      .select()
      .single();

    if (error) {
      return {
        content: [
          { type: "text" as const, text: `Error completing task: ${error.message}` },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Task "${data.title}" marked as complete. Branch: ${branch_name}`,
        },
      ],
    };
  }
);

// Tool: Fail a task
server.tool(
  "fail_task",
  "Mark a task as failed. Call this if you cannot complete the task.",
  {
    task_id: z.string().describe("The task ID"),
    error_message: z
      .string()
      .describe("Explanation of why the task could not be completed"),
  },
  async ({ task_id, error_message }) => {
    const { data, error } = await supabase
      .from("agent_tasks")
      .update({
        status: "failed",
        error_message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", task_id)
      .select()
      .single();

    if (error) {
      return {
        content: [
          { type: "text" as const, text: `Error updating task: ${error.message}` },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text" as const, text: `Task "${data.title}" marked as failed.` },
      ],
    };
  }
);

// Tool: Add a new task
server.tool(
  "add_task",
  "Add a new task to the queue. Use this for follow-up tasks discovered during implementation.",
  {
    title: z.string().describe("Short title for the task"),
    description: z
      .string()
      .describe("Detailed description of what needs to be done"),
    priority: z
      .number()
      .default(0)
      .describe("Priority level (higher = more urgent)"),
    category_ids: z
      .array(z.string())
      .optional()
      .describe("Optional list of category IDs to assign"),
  },
  async ({ title, description, priority, category_ids }) => {
    const id = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const { data, error } = await supabase
      .from("agent_tasks")
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
          { type: "text" as const, text: `Error adding task: ${error.message}` },
        ],
        isError: true,
      };
    }

    // Assign categories if provided
    if (category_ids && category_ids.length > 0) {
      const assignments = category_ids.map((category_id) => ({
        task_id: id,
        category_id,
      }));
      await supabase.from("task_category_assignments").insert(assignments);
    }

    return {
      content: [{ type: "text" as const, text: `Created new task [${id}]: ${title}` }],
    };
  }
);

// =============================================================================
// Category Tools
// =============================================================================

// Tool: List categories
server.tool(
  "list_categories",
  "List all available categories for tagging tasks",
  {},
  async () => {
    const { data, error } = await supabase
      .from("task_categories")
      .select("*")
      .order("name", { ascending: true });

    if (error) {
      return {
        content: [
          { type: "text" as const, text: `Error fetching categories: ${error.message}` },
        ],
        isError: true,
      };
    }

    if (!data || data.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No categories found." }],
      };
    }

    const formatted = data
      .map((cat: TaskCategory) => `- [${cat.id}] ${cat.name}${cat.description ? `: ${cat.description}` : ""}`)
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Available categories:\n\n${formatted}`,
        },
      ],
    };
  }
);

// Tool: Create category
server.tool(
  "create_category",
  "Create a new category for tagging tasks",
  {
    name: z.string().describe("Category name"),
    description: z.string().optional().describe("Category description"),
    color: z.string().optional().describe("Hex color code (e.g., #FF5733)"),
  },
  async ({ name, description, color }) => {
    const id = `cat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const { data, error } = await supabase
      .from("task_categories")
      .insert({
        id,
        name,
        description: description || null,
        color: color || null,
      })
      .select()
      .single();

    if (error) {
      return {
        content: [
          { type: "text" as const, text: `Error creating category: ${error.message}` },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text" as const, text: `Created category [${id}]: ${name}` }],
    };
  }
);

// Tool: Assign category to task
server.tool(
  "assign_category",
  "Assign a category to a task",
  {
    task_id: z.string().describe("The task ID"),
    category_id: z.string().describe("The category ID"),
  },
  async ({ task_id, category_id }) => {
    const { error } = await supabase
      .from("task_category_assignments")
      .insert({ task_id, category_id });

    if (error) {
      return {
        content: [
          { type: "text" as const, text: `Error assigning category: ${error.message}` },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text" as const, text: `Category assigned to task successfully.` },
      ],
    };
  }
);

// =============================================================================
// Question Tools
// =============================================================================

// Tool: Ask a question about a task
server.tool(
  "ask_question",
  "Ask a clarifying question about a task. The question will be stored for the user to answer, and the task will be marked as needing info.",
  {
    task_id: z.string().describe("The task ID"),
    question: z.string().describe("The clarifying question to ask"),
  },
  async ({ task_id, question }) => {
    const id = `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const { error } = await supabase.from("task_questions").insert({
      id,
      task_id,
      question,
      asked_by: "agent",
    });

    if (error) {
      return {
        content: [
          { type: "text" as const, text: `Error asking question: ${error.message}` },
        ],
        isError: true,
      };
    }

    // Mark the task as needs_info
    await supabase
      .from("agent_tasks")
      .update({ status: "needs_info" })
      .eq("id", task_id);

    return {
      content: [
        {
          type: "text" as const,
          text: `Question recorded [${id}]. Task marked as 'needs_info' until answered.\n\nQuestion: ${question}`,
        },
      ],
    };
  }
);

// Tool: Get unanswered questions
server.tool(
  "get_unanswered_questions",
  "Get all unanswered questions across tasks",
  {},
  async () => {
    const { data, error } = await supabase
      .from("task_questions")
      .select("*, agent_tasks(title)")
      .is("answer", null)
      .order("asked_at", { ascending: true });

    if (error) {
      return {
        content: [
          { type: "text" as const, text: `Error fetching questions: ${error.message}` },
        ],
        isError: true,
      };
    }

    if (!data || data.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No unanswered questions." }],
      };
    }

    const formatted = data
      .map(
        (q: TaskQuestion & { agent_tasks: { title: string } }) =>
          `[${q.id}] Task: ${q.agent_tasks.title}\n   Q: ${q.question}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Unanswered questions:\n\n${formatted}`,
        },
      ],
    };
  }
);

// Tool: Check for answered questions
server.tool(
  "check_answered_questions",
  "Check if any questions for a specific task have been answered",
  {
    task_id: z.string().describe("The task ID"),
  },
  async ({ task_id }) => {
    const { data, error } = await supabase
      .from("task_questions")
      .select("*")
      .eq("task_id", task_id)
      .order("asked_at", { ascending: true });

    if (error) {
      return {
        content: [
          { type: "text" as const, text: `Error fetching questions: ${error.message}` },
        ],
        isError: true,
      };
    }

    if (!data || data.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No questions for this task." }],
      };
    }

    const answered = data.filter((q: TaskQuestion) => q.answer);
    const unanswered = data.filter((q: TaskQuestion) => !q.answer);

    let response = `Questions for this task:\n\n`;

    for (const q of data) {
      response += `Q: ${q.question}\n`;
      response += q.answer ? `A: ${q.answer}\n\n` : `A: (awaiting answer)\n\n`;
    }

    response += `Status: ${answered.length} answered, ${unanswered.length} unanswered`;

    if (unanswered.length === 0 && answered.length > 0) {
      response += "\n\nAll questions have been answered. You can resume the task.";
    }

    return {
      content: [{ type: "text" as const, text: response }],
    };
  }
);

// Tool: Resume a task after questions are answered
server.tool(
  "resume_task",
  "Move a 'needs_info' task back to pending status after questions are answered",
  {
    task_id: z.string().describe("The task ID"),
  },
  async ({ task_id }) => {
    // Check if all questions are answered
    const { data: unanswered } = await supabase
      .from("task_questions")
      .select("id")
      .eq("task_id", task_id)
      .is("answer", null);

    if (unanswered && unanswered.length > 0) {
      return {
        content: [
          { type: "text" as const, text: `Cannot resume task: ${unanswered.length} question(s) still unanswered.` },
        ],
        isError: true,
      };
    }

    const { data, error } = await supabase
      .from("agent_tasks")
      .update({ status: "pending" })
      .eq("id", task_id)
      .eq("status", "needs_info")
      .select()
      .single();

    if (error) {
      return {
        content: [
          { type: "text" as const, text: `Error resuming task: ${error.message}` },
        ],
        isError: true,
      };
    }

    if (!data) {
      return {
        content: [
          { type: "text" as const, text: `Task ${task_id} is not in 'needs_info' status.` },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text" as const, text: `Task "${data.title}" moved back to pending.` },
      ],
    };
  }
);

// =============================================================================
// Start Server
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Autoship MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
