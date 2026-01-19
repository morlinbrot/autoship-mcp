import React, { useState } from "react";
import { TaskDialog } from "./TaskDialog";
import { TaskList } from "./TaskList";

export interface AutoshipButtonProps {
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  showTaskList?: boolean;
}

export function AutoshipButton({
  position = "bottom-right",
  showTaskList = true,
}: AutoshipButtonProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<"menu" | "new" | "list">("menu");

  const positionStyles: Record<string, React.CSSProperties> = {
    "bottom-right": { bottom: 20, right: 20 },
    "bottom-left": { bottom: 20, left: 20 },
    "top-right": { top: 20, right: 20 },
    "top-left": { top: 20, left: 20 },
  };

  const handleClose = () => {
    setIsOpen(false);
    setView("menu");
  };

  return (
    <>
      {/* Floating Button */}
      <button
        onClick={() => setIsOpen(true)}
        style={{
          position: "fixed",
          ...positionStyles[position],
          width: 56,
          height: 56,
          borderRadius: "50%",
          backgroundColor: "#10b981",
          color: "white",
          border: "none",
          cursor: "pointer",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 24,
          zIndex: 9999,
        }}
        aria-label="Open Autoship"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Chat bubble */}
          <path
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          {/* AI spark */}
          <g>
            <path
              d="M18 6l-1.5 1.5L18 9l1.5-1.5L18 6z"
              fill="currentColor"
            />
            <path
              d="M20.5 3.5l-1 1L20.5 5.5l1-1L20.5 3.5z"
              fill="currentColor"
            />
            <path
              d="M16.5 2.5l-0.5 0.5L16.5 3.5l0.5-0.5L16.5 2.5z"
              fill="currentColor"
            />
          </g>
        </svg>
      </button>

      {/* Modal */}
      {isOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10000,
          }}
          onClick={handleClose}
        >
          <div
            style={{
              backgroundColor: "white",
              borderRadius: 12,
              padding: 24,
              minWidth: 400,
              maxWidth: "90vw",
              maxHeight: "80vh",
              overflow: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {view === "menu" && (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                <h2 style={{ margin: 0, marginBottom: 8 }}>Autoship</h2>
                <button
                  onClick={() => setView("new")}
                  style={{
                    padding: "12px 16px",
                    backgroundColor: "#10b981",
                    color: "white",
                    border: "none",
                    borderRadius: 8,
                    cursor: "pointer",
                    fontSize: 16,
                  }}
                >
                  Submit New Request
                </button>
                {showTaskList && (
                  <button
                    onClick={() => setView("list")}
                    style={{
                      padding: "12px 16px",
                      backgroundColor: "#f3f4f6",
                      color: "#374151",
                      border: "1px solid #e5e7eb",
                      borderRadius: 8,
                      cursor: "pointer",
                      fontSize: 16,
                    }}
                  >
                    View My Requests
                  </button>
                )}
              </div>
            )}
            {view === "new" && (
              <TaskDialog onClose={handleClose} onBack={() => setView("menu")} />
            )}
            {view === "list" && <TaskList onBack={() => setView("menu")} />}
          </div>
        </div>
      )}
    </>
  );
}