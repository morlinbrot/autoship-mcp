import { AutoshipButton, AutoshipProvider } from "@autoship/react";

function App() {
  // These would come from environment variables in a real app
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

  // Check if credentials are configured
  if (!supabaseUrl || !supabaseAnonKey) {
    return (
      <div style={{ padding: 40, maxWidth: 600, margin: "0 auto" }}>
        <h1>Autoship Demo</h1>
        <div
          style={{
            padding: 20,
            backgroundColor: "#fef3c7",
            border: "1px solid #f59e0b",
            borderRadius: 8,
            marginBottom: 20,
          }}
        >
          <h3 style={{ margin: "0 0 12px 0", color: "#92400e" }}>
            Configuration Required
          </h3>
          <p style={{ margin: 0, color: "#92400e" }}>
            Create a <code>.env</code> file in the demo directory with:
          </p>
          <pre
            style={{
              backgroundColor: "#fffbeb",
              padding: 12,
              borderRadius: 4,
              marginTop: 12,
              overflow: "auto",
            }}
          >
            {`VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key`}
          </pre>
        </div>
        <p>
          Then restart the dev server with <code>npm run dev</code>
        </p>
      </div>
    );
  }

  return (
    <AutoshipProvider supabaseUrl={supabaseUrl} supabaseAnonKey={supabaseAnonKey}>
      <div style={{ padding: 40, maxWidth: 800, margin: "0 auto" }}>
        <h1>Autoship Demo</h1>
        <p style={{ color: "#6b7280", marginBottom: 24 }}>
          This is a minimal demo showing how to integrate Autoship into your
          React application. Click the floating button in the bottom-right
          corner to submit feedback or view your requests.
        </p>

        <div
          style={{
            padding: 24,
            backgroundColor: "white",
            borderRadius: 12,
            border: "1px solid #e5e7eb",
            marginBottom: 24,
          }}
        >
          <h2 style={{ marginTop: 0 }}>How it works</h2>
          <ol style={{ lineHeight: 1.8 }}>
            <li>
              <strong>Submit a request</strong> - Click the + button and
              describe what you'd like built
            </li>
            <li>
              <strong>AI processes it</strong> - A Claude agent picks up your
              request and starts working
            </li>
            <li>
              <strong>Answer questions</strong> - If the AI needs clarification,
              it will ask you
            </li>
            <li>
              <strong>Review the PR</strong> - When done, the AI creates a pull
              request for review
            </li>
          </ol>
        </div>

        <div
          style={{
            padding: 24,
            backgroundColor: "white",
            borderRadius: 12,
            border: "1px solid #e5e7eb",
          }}
        >
          <h2 style={{ marginTop: 0 }}>Integration Code</h2>
          <pre
            style={{
              backgroundColor: "#1f2937",
              color: "#e5e7eb",
              padding: 16,
              borderRadius: 8,
              overflow: "auto",
              fontSize: 14,
            }}
          >
            {`import { AutoshipProvider, AutoshipButton } from "@autoship/react";

function App() {
  return (
    <AutoshipProvider
      supabaseUrl={import.meta.env.VITE_SUPABASE_URL}
      supabaseAnonKey={import.meta.env.VITE_SUPABASE_ANON_KEY}
    >
      <YourApp />
      <AutoshipButton />
    </AutoshipProvider>
  );
}`}
          </pre>
        </div>
      </div>

      {/* The floating feedback button */}
      <AutoshipButton position="bottom-right" showTaskList={true} />
    </AutoshipProvider>
  );
}

export default App;
