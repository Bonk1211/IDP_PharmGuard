import { supabase } from "./supabase";

export interface SlotInfo {
  id: number;
  slot: number;
  name: string | null;
  description: string | null;
  quantity: number;
  patient_id: number | null;
}

export interface IntakeRecord {
  id: number;
  patient_id: number;
  slot: number;
  pill_taken: boolean;
  timestamp: string;
}

export async function fetchSlots(): Promise<SlotInfo[]> {
  const { data, error } = await supabase
    .from("medications")
    .select("*")
    .order("slot");
  if (error) throw error;
  return data ?? [];
}

export async function fetchLogs(patientId?: number): Promise<IntakeRecord[]> {
  let query = supabase
    .from("adherence_logs")
    .select("*")
    .order("timestamp", { ascending: false });

  if (patientId !== undefined) {
    query = query.eq("patient_id", patientId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function updateSlot(
  slot: number,
  data: { medication_name: string; quantity: number; patient_id: number }
): Promise<SlotInfo> {
  const { data: existing } = await supabase
    .from("medications")
    .select("id")
    .eq("slot", slot)
    .single();

  const payload = {
    name: data.medication_name,
    slot,
    quantity: data.quantity,
    patient_id: data.patient_id,
  };

  if (existing) {
    const { data: updated, error } = await supabase
      .from("medications")
      .update(payload)
      .eq("slot", slot)
      .select()
      .single();
    if (error) throw error;
    return updated;
  } else {
    const { data: inserted, error } = await supabase
      .from("medications")
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return inserted;
  }
}
