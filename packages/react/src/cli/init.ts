import * as fs from "fs";
import * as path from "path";
import postgres from "postgres";
import * as readline from "readline";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CliOptions {
  databaseUrl?: string;
  supabaseUrl?: string;
  dbPassword?: string;
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
    if (arg === "--database-url" && args[i + 1]) {
      options.databaseUrl = args[++i];
    } else if (arg === "--supabase-url" && args[i + 1]) {
      options.supabaseUrl = args[++i];
    } else if (arg === "--db-password" && args[i + 1]) {
      options.dbPassword = args[++i];
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
  --database-url <url>  Full PostgreSQL connection URL (includes password)
  --supabase-url <url>  Supabase project URL (used to construct DATABASE_URL)
  --db-password <pwd>   Database password (used with --supabase-url)
  -y, --non-interactive Skip confirmation prompts
  -h, --help            Show this help message

Environment Variables:
  DATABASE_URL          Full PostgreSQL connection URL (preferred)
  SUPABASE_URL          Supabase project URL (fallback, requires DB_PASSWORD)
  DB_PASSWORD           Database password (used with SUPABASE_URL)

Connection Methods:
  1. Provide DATABASE_URL directly (recommended):
     DATABASE_URL=postgresql://postgres.xxx:[password]@aws-0-region.pooler.supabase.com:6543/postgres

  2. Provide SUPABASE_URL + DB_PASSWORD:
     The CLI will construct the DATABASE_URL from your Supabase project URL.

Examples:
  # Interactive mode (prompts for credentials)
  npx autoship init

  # With full database URL
  npx autoship init --database-url "postgresql://postgres.xxx:password@aws-0-region.pooler.supabase.com:6543/postgres"

  # With Supabase URL + password
  npx autoship init --supabase-url https://xxx.supabase.co --db-password mypassword

  # Using environment variables
  DATABASE_URL="postgresql://..." npx autoship init
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

/**
 * Constructs a DATABASE_URL from a Supabase project URL and password.
 *
 * Supabase URL format: https://[project-ref].supabase.co
 * Database URL format: postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
 *
 * Note: We use the transaction pooler (port 6543) for compatibility.
 * The region is detected from the Supabase URL or defaults to us-east-1.
 */
function constructDatabaseUrl(supabaseUrl: string, password: string): string {
  const url = new URL(supabaseUrl);
  const hostname = url.hostname; // e.g., "xxx.supabase.co"
  const projectRef = hostname.split(".")[0];

  if (!projectRef) {
    throw new Error("Could not extract project reference from Supabase URL");
  }

  // Supabase uses different regional pooler endpoints
  // Default to us-east-1, but this can be adjusted
  // The actual region is embedded in the project, but we can't easily detect it
  // Users can provide DATABASE_URL directly if they need a specific region
  const region = "us-east-1";

  const encodedPassword = encodeURIComponent(password);
  return `postgresql://postgres.${projectRef}:${encodedPassword}@aws-0-${region}.pooler.supabase.com:6543/postgres`;
}

async function getConnectionUrl(options: CliOptions): Promise<string> {
  // Priority: CLI args > env vars > interactive prompt

  // Check for direct DATABASE_URL first
  let databaseUrl = options.databaseUrl || process.env.DATABASE_URL;
  if (databaseUrl) {
    return databaseUrl;
  }

  // Check for SUPABASE_URL + DB_PASSWORD combination
  let supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
  let dbPassword = options.dbPassword || process.env.DB_PASSWORD;

  if (supabaseUrl && dbPassword) {
    return constructDatabaseUrl(supabaseUrl, dbPassword);
  }

  // Interactive mode
  const rl = createReadlineInterface();

  try {
    console.log("\n  Autoship Database Setup\n");
    console.log("  This will create the required tables in your Supabase database.\n");
    console.log("  You can provide credentials in two ways:");
    console.log("    1. Full DATABASE_URL (includes password)");
    console.log("    2. Supabase URL + database password\n");

    const choice = await prompt(rl, "  Enter (1) for DATABASE_URL or (2) for Supabase URL + password: ");

    if (choice === "1") {
      console.log("\n  Find your DATABASE_URL in Supabase Dashboard:");
      console.log("    Project Settings > Database > Connection string > URI\n");
      databaseUrl = await promptSecret(rl, "  DATABASE_URL: ");
      return databaseUrl;
    } else {
      if (!supabaseUrl) {
        supabaseUrl = await prompt(rl, "\n  Supabase URL (e.g., https://xxx.supabase.co): ");
      } else {
        console.log(`\n  Supabase URL: ${supabaseUrl}`);
      }

      if (!dbPassword) {
        console.log("\n  Find your database password in Supabase Dashboard:");
        console.log("    Project Settings > Database > Database password\n");
        dbPassword = await promptSecret(rl, "  Database password: ");
      }

      return constructDatabaseUrl(supabaseUrl, dbPassword);
    }
  } finally {
    rl.close();
  }
}

function validateDatabaseUrl(databaseUrl: string): void {
  if (!databaseUrl) {
    console.error("\n  Error: Database connection URL is required");
    process.exit(1);
  }

  try {
    const url = new URL(databaseUrl);
    if (!url.protocol.startsWith("postgres")) {
      throw new Error("Not a PostgreSQL URL");
    }
  } catch {
    console.error("\n  Error: Invalid DATABASE_URL format");
    console.error("  Expected format: postgresql://user:password@host:port/database");
    process.exit(1);
  }
}

async function runMigration(databaseUrl: string, migrationSql: string): Promise<void> {
  console.log("\n  Connecting to database...");

  const sql = postgres(databaseUrl, {
    ssl: "require",
    connect_timeout: 10,
  });

  try {
    // Test the connection
    await sql`SELECT 1`;
    console.log("  Connected successfully.\n");

    console.log("  Running migrations...\n");

    // Execute the migration SQL
    await sql.unsafe(migrationSql);

    console.log("  Migrations completed successfully!\n");

    // Verify the schema
    console.log("  Verifying database schema...\n");

    const tables = ["agent_tasks", "task_categories", "task_category_assignments", "task_questions"];
    let allTablesExist = true;

    for (const table of tables) {
      try {
        await sql.unsafe(`SELECT 1 FROM autoship.${table} LIMIT 0`);
        console.log(`    [x] autoship.${table}`);
      } catch (error) {
        console.log(`    [ ] autoship.${table} - NOT FOUND`);
        allTablesExist = false;
      }
    }

    if (allTablesExist) {
      console.log("\n  All tables created in the 'autoship' schema.\n");
      console.log("  IMPORTANT: Expose the schema in Supabase Dashboard:");
      console.log("    1. Go to Project Settings > API");
      console.log("    2. Scroll to 'Data API Settings'");
      console.log("    3. Add 'autoship' to the 'Extra search path'");
      console.log("    4. Save changes\n");
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
      console.log("\n  Warning: Some tables may not have been created correctly.");
      console.log("  Please check the migration output above for errors.\n");
      process.exit(1);
    }
  } catch (error) {
    const err = error as Error & { code?: string };

    if (err.code === "28P01") {
      console.error("\n  Error: Authentication failed. Check your database password.");
    } else if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
      console.error("\n  Error: Could not connect to database. Check your connection URL.");
    } else if (err.message?.includes("already exists")) {
      console.log("\n  Schema already exists. Verifying tables...\n");

      // Verify existing schema
      const tables = ["agent_tasks", "task_categories", "task_category_assignments", "task_questions"];
      let allTablesExist = true;

      for (const table of tables) {
        try {
          await sql.unsafe(`SELECT 1 FROM autoship.${table} LIMIT 0`);
          console.log(`    [x] autoship.${table}`);
        } catch {
          console.log(`    [ ] autoship.${table} - NOT FOUND`);
          allTablesExist = false;
        }
      }

      if (allTablesExist) {
        console.log("\n  All tables exist. Your database is ready!\n");
      } else {
        console.log("\n  Some tables are missing. You may need to run migrations manually.\n");
        process.exit(1);
      }
    } else {
      console.error(`\n  Error: ${err.message}`);
      process.exit(1);
    }
  } finally {
    await sql.end();
  }
}

export async function run(args: string[]): Promise<void> {
  const options = parseArgs(args);

  try {
    // Load migrations from the bundled files
    const migrationSql = loadMigrations();

    const databaseUrl = await getConnectionUrl(options);
    validateDatabaseUrl(databaseUrl);
    await runMigration(databaseUrl, migrationSql);
  } catch (error) {
    console.error("\n  Unexpected error:", error);
    process.exit(1);
  }
}
