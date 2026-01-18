import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
// Validate environment
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables");
    process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
// Create MCP server
const server = new McpServer({
    name: "todo-db",
    version: "1.0.0",
});
// =============================================================================
// Todo Tools
// =============================================================================
// Tool: List pending todos
server.tool("list_pending_todos", "List all pending todos from the database, ordered by priority (highest first)", {}, async () => {
    const { data, error } = await supabase
        .from("agent_todos")
        .select("*, todo_category_assignments(category_id, todo_categories(name))")
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
    const formatted = data
        .map((todo, i) => {
        const categories = todo.todo_category_assignments
            ?.map((a) => a.todo_categories?.name)
            .filter(Boolean)
            .join(", ");
        const categoryStr = categories ? ` [${categories}]` : "";
        return `${i + 1}. [${todo.id}] (priority: ${todo.priority})${categoryStr} ${todo.title}\n   ${todo.description}`;
    })
        .join("\n\n");
    return {
        content: [
            {
                type: "text",
                text: `Found ${data.length} pending todo(s):\n\n${formatted}`,
            },
        ],
    };
});
// Tool: Get todo details
server.tool("get_todo", "Get full details of a specific todo by ID, including categories and questions", {
    todo_id: z.string().describe("The todo ID"),
}, async ({ todo_id }) => {
    const { data: todo, error: todoError } = await supabase
        .from("agent_todos")
        .select("*")
        .eq("id", todo_id)
        .single();
    if (todoError) {
        return {
            content: [
                { type: "text", text: `Error fetching todo: ${todoError.message}` },
            ],
            isError: true,
        };
    }
    // Get categories
    const { data: categories } = await supabase
        .from("todo_category_assignments")
        .select("todo_categories(id, name, color)")
        .eq("todo_id", todo_id);
    // Get questions
    const { data: questions } = await supabase
        .from("todo_questions")
        .select("*")
        .eq("todo_id", todo_id)
        .order("asked_at", { ascending: true });
    const result = {
        ...todo,
        categories: categories?.map((c) => c.todo_categories) || [],
        questions: questions || [],
    };
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
});
// Tool: Claim a todo (mark as in_progress)
server.tool("claim_todo", "Mark a todo as in_progress. Call this before starting work on a todo.", {
    todo_id: z.string().describe("The todo ID to claim"),
}, async ({ todo_id }) => {
    const { data, error } = await supabase
        .from("agent_todos")
        .update({
        status: "in_progress",
        started_at: new Date().toISOString(),
    })
        .eq("id", todo_id)
        .eq("status", "pending")
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
});
// Tool: Complete a todo
server.tool("complete_todo", "Mark a todo as complete. Call this after successfully implementing the changes.", {
    todo_id: z.string().describe("The todo ID"),
    branch_name: z.string().describe("The git branch containing the changes"),
    notes: z.string().optional().describe("Implementation notes or summary"),
}, async ({ todo_id, branch_name, notes }) => {
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
});
// Tool: Fail a todo
server.tool("fail_todo", "Mark a todo as failed. Call this if you cannot complete the task.", {
    todo_id: z.string().describe("The todo ID"),
    error_message: z
        .string()
        .describe("Explanation of why the todo could not be completed"),
}, async ({ todo_id, error_message }) => {
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
});
// Tool: Add a new todo
server.tool("add_todo", "Add a new todo to the queue. Use this for follow-up tasks discovered during implementation.", {
    title: z.string().describe("Short title for the todo"),
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
}, async ({ title, description, priority, category_ids }) => {
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
    // Assign categories if provided
    if (category_ids && category_ids.length > 0) {
        const assignments = category_ids.map((category_id) => ({
            todo_id: id,
            category_id,
        }));
        await supabase.from("todo_category_assignments").insert(assignments);
    }
    return {
        content: [{ type: "text", text: `Created new todo [${id}]: ${title}` }],
    };
});
// =============================================================================
// Category Tools
// =============================================================================
// Tool: List categories
server.tool("list_categories", "List all available categories for tagging todos", {}, async () => {
    const { data, error } = await supabase
        .from("todo_categories")
        .select("*")
        .order("name", { ascending: true });
    if (error) {
        return {
            content: [
                { type: "text", text: `Error fetching categories: ${error.message}` },
            ],
            isError: true,
        };
    }
    if (!data || data.length === 0) {
        return {
            content: [{ type: "text", text: "No categories found." }],
        };
    }
    const formatted = data
        .map((cat) => `- [${cat.id}] ${cat.name}${cat.description ? `: ${cat.description}` : ""}`)
        .join("\n");
    return {
        content: [
            {
                type: "text",
                text: `Available categories:\n\n${formatted}`,
            },
        ],
    };
});
// Tool: Create category
server.tool("create_category", "Create a new category for tagging todos", {
    name: z.string().describe("Category name"),
    description: z.string().optional().describe("Category description"),
    color: z.string().optional().describe("Hex color code (e.g., #FF5733)"),
}, async ({ name, description, color }) => {
    const id = `cat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const { data, error } = await supabase
        .from("todo_categories")
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
                { type: "text", text: `Error creating category: ${error.message}` },
            ],
            isError: true,
        };
    }
    return {
        content: [{ type: "text", text: `Created category [${id}]: ${name}` }],
    };
});
// Tool: Assign category to todo
server.tool("assign_category", "Assign a category to a todo", {
    todo_id: z.string().describe("The todo ID"),
    category_id: z.string().describe("The category ID"),
}, async ({ todo_id, category_id }) => {
    const { error } = await supabase
        .from("todo_category_assignments")
        .insert({ todo_id, category_id });
    if (error) {
        return {
            content: [
                { type: "text", text: `Error assigning category: ${error.message}` },
            ],
            isError: true,
        };
    }
    return {
        content: [
            { type: "text", text: `Category assigned to todo successfully.` },
        ],
    };
});
// =============================================================================
// Question Tools
// =============================================================================
// Tool: Ask a question about a todo
server.tool("ask_question", "Ask a clarifying question about a todo. The question will be stored for the user to answer.", {
    todo_id: z.string().describe("The todo ID"),
    question: z.string().describe("The clarifying question to ask"),
}, async ({ todo_id, question }) => {
    const id = `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const { error } = await supabase.from("todo_questions").insert({
        id,
        todo_id,
        question,
        asked_by: "agent",
    });
    if (error) {
        return {
            content: [
                { type: "text", text: `Error asking question: ${error.message}` },
            ],
            isError: true,
        };
    }
    // Mark the todo as blocked
    await supabase
        .from("agent_todos")
        .update({ status: "blocked" })
        .eq("id", todo_id);
    return {
        content: [
            {
                type: "text",
                text: `Question recorded [${id}]. Todo marked as blocked until answered.\n\nQuestion: ${question}`,
            },
        ],
    };
});
// Tool: Get unanswered questions
server.tool("get_unanswered_questions", "Get all unanswered questions across todos", {}, async () => {
    const { data, error } = await supabase
        .from("todo_questions")
        .select("*, agent_todos(title)")
        .is("answer", null)
        .order("asked_at", { ascending: true });
    if (error) {
        return {
            content: [
                { type: "text", text: `Error fetching questions: ${error.message}` },
            ],
            isError: true,
        };
    }
    if (!data || data.length === 0) {
        return {
            content: [{ type: "text", text: "No unanswered questions." }],
        };
    }
    const formatted = data
        .map((q) => `[${q.id}] Todo: ${q.agent_todos.title}\n   Q: ${q.question}`)
        .join("\n\n");
    return {
        content: [
            {
                type: "text",
                text: `Unanswered questions:\n\n${formatted}`,
            },
        ],
    };
});
// Tool: Check for answered questions
server.tool("check_answered_questions", "Check if any questions for a specific todo have been answered", {
    todo_id: z.string().describe("The todo ID"),
}, async ({ todo_id }) => {
    const { data, error } = await supabase
        .from("todo_questions")
        .select("*")
        .eq("todo_id", todo_id)
        .not("answer", "is", null)
        .order("answered_at", { ascending: true });
    if (error) {
        return {
            content: [
                { type: "text", text: `Error fetching questions: ${error.message}` },
            ],
            isError: true,
        };
    }
    if (!data || data.length === 0) {
        return {
            content: [{ type: "text", text: "No answered questions for this todo." }],
        };
    }
    const formatted = data
        .map((q) => `Q: ${q.question}\nA: ${q.answer}`)
        .join("\n\n---\n\n");
    // Check if all questions are answered
    const { data: unanswered } = await supabase
        .from("todo_questions")
        .select("id")
        .eq("todo_id", todo_id)
        .is("answer", null);
    const allAnswered = !unanswered || unanswered.length === 0;
    return {
        content: [
            {
                type: "text",
                text: `Answered questions:\n\n${formatted}\n\n${allAnswered ? "All questions have been answered. Todo can be unblocked." : "Some questions are still pending."}`,
            },
        ],
    };
});
// Tool: Unblock a todo
server.tool("unblock_todo", "Move a blocked todo back to pending status (after questions are answered)", {
    todo_id: z.string().describe("The todo ID"),
}, async ({ todo_id }) => {
    const { data, error } = await supabase
        .from("agent_todos")
        .update({ status: "pending" })
        .eq("id", todo_id)
        .eq("status", "blocked")
        .select()
        .single();
    if (error) {
        return {
            content: [
                { type: "text", text: `Error unblocking todo: ${error.message}` },
            ],
            isError: true,
        };
    }
    if (!data) {
        return {
            content: [
                { type: "text", text: `Todo ${todo_id} is not blocked.` },
            ],
            isError: true,
        };
    }
    return {
        content: [
            { type: "text", text: `Todo "${data.title}" moved back to pending.` },
        ],
    };
});
// =============================================================================
// Inline Question Tools (for React components using JSONB questions column)
// =============================================================================
// Tool: Ask inline question (stores in JSONB column, for React UI)
server.tool("ask_inline_question", "Ask a clarifying question that will be shown in the React UI. The user will answer via the app.", {
    todo_id: z.string().describe("The todo ID"),
    question: z.string().describe("The question to ask the user"),
}, async ({ todo_id, question }) => {
    // Get the current todo
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
                { type: "text", text: `Error asking question: ${updateError.message}` },
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
});
// Tool: Check inline answers
server.tool("check_inline_answers", "Check if a todo has any unanswered inline questions or newly provided answers.", {
    todo_id: z.string().describe("The todo ID"),
}, async ({ todo_id }) => {
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
    if (questions.length === 0) {
        return {
            content: [
                { type: "text", text: "No inline questions have been asked for this todo." },
            ],
        };
    }
    const unanswered = questions.filter((q) => !q.answer);
    const answered = questions.filter((q) => q.answer);
    let response = `Inline questions for this todo:\n\n`;
    for (const q of questions) {
        response += `Q: ${q.question}\n`;
        response += q.answer ? `A: ${q.answer}\n\n` : `A: (awaiting answer)\n\n`;
    }
    response += `Status: ${unanswered.length} unanswered, ${answered.length} answered`;
    if (unanswered.length === 0 && answered.length > 0) {
        response += "\n\nAll questions have been answered! You can proceed with the task.";
    }
    return {
        content: [{ type: "text", text: response }],
    };
});
// Tool: Resume todo after inline answers
server.tool("resume_todo", "Move a 'needs_info' todo back to pending after inline questions are answered", {
    todo_id: z.string().describe("The todo ID"),
}, async ({ todo_id }) => {
    const { data, error } = await supabase
        .from("agent_todos")
        .update({ status: "pending" })
        .eq("id", todo_id)
        .eq("status", "needs_info")
        .select()
        .single();
    if (error) {
        return {
            content: [
                { type: "text", text: `Error resuming todo: ${error.message}` },
            ],
            isError: true,
        };
    }
    if (!data) {
        return {
            content: [
                { type: "text", text: `Todo ${todo_id} is not in 'needs_info' status.` },
            ],
            isError: true,
        };
    }
    return {
        content: [
            { type: "text", text: `Todo "${data.title}" moved back to pending.` },
        ],
    };
});
// =============================================================================
// Start Server
// =============================================================================
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Todo DB MCP server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
