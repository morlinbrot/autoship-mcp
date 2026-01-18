set dotenv-path := "demo/.env"

db:
    supabase db push --db-url $DATABASE_URL

echo:
    echo $DATABASE_URL
