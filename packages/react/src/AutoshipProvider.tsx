import { createClient, SupabaseClient } from "@supabase/supabase-js";
import React, { createContext, useContext, useMemo } from "react";

/**
 * The database schema used by Autoship.
 * All tables are created in this schema to avoid conflicts with other schemas.
 */
export const AUTOSHIP_SCHEMA = "autoship";

export interface AutoshipContextValue {
  supabase: SupabaseClient<any, typeof AUTOSHIP_SCHEMA> | null;
  userId?: string;
  schema: string;
  isConfigured: boolean;
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
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  userId?: string;
  children: React.ReactNode;
}

export function AutoshipProvider({
  supabaseUrl,
  supabaseAnonKey,
  userId,
  children,
}: AutoshipProviderProps): React.ReactElement {
  const { supabase, isConfigured } = useMemo(() => {
    if (!supabaseUrl || !supabaseAnonKey) {
      console.error(
        "[Autoship] Missing configuration. Please provide supabaseUrl and supabaseAnonKey to AutoshipProvider. " +
        "Autoship components will be disabled until configured."
      );
      return { supabase: null, isConfigured: false };
    }

    try {
      const client = createClient(supabaseUrl, supabaseAnonKey, {
        db: {
          schema: AUTOSHIP_SCHEMA,
        },
      });
      return { supabase: client, isConfigured: true };
    } catch (error) {
      console.error("[Autoship] Failed to initialize Supabase client:", error);
      return { supabase: null, isConfigured: false };
    }
  }, [supabaseUrl, supabaseAnonKey]);

  return (
    <AutoshipContext.Provider value={{ supabase, userId, schema: AUTOSHIP_SCHEMA, isConfigured }}>
      {children}
    </AutoshipContext.Provider>
  );
}
