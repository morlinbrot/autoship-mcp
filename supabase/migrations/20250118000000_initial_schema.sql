-- Autoship MCP Initial Schema
-- Tables: agent_tasks, task_categories, task_category_assignments, task_questions

-- =============================================================================
-- Create autoship schema to isolate from other schemas
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS autoship;

-- Set search_path for this session to use autoship schema
SET search_path TO autoship, public;

-- =============================================================================
-- Expose the autoship schema via PostgREST API
-- Grant usage on the schema to the API roles
-- =============================================================================
GRANT USAGE ON SCHEMA autoship TO anon, authenticated, service_role;

-- Grant table permissions to service_role (full access)
ALTER DEFAULT PRIVILEGES IN SCHEMA autoship GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA autoship GRANT ALL ON SEQUENCES TO service_role;

-- Grant table permissions to anon and authenticated (controlled by RLS)
ALTER DEFAULT PRIVILEGES IN SCHEMA autoship GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA autoship GRANT USAGE ON SEQUENCES TO anon, authenticated;

-- =============================================================================
-- Categories table (for tagging tasks)
-- =============================================================================
CREATE TABLE IF NOT EXISTS autoship.task_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    color TEXT,  -- Hex color for UI display (e.g., '#FF5733')
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Agent tasks table (main tasks table)
-- =============================================================================
CREATE TABLE IF NOT EXISTS autoship.agent_tasks (
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
CREATE INDEX idx_agent_tasks_status_priority ON autoship.agent_tasks(status, priority DESC);

-- Index for user's tasks (React components)
CREATE INDEX idx_agent_tasks_submitted_by ON autoship.agent_tasks(submitted_by);

-- =============================================================================
-- Category assignments (many-to-many relationship)
-- =============================================================================
CREATE TABLE IF NOT EXISTS autoship.task_category_assignments (
    task_id TEXT NOT NULL REFERENCES autoship.agent_tasks(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES autoship.task_categories(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (task_id, category_id)
);

CREATE INDEX idx_task_category_assignments_category ON autoship.task_category_assignments(category_id);

-- =============================================================================
-- Questions and answers for tasks
-- =============================================================================
CREATE TABLE IF NOT EXISTS autoship.task_questions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES autoship.agent_tasks(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT,  -- NULL until answered
    asked_by TEXT DEFAULT 'agent',  -- 'agent' or 'user'
    asked_at TIMESTAMPTZ DEFAULT NOW(),
    answered_at TIMESTAMPTZ
);

CREATE INDEX idx_task_questions_task ON autoship.task_questions(task_id);
CREATE INDEX idx_task_questions_unanswered ON autoship.task_questions(task_id) WHERE answer IS NULL;

-- =============================================================================
-- Trigger to update updated_at on agent_tasks
-- =============================================================================
CREATE OR REPLACE FUNCTION autoship.update_agent_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_tasks_updated_at
    BEFORE UPDATE ON autoship.agent_tasks
    FOR EACH ROW
    EXECUTE FUNCTION autoship.update_agent_tasks_updated_at();

-- =============================================================================
-- Row Level Security
-- =============================================================================

-- Enable RLS on all tables
ALTER TABLE autoship.agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE autoship.task_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE autoship.task_category_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE autoship.task_questions ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by the MCP server)
CREATE POLICY "Service role has full access to agent_tasks"
    ON autoship.agent_tasks FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to task_categories"
    ON autoship.task_categories FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to task_category_assignments"
    ON autoship.task_category_assignments FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to task_questions"
    ON autoship.task_questions FOR ALL USING (true) WITH CHECK (true);

-- =============================================================================
-- Policies for React components (using anon key)
-- =============================================================================

-- Users can view their own tasks or tasks without a submitter
CREATE POLICY "Users can view their own tasks"
    ON autoship.agent_tasks FOR SELECT
    USING (submitted_by IS NULL OR submitted_by = coalesce(auth.uid()::text, submitted_by));

-- Anyone can insert tasks
CREATE POLICY "Anyone can insert tasks"
    ON autoship.agent_tasks FOR INSERT
    WITH CHECK (true);

-- Users can update their own tasks (for answering questions)
CREATE POLICY "Users can update their own tasks"
    ON autoship.agent_tasks FOR UPDATE
    USING (submitted_by IS NULL OR submitted_by = coalesce(auth.uid()::text, submitted_by));

-- Users can view questions for their tasks
CREATE POLICY "Users can view questions for their tasks"
    ON autoship.task_questions FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM autoship.agent_tasks 
        WHERE autoship.agent_tasks.id = autoship.task_questions.task_id 
        AND (autoship.agent_tasks.submitted_by IS NULL OR autoship.agent_tasks.submitted_by = coalesce(auth.uid()::text, autoship.agent_tasks.submitted_by))
    ));

-- Users can update questions (to provide answers)
CREATE POLICY "Users can update questions for their tasks"
    ON autoship.task_questions FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM autoship.agent_tasks 
        WHERE autoship.agent_tasks.id = autoship.task_questions.task_id 
        AND (autoship.agent_tasks.submitted_by IS NULL OR autoship.agent_tasks.submitted_by = coalesce(auth.uid()::text, autoship.agent_tasks.submitted_by))
    ));

-- =============================================================================
-- Grant explicit permissions on tables (since ALTER DEFAULT PRIVILEGES only
-- affects future tables, not tables created in the same transaction)
-- =============================================================================
GRANT ALL ON autoship.agent_tasks TO service_role;
GRANT ALL ON autoship.task_categories TO service_role;
GRANT ALL ON autoship.task_category_assignments TO service_role;
GRANT ALL ON autoship.task_questions TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON autoship.agent_tasks TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON autoship.task_categories TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON autoship.task_category_assignments TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON autoship.task_questions TO anon, authenticated;
