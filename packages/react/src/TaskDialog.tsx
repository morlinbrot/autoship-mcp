import React, { useState } from "react";
import { useAutoshipContext } from "./AutoshipProvider";

export interface TaskDialogProps {
  onClose: () => void;
  onBack: () => void;
}

export function TaskDialog({
  onClose,
  onBack,
}: TaskDialogProps): React.ReactElement {
  const { supabase, userId } = useAutoshipContext();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;

    setIsSubmitting(true);
    try {
      const id = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const { error } = await supabase.from("agent_tasks").insert({
        id,
        title: title.trim(),
        description: description.trim(),
        priority: 0,
        status: "pending",
        submitted_by: userId || null,
      });

      if (error) throw error;

      setSubmitted(true);
      setTimeout(() => onClose(), 2000);
    } catch (err) {
      console.error("Failed to submit task:", err);
      alert("Failed to submit. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div style={{ textAlign: "center", padding: 20 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
        <h3 style={{ margin: 0, marginBottom: 8 }}>Request Submitted!</h3>
        <p style={{ margin: 0, color: "#666" }}>
          We'll get to work on this soon.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
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
        <h2 style={{ margin: 0 }}>New Request</h2>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label
          style={{
            display: "block",
            marginBottom: 4,
            fontWeight: 500,
            fontSize: 14,
          }}
        >
          Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g., Add dark mode"
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 6,
            border: "1px solid #ddd",
            fontSize: 16,
            boxSizing: "border-box",
          }}
          required
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <label
          style={{
            display: "block",
            marginBottom: 4,
            fontWeight: 500,
            fontSize: 14,
          }}
        >
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe what you'd like in detail..."
          rows={5}
          style={{
            width: "100%",
            padding: 10,
            borderRadius: 6,
            border: "1px solid #ddd",
            fontSize: 16,
            resize: "vertical",
            boxSizing: "border-box",
            fontFamily: "inherit",
          }}
          required
        />
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        style={{
          width: "100%",
          padding: 12,
          backgroundColor: isSubmitting ? "#a5b4fc" : "#6366f1",
          color: "white",
          border: "none",
          borderRadius: 6,
          cursor: isSubmitting ? "not-allowed" : "pointer",
          fontSize: 16,
          fontWeight: 500,
        }}
      >
        {isSubmitting ? "Submitting..." : "Submit Request"}
      </button>
    </form>
  );
}
