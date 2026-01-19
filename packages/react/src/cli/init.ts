import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CliOptions {
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  nonInteractive?: boolean;
}

function loadMigrations(): string {
  // Migrations are copied to dist/migrations/ at build time
  const migrationsDir = path.join(__dirname, "..", "migrations");

  if (!fs.existsSync(migrationsDir)) {
    console.error("\n  Error: Migrations directory not found.");
    console.error("  Expected at:", migrationsDir);
    process.exit(1);
  }

  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort(); // Sort to ensure correct order (files are named with timestamps)

  if (migrationFiles.length === 0) {
    console.error("\n  Error: No migration files found in", migrationsDir);
    process.exit(1);
  }

  // Concatenate all migrations in order
  const migrations = migrationFiles.map(file => {
    const filePath = path.join(migrationsDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    return `-- Migration: ${file}\n${content}`;
  }).join("\n\n");

  return migrations;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--db-url" && args[i + 1]) {
      options.supabaseUrl = args[++i];
    } else if (arg === "--service-key" && args[i + 1]) {
      options.supabaseServiceKey = args[++i];
    } else if (arg === "--non-interactive" || arg === "-y") {
      options.nonInteractive = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
autoship init - Initialize Autoship database schema

Usage:
  npx autoship init [options]

Options:
  --db-url <url>        Supabase project URL
  --service-key <key>   Supabase service role key
  -y, --non-interactive Skip confirmation prompts
  -h, --help            Show this help message

Environment Variables:
  SUPABASE_URL          Supabase project URL (fallback)
  SUPABASE_SERVICE_KEY  Supabase service role key (fallback)

Examples:
  # Interactive mode (prompts for credentials)
  npx autoship init

  # With command line arguments
  npx autoship init --db-url https://xxx.supabase.co --service-key eyJ...

  # Using environment variables
  SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_KEY=eyJ... npx autoship init
`);
}

function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function promptSecret(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    let input = "";

    const onData = (char: Buffer) => {
      const c = char.toString();

      if (c === "\n" || c === "\r") {
        if (stdin.isTTY) {
          stdin.setRawMode(wasRaw ?? false);
        }
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
      } else if (c === "\u0003") {
        // Ctrl+C
        process.exit(1);
      } else if (c === "\u007F" || c === "\b") {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
        }
      } else {
        input += c;
        process.stdout.write("*");
      }
    };

    stdin.on("data", onData);
    stdin.resume();
  });
}

async function getCredentials(options: CliOptions): Promise<{ url: string; serviceKey: string }> {
  let url = options.supabaseUrl || process.env.SUPABASE_URL || "";
  let serviceKey = options.supabaseServiceKey || process.env.SUPABASE_SERVICE_KEY || "";

  if (url && serviceKey) {
    return { url, serviceKey };
  }

  const rl = createReadlineInterface();

  try {
    console.log("\n  Autoship Database Setup\n");
    console.log("  This will create the required tables in your Supabase database.\n");

    if (!url) {
      url = await prompt(rl, "  Supabase URL: ");
    } else {
      console.log(`  Supabase URL: ${url}`);
    }

    if (!serviceKey) {
      serviceKey = await promptSecret(rl, "  Supabase Service Key: ");
    } else {
      console.log("  Supabase Service Key: [provided]");
    }

    return { url, serviceKey };
  } finally {
    rl.close();
  }
}

function validateCredentials(url: string, serviceKey: string): void {
  if (!url) {
    console.error("\n  Error: Supabase URL is required");
    process.exit(1);
  }

  if (!serviceKey) {
    console.error("\n  Error: Supabase Service Key is required");
    process.exit(1);
  }

  try {
    new URL(url);
  } catch {
    console.error("\n  Error: Invalid Supabase URL format");
    process.exit(1);
  }

  if (!serviceKey.startsWith("eyJ")) {
    console.error("\n  Error: Service key should be a JWT (starts with 'eyJ')");
    console.error("  Make sure you're using the service_role key, not the anon key.");
    process.exit(1);
  }
}

async function runMigration(url: string, serviceKey: string, migrationSql: string): Promise<void> {
  console.log("\n  Connecting to Supabase...");

  const supabase = createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  console.log("  Checking database schema...\n");

  // First, let's verify the connection by trying to query
  const { error: connectionError } = await supabase
    .from("agent_tasks")
    .select("id")
    .limit(1);

  if (connectionError && connectionError.code === "42P01") {
    // Table doesn't exist - we need to create it
    // Since we can't run arbitrary SQL via the REST API, we'll provide instructions
    console.log("  Tables don't exist yet.\n");
    console.log("  ============================================================");
    console.log("  Supabase REST API doesn't support direct SQL execution.");
    console.log("  Please run the migration manually using one of these options:");
    console.log("  ============================================================\n");
    console.log("  Option 1: Supabase Dashboard");
    console.log("    1. Go to your Supabase project dashboard");
    console.log("    2. Navigate to SQL Editor");
    console.log("    3. Copy and paste the contents of: ./autoship-migration.sql\n");
    console.log("  Option 2: Supabase CLI");
    console.log("    1. Install Supabase CLI: npm install -g supabase");
    console.log("    2. Link your project: supabase link --project-ref YOUR_PROJECT_REF");
    console.log("    3. Copy autoship-migration.sql to supabase/migrations/");
    console.log("    4. Run: supabase db push\n");

    // Write the migration file locally for convenience
    const outputPath = path.join(process.cwd(), "autoship-migration.sql");
    fs.writeFileSync(outputPath, migrationSql.trim());
    console.log(`  Migration SQL saved to: ${outputPath}\n`);

    console.log("  After running the migration, run this setup command again to verify.\n");
    process.exit(0);
  } else if (connectionError) {
    console.error(`\n  Error connecting to Supabase: ${connectionError.message}`);
    process.exit(1);
  }

  // Tables exist - verify the schema
  console.log("  Verifying database schema...\n");

  const tables = ["agent_tasks", "task_categories", "task_category_assignments", "task_questions"];
  let allTablesExist = true;

  for (const table of tables) {
    const { error } = await supabase.from(table).select("*").limit(0);
    if (error && error.code === "42P01") {
      console.log(`    [ ] ${table} - NOT FOUND`);
      allTablesExist = false;
    } else if (error) {
      console.log(`    [?] ${table} - Error: ${error.message}`);
    } else {
      console.log(`    [x] ${table}`);
    }
  }

  if (allTablesExist) {
    console.log("\n  All tables exist. Your database is ready!\n");
    console.log("  Next steps:");
    console.log("    1. Add SUPABASE_URL and SUPABASE_ANON_KEY to your app's environment");
    console.log("    2. Wrap your app with <AutoshipProvider>");
    console.log("    3. Add the <AutoshipButton /> component\n");
    console.log("  Example:");
    console.log("    import { AutoshipProvider, AutoshipButton } from '@autoship/react';");
    console.log("");
    console.log("    function App() {");
    console.log("      return (");
    console.log("        <AutoshipProvider");
    console.log("          supabaseUrl={process.env.SUPABASE_URL}");
    console.log("          supabaseAnonKey={process.env.SUPABASE_ANON_KEY}");
    console.log("        >");
    console.log("          <YourApp />");
    console.log("          <AutoshipButton />");
    console.log("        </AutoshipProvider>");
    console.log("      );");
    console.log("    }\n");
  } else {
    console.log("\n  Some tables are missing. Please run the migration SQL.");

    const outputPath = path.join(process.cwd(), "autoship-migration.sql");
    fs.writeFileSync(outputPath, migrationSql.trim());
    console.log(`  Migration SQL saved to: ${outputPath}\n`);

    process.exit(1);
  }
}

export async function run(args: string[]): Promise<void> {
  const options = parseArgs(args);

  try {
    // Load migrations from the bundled files
    const migrationSql = loadMigrations();

    const { url, serviceKey } = await getCredentials(options);
    validateCredentials(url, serviceKey);
    await runMigration(url, serviceKey, migrationSql);
  } catch (error) {
    console.error("\n  Unexpected error:", error);
    process.exit(1);
  }
}
