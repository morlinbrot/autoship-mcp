import React, { useState } from "react";
import { useAutoshipContext } from "./AutoshipProvider";
import type { Task } from "./TaskList";

export interface TaskDetailDialogProps {
  task: Task;
  onBack: () => void;
  onUpdated: () => void;
}

export function TaskDetailDialog({
  task,
  onBack,
  onUpdated,
}: TaskDetailDialogProps): React.ReactElement {
  const { supabase } = useAutoshipContext();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const questions = task.task_questions || [];
  const unansweredQuestions = questions.filter((q) => !q.answer);
  const answeredQuestions = questions.filter((q) => q.answer);

  const statusColors: Record<string, string> = {
    pending: "#f59e0b",
    in_progress: "#3b82f6",
    complete: "#10b981",
    failed: "#ef4444",
    blocked: "#f59e0b",
    needs_info: "#8b5cf6",
  };

  const statusLabels: Record<string, string> = {
    pending: "Pending",
    in_progress: "In Progress",
    complete: "Complete",
    failed: "Failed",
    blocked: "Blocked",
    needs_info: "Needs Info",
  };

  const handleSubmitAnswers = async () => {
    if (Object.keys(answers).length === 0 || !supabase) return;

    setIsSubmitting(true);
    try {
      // Update each question in task_questions table
      for (const [questionId, answer] of Object.entries(answers)) {
        const { error } = await supabase
          .from("task_questions")
          .update({
            answer: answer,
            answered_at: new Date().toISOString(),
          })
          .eq("id", questionId);

        if (error) throw error;
      }

      // Check if all questions are now answered
      const remainingUnanswered = unansweredQuestions.filter(
        (q) => !answers[q.id]
      );
      const allAnswered = remainingUnanswered.length === 0;

      // Update task status if all questions answered
      if (allAnswered && (task.status === "needs_info" || task.status === "blocked")) {
        const { error: statusError } = await supabase
          .from("agent_tasks")
          .update({ status: "pending" })
          .eq("id", task.id);

        if (statusError) throw statusError;
      }

      onUpdated();
      onBack();
    } catch (err) {
      console.error("Failed to submit answers:", err);
      alert("Failed to submit. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  return (
    <div>
      {/* Header */}
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
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>Task Details</h2>
        <span
          style={{
            backgroundColor: statusColors[task.status] || "#9ca3af",
            color: "white",
            padding: "4px 10px",
            borderRadius: 12,
            fontSize: 12,
          }}
        >
          {statusLabels[task.status] || task.status}
        </span>
      </div>

      {/* Task Info */}
      <div
        style={{
          padding: 12,
          backgroundColor: "#f9fafb",
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        <h3 style={{ margin: "0 0 8px 0", fontSize: 16 }}>{task.title}</h3>
        <p
          style={{
            margin: 0,
            fontSize: 14,
            color: "#4b5563",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
          }}
        >
          {task.description}
        </p>
        <p
          style={{
            margin: "12px 0 0 0",
            fontSize: 12,
            color: "#9ca3af",
          }}
        >
          Created: {formatDate(task.created_at)}
        </p>
        {task.pr_url && (
          <a
            href={task.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-block",
              marginTop: 8,
              fontSize: 13,
              color: "#10b981",
            }}
          >
            View Pull Request
          </a>
        )}
      </div>

      {/* Questions Section */}
      {questions.length > 0 && (
        <div>
          <h3 style={{ margin: "0 0 12px 0", fontSize: 15, color: "#374151" }}>
            Agent Feedback & Questions
          </h3>

          {/* Answered Questions */}
          {answeredQuestions.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <p
                style={{
                  margin: "0 0 8px 0",
                  fontSize: 12,
                  color: "#6b7280",
                  textTransform: "uppercase",
                  fontWeight: 600,
                }}
              >
                Previous Q&A
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {answeredQuestions.map((q) => (
                  <div
                    key={q.id}
                    style={{
                      padding: 12,
                      backgroundColor: "#f0fdf4",
                      borderRadius: 8,
                      borderLeft: "3px solid #10b981",
                    }}
                  >
                    <p
                      style={{
                        margin: 0,
                        fontSize: 14,
                        fontWeight: 500,
                        color: "#166534",
                      }}
                    >
                      Q: {q.question}
                    </p>
                    <p
                      style={{
                        margin: "8px 0 0 0",
                        fontSize: 14,
                        color: "#15803d",
                      }}
                    >
                      A: {q.answer}
                    </p>
                    {q.answered_at && (
                      <p
                        style={{
                          margin: "6px 0 0 0",
                          fontSize: 11,
                          color: "#6b7280",
                        }}
                      >
                        Answered: {formatDate(q.answered_at)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Unanswered Questions */}
          {unansweredQuestions.length > 0 && (
            <div>
              <p
                style={{
                  margin: "0 0 8px 0",
                  fontSize: 12,
                  color: "#059669",
                  textTransform: "uppercase",
                  fontWeight: 600,
                }}
              >
                Questions Awaiting Your Response
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {unansweredQuestions.map((q, index) => (
                  <div
                    key={q.id}
                    style={{
                      padding: 12,
                      backgroundColor: "#ecfdf5",
                      borderRadius: 8,
                      borderLeft: "3px solid #10b981",
                    }}
                  >
                    <label
                      style={{
                        display: "block",
                        marginBottom: 8,
                        fontWeight: 500,
                        fontSize: 14,
                        color: "#047857",
                      }}
                    >
                      {index + 1}. {q.question}
                    </label>
                    <textarea
                      value={answers[q.id] || ""}
                      onChange={(e) =>
                        setAnswers({ ...answers, [q.id]: e.target.value })
                      }
                      placeholder="Type your answer here..."
                      rows={3}
                      style={{
                        width: "100%",
                        padding: 10,
                        borderRadius: 6,
                        border: "1px solid #a7f3d0",
                        fontSize: 14,
                        resize: "vertical",
                        boxSizing: "border-box",
                        fontFamily: "inherit",
                      }}
                    />
                  </div>
                ))}

                <button
                  onClick={handleSubmitAnswers}
                  disabled={isSubmitting || Object.keys(answers).length === 0}
                  style={{
                    padding: 12,
                    backgroundColor:
                      isSubmitting || Object.keys(answers).length === 0
                        ? "#a7f3d0"
                        : "#10b981",
                    color: "white",
                    border: "none",
                    borderRadius: 6,
                    cursor:
                      isSubmitting || Object.keys(answers).length === 0
                        ? "not-allowed"
                        : "pointer",
                    fontSize: 16,
                    fontWeight: 500,
                  }}
                >
                  {isSubmitting ? "Submitting..." : "Submit Answers"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* No Questions */}
      {questions.length === 0 && (
        <div
          style={{
            padding: 16,
            backgroundColor: "#f9fafb",
            borderRadius: 8,
            textAlign: "center",
          }}
        >
          <p style={{ margin: 0, color: "#6b7280", fontSize: 14 }}>
            No questions or feedback from the agent yet.
          </p>
        </div>
      )}
    </div>
  );
}
