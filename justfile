default:
    just -l -u

set dotenv-path := "demo/.env"

# Build the react package with both components and CLI
build:
    cd packages/react && npm run build

# Run the demo app
dev: build
    cd demo && npm run dev

# Run the CLI
cli *args: build
    cd packages/react && npm run cli -- {{ args }}

# Run migrations on the remote database
db:
    supabase db push --db-url $DATABASE_URL

# Run the command that the check-pending-tasks job uses
check:
    curl -s \
    -H "apikey: $SUPABASE_SERVICE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
    "$VITE_SUPABASE_URL/rest/v1/agent_tasks?status=eq.pending&select=id&limit=1"
