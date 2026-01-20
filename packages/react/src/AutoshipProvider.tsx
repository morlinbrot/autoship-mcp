import { createClient, SupabaseClient } from "@supabase/supabase-js";
import React, { createContext, useContext, useMemo } from "react";

/**
 * The database schema used by Autoship.
 * All tables are created in this schema to avoid conflicts with other schemas.
 */
export const AUTOSHIP_SCHEMA = "autoship";

export interface AutoshipContextValue {
  supabase: SupabaseClient<any, typeof AUTOSHIP_SCHEMA>;
  userId?: string;
  schema: string;
}

const AutoshipContext = createContext<AutoshipContextValue | null>(null);

export function useAutoshipContext(): AutoshipContextValue {
  const ctx = useContext(AutoshipContext);
  if (!ctx) {
    throw new Error("useAutoshipContext must be used within AutoshipProvider");
  }
  return ctx;
}

export interface AutoshipProviderProps {
  supabaseUrl: string;
  supabaseAnonKey: string;
  userId?: string;
  children: React.ReactNode;
}

export function AutoshipProvider({
  supabaseUrl,
  supabaseAnonKey,
  userId,
  children,
}: AutoshipProviderProps): React.ReactElement {
  const supabase = useMemo(
    () => createClient(supabaseUrl, supabaseAnonKey, {
      db: {
        schema: AUTOSHIP_SCHEMA,
      },
    }),
    [supabaseUrl, supabaseAnonKey]
  );

  return (
    <AutoshipContext.Provider value={{ supabase, userId, schema: AUTOSHIP_SCHEMA }}>
      {children}
    </AutoshipContext.Provider>
  );
}
