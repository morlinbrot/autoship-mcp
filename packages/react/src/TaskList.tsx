import React, { useEffect, useState } from "react";
import { useAutoshipContext } from "./AutoshipProvider";
import { QuestionDialog } from "./QuestionDialog";

export interface Question {
  id: string;
  question: string;
  answer: string | null;
  asked_at: string;
  answered_at: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "complete" | "failed" | "needs_info";
  branch_name: string | null;
  pr_url: string | null;
  questions: Question[] | null;
  created_at: string;
}

export interface TaskListProps {
  onBack: () => void;
}

export function TaskList({ onBack }: TaskListProps): React.ReactElement {
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

      if (userId) {
        query = query.eq("submitted_by", userId);
      }

      const { data, error } = await query;
      if (error) throw error;
      setTasks((data as Task[]) || []);
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
        <button
          type="button"
          onClick={onBack}
          style={{
            marginRight: 12,
            background: "none",
            border: "none",
            fontSize: 20,
            cursor: "pointer",
            padding: 4,
          }}
        >
          ←
        </button>
        <h2 style={{ margin: 0 }}>My Requests</h2>
      </div>

      {loading ? (
        <p style={{ color: "#666" }}>Loading...</p>
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
                backgroundColor:
                  task.status === "needs_info" ? "#faf5ff" : "white",
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
                  gap: 12,
                }}
              >
                <h4 style={{ margin: 0, fontSize: 16 }}>{task.title}</h4>
                <span
                  style={{
                    backgroundColor: statusColors[task.status] || "#9ca3af",
                    color: "white",
                    padding: "2px 8px",
                    borderRadius: 12,
                    fontSize: 12,
                    flexShrink: 0,
                  }}
                >
                  {statusLabels[task.status] || task.status}
                </span>
              </div>

              <p
                style={{
                  margin: "8px 0",
                  fontSize: 14,
                  color: "#666",
                  lineHeight: 1.4,
                }}
              >
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
