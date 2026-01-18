import React, { useState } from "react";
import { useAutoshipContext } from "./AutoshipProvider";
import type { Task } from "./TaskList";

export interface QuestionDialogProps {
  task: Task;
  onBack: () => void;
  onAnswered: () => void;
}

export function QuestionDialog({
  task,
  onBack,
  onAnswered,
}: QuestionDialogProps): React.ReactElement {
  const { supabase } = useAutoshipContext();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const unansweredQuestions = (task.questions || []).filter((q) => !q.answer);

  const handleSubmit = async () => {
    if (Object.keys(answers).length === 0) return;

    setIsSubmitting(true);
    try {
      const updatedQuestions = (task.questions || []).map((q) => ({
        ...q,
        answer: answers[q.id] || q.answer,
        answered_at: answers[q.id] ? new Date().toISOString() : q.answered_at,
      }));

      const allAnswered = updatedQuestions.every((q) => q.answer);

      const { error } = await supabase
        .from("agent_todos")
        .update({
          questions: updatedQuestions,
          status: allAnswered ? "pending" : "needs_info",
        })
        .eq("id", task.id);

      if (error) throw error;

      onAnswered();
      onBack();
    } catch (err) {
      console.error("Failed to submit answers:", err);
      alert("Failed to submit. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

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
        <h2 style={{ margin: 0, fontSize: 18 }}>Questions: {task.title}</h2>
      </div>

      <p style={{ color: "#666", marginBottom: 16, fontSize: 14 }}>
        The AI needs some clarification before proceeding. Please answer the
        questions below.
      </p>

      {unansweredQuestions.length === 0 ? (
        <p style={{ color: "#10b981" }}>All questions have been answered!</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {unansweredQuestions.map((q, index) => (
            <div key={q.id}>
              <label
                style={{
                  display: "block",
                  marginBottom: 6,
                  fontWeight: 500,
                  fontSize: 14,
                }}
              >
                {index + 1}. {q.question}
              </label>
              <textarea
                value={answers[q.id] || ""}
                onChange={(e) =>
                  setAnswers({ ...answers, [q.id]: e.target.value })
                }
                placeholder="Your answer..."
                rows={3}
                style={{
                  width: "100%",
                  padding: 10,
                  borderRadius: 6,
                  border: "1px solid #ddd",
                  fontSize: 14,
                  resize: "vertical",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                }}
              />
            </div>
          ))}

          <button
            onClick={handleSubmit}
            disabled={isSubmitting || Object.keys(answers).length === 0}
            style={{
              padding: 12,
              backgroundColor:
                isSubmitting || Object.keys(answers).length === 0
                  ? "#a5b4fc"
                  : "#6366f1",
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
      )}
    </div>
  );
}
