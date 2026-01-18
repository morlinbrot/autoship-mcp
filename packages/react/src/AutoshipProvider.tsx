import { createClient, SupabaseClient } from "@supabase/supabase-js";
import React, { createContext, useContext, useMemo } from "react";

export interface AutoshipContextValue {
  supabase: SupabaseClient;
  userId?: string;
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
    () => createClient(supabaseUrl, supabaseAnonKey),
    [supabaseUrl, supabaseAnonKey]
  );

  return (
    <AutoshipContext.Provider value={{ supabase, userId }}>
      {children}
    </AutoshipContext.Provider>
  );
}
