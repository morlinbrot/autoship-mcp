import { useCallback, useEffect, useState } from "react";
import { useAutoshipContext } from "../AutoshipProvider";
import type { Task } from "../TaskList";

export interface UseTasksResult {
  tasks: Task[];
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useTasks(): UseTasksResult {
  const { supabase, userId } = useAutoshipContext();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase
        .from("agent_todos")
        .select("*")
        .order("created_at", { ascending: false });

      if (userId) {
        query = query.eq("submitted_by", userId);
      }

      const { data, error } = await query;
      if (error) throw error;
      setTasks((data as Task[]) || []);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setLoading(false);
    }
  }, [supabase, userId]);

  useEffect(() => {
    loadTasks();

    // Subscribe to realtime updates
    const channel = supabase
      .channel("agent_todos_changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_todos",
          filter: userId ? `submitted_by=eq.${userId}` : undefined,
        },
        () => {
          loadTasks();
        }
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, [supabase, userId, loadTasks]);

  return { tasks, loading, refresh: loadTasks };
}
