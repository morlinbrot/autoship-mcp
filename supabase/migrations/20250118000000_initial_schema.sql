-- Autoship MCP Initial Schema
-- Tables: agent_tasks, task_categories, task_category_assignments, task_questions

-- =============================================================================
-- Categories table (for tagging tasks)
-- =============================================================================
CREATE TABLE IF NOT EXISTS task_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    color TEXT,  -- Hex color for UI display (e.g., '#FF5733')
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Agent tasks table (main tasks table)
-- =============================================================================
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
    submitted_by TEXT,  -- User ID who submitted the task (for React components)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- Index for finding pending tasks quickly
CREATE INDEX idx_agent_tasks_status_priority ON agent_tasks(status, priority DESC);

-- Index for user's tasks (React components)
CREATE INDEX idx_agent_tasks_submitted_by ON agent_tasks(submitted_by);

-- =============================================================================
-- Category assignments (many-to-many relationship)
-- =============================================================================
CREATE TABLE IF NOT EXISTS task_category_assignments (
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES task_categories(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (task_id, category_id)
);

CREATE INDEX idx_task_category_assignments_category ON task_category_assignments(category_id);

-- =============================================================================
-- Questions and answers for tasks
-- =============================================================================
CREATE TABLE IF NOT EXISTS task_questions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT,  -- NULL until answered
    asked_by TEXT DEFAULT 'agent',  -- 'agent' or 'user'
    asked_at TIMESTAMPTZ DEFAULT NOW(),
    answered_at TIMESTAMPTZ
);

CREATE INDEX idx_task_questions_task ON task_questions(task_id);
CREATE INDEX idx_task_questions_unanswered ON task_questions(task_id) WHERE answer IS NULL;

-- =============================================================================
-- Trigger to update updated_at on agent_tasks
-- =============================================================================
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

-- =============================================================================
-- Row Level Security
-- =============================================================================

-- Enable RLS on all tables
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_category_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_questions ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by the MCP server)
CREATE POLICY "Service role has full access to agent_tasks"
    ON agent_tasks FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to task_categories"
    ON task_categories FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to task_category_assignments"
    ON task_category_assignments FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to task_questions"
    ON task_questions FOR ALL USING (true) WITH CHECK (true);

-- =============================================================================
-- Policies for React components (using anon key)
-- =============================================================================

-- Users can view their own tasks or tasks without a submitter
CREATE POLICY "Users can view their own tasks"
    ON agent_tasks FOR SELECT
    USING (submitted_by IS NULL OR submitted_by = coalesce(auth.uid()::text, submitted_by));

-- Anyone can insert tasks
CREATE POLICY "Anyone can insert tasks"
    ON agent_tasks FOR INSERT
    WITH CHECK (true);

-- Users can update their own tasks (for answering questions)
CREATE POLICY "Users can update their own tasks"
    ON agent_tasks FOR UPDATE
    USING (submitted_by IS NULL OR submitted_by = coalesce(auth.uid()::text, submitted_by));

-- Users can view questions for their tasks
CREATE POLICY "Users can view questions for their tasks"
    ON task_questions FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM agent_tasks 
        WHERE agent_tasks.id = task_questions.task_id 
        AND (agent_tasks.submitted_by IS NULL OR agent_tasks.submitted_by = coalesce(auth.uid()::text, agent_tasks.submitted_by))
    ));

-- Users can update questions (to provide answers)
CREATE POLICY "Users can update questions for their tasks"
    ON task_questions FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM agent_tasks 
        WHERE agent_tasks.id = task_questions.task_id 
        AND (agent_tasks.submitted_by IS NULL OR agent_tasks.submitted_by = coalesce(auth.uid()::text, agent_tasks.submitted_by))
    ));
