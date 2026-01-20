import { useCallback, useEffect, useState } from "react";
import { useAutoshipContext } from "../AutoshipProvider";
import type { Task } from "../TaskList";

export interface UseTasksResult {
  tasks: Task[];
  loading: boolean;
  refresh: () => Promise<void>;
  isConfigured: boolean;
}

export function useTasks(): UseTasksResult {
  const { supabase, userId, schema, isConfigured } = useAutoshipContext();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const loadTasks = useCallback(async () => {
    if (!isConfigured || !supabase) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      let query = supabase
        .from("agent_tasks")
        .select(`
          *,
          task_questions (
            id,
            question,
            answer,
            asked_at,
            answered_at
          )
        `)
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
  }, [supabase, userId, isConfigured]);

  useEffect(() => {
    if (!isConfigured || !supabase) {
      return;
    }

    loadTasks();

    // Subscribe to realtime updates
    const channel = supabase
      .channel("agent_tasks_changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: schema,
          table: "agent_tasks",
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
  }, [supabase, userId, schema, isConfigured, loadTasks]);

  return { tasks, loading, refresh: loadTasks, isConfigured };
}
