-- Autoship MCP Initial Schema
-- Tables: agent_todos, todo_categories, todo_category_assignments, todo_questions

-- =============================================================================
-- Categories table (for tagging tasks)
-- =============================================================================
CREATE TABLE IF NOT EXISTS todo_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    color TEXT,  -- Hex color for UI display (e.g., '#FF5733')
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Agent todos table (main tasks table)
-- =============================================================================
CREATE TABLE IF NOT EXISTS agent_todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    priority INTEGER DEFAULT 0,  -- Higher = more urgent
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'complete', 'failed', 'blocked', 'needs_info')),
    branch_name TEXT,
    pr_url TEXT,
    notes TEXT,
    error_message TEXT,
    submitted_by TEXT,  -- User ID who submitted the task (for React components)
    questions JSONB DEFAULT '[]',  -- Inline Q&A for React components
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- Index for finding pending todos quickly
CREATE INDEX idx_agent_todos_status_priority ON agent_todos(status, priority DESC);

-- Index for user's tasks (React components)
CREATE INDEX idx_agent_todos_submitted_by ON agent_todos(submitted_by);

-- =============================================================================
-- Category assignments (many-to-many relationship)
-- =============================================================================
CREATE TABLE IF NOT EXISTS todo_category_assignments (
    todo_id TEXT NOT NULL REFERENCES agent_todos(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES todo_categories(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (todo_id, category_id)
);

CREATE INDEX idx_todo_category_assignments_category ON todo_category_assignments(category_id);

-- =============================================================================
-- Questions and answers for tasks
-- =============================================================================
CREATE TABLE IF NOT EXISTS todo_questions (
    id TEXT PRIMARY KEY,
    todo_id TEXT NOT NULL REFERENCES agent_todos(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT,  -- NULL until answered
    asked_by TEXT DEFAULT 'agent',  -- 'agent' or 'user'
    asked_at TIMESTAMPTZ DEFAULT NOW(),
    answered_at TIMESTAMPTZ
);

CREATE INDEX idx_todo_questions_todo ON todo_questions(todo_id);
CREATE INDEX idx_todo_questions_unanswered ON todo_questions(todo_id) WHERE answer IS NULL;

-- =============================================================================
-- Trigger to update updated_at on agent_todos
-- =============================================================================
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

-- =============================================================================
-- Row Level Security
-- =============================================================================

-- Enable RLS on all tables
ALTER TABLE agent_todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE todo_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE todo_category_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE todo_questions ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by the MCP server)
CREATE POLICY "Service role has full access to agent_todos"
    ON agent_todos FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to todo_categories"
    ON todo_categories FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to todo_category_assignments"
    ON todo_category_assignments FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to todo_questions"
    ON todo_questions FOR ALL USING (true) WITH CHECK (true);

-- =============================================================================
-- Policies for React components (using anon key)
-- =============================================================================

-- Users can view their own tasks or tasks without a submitter
CREATE POLICY "Users can view their own tasks"
    ON agent_todos FOR SELECT
    USING (submitted_by IS NULL OR submitted_by = coalesce(auth.uid()::text, submitted_by));

-- Anyone can insert tasks
CREATE POLICY "Anyone can insert tasks"
    ON agent_todos FOR INSERT
    WITH CHECK (true);

-- Users can update their own tasks (for answering questions)
CREATE POLICY "Users can update their own tasks"
    ON agent_todos FOR UPDATE
    USING (submitted_by IS NULL OR submitted_by = coalesce(auth.uid()::text, submitted_by));
