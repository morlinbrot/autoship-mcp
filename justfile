set dotenv-path := "demo/.env"

db:
    supabase db push --db-url $DATABASE_URL

check:
    curl -s \
    -H "apikey: $SUPABASE_SERVICE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
    "$VITE_SUPABASE_URL/rest/v1/agent_tasks?status=eq.pending&select=id&limit=1"
