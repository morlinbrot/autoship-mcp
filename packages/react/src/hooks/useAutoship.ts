import { useAutoshipContext } from "../AutoshipProvider";

export interface SubmitTaskOptions {
  title: string;
  description: string;
  priority?: number;
}

export interface SubmittedTask {
  id: string;
  title: string;
  description: string;
  priority: number;
  status: string;
  submitted_by: string | null;
  created_at: string;
}

export function useAutoship() {
  const { supabase, userId, isConfigured } = useAutoshipContext();

  const submitTask = async ({
    title,
    description,
    priority = 0,
  }: SubmitTaskOptions): Promise<SubmittedTask> => {
    if (!isConfigured || !supabase) {
      throw new Error("[Autoship] Cannot submit task: Autoship is not configured");
    }

    const id = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const { data, error } = await supabase
      .from("agent_tasks")
      .insert({
        id,
        title,
        description,
        priority,
        status: "pending",
        submitted_by: userId || null,
      })
      .select()
      .single();

    if (error) throw error;
    return data as SubmittedTask;
  };

  return { submitTask, isConfigured };
}
