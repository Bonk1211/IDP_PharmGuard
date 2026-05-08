import { supabase } from "./supabase";

export interface Patient {
  id: number;
  name: string;
  gender: string | null;
  age: number | null;
  condition: string | null;
  status: string | null;
  allergies: string[];
  contraindications: string[];
  created_at: string;
}

export interface SlotInfo {
  id: number;
  slot: number;
  name: string | null;
  description: string | null;
  quantity: number;
  patient_id: number;
  expiry_date: string | null;       // YYYY-MM-DD
  pills_per_dose: number;            // defaults to 1 from DB
  dispenser_id: string | null;
  patient?: Patient | null;
}

export interface IntakeRecord {
  id: number;
  patient_id: number;
  slot: number;
  pill_taken: boolean;
  timestamp: string;
  dispenser_id: string | null;
  confidence_score: number | null;
  patient?: Patient | null;
}

// ── Patients ──

export async function fetchPatients(): Promise<Patient[]> {
  const { data, error } = await supabase
    .from("patients")
    .select("*")
    .order("name");
  if (error) throw error;
  return data ?? [];
}

export async function fetchPatient(id: number): Promise<Patient | null> {
  const { data, error } = await supabase
    .from("patients")
    .select("*")
    .eq("id", id)
    .single();
  if (error) return null;
  return data;
}

export interface CreatePatientInput {
  name: string;
  gender: string;
  age: number;
  condition: string;
  status: string;
  allergies: string[];
  contraindications: string[];
}

export async function createPatient(input: CreatePatientInput): Promise<Patient> {
  const { data, error } = await supabase
    .from("patients")
    .insert(input)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Medications / Slots (per-patient, 10 slots each) ──

export async function fetchAllSlots(): Promise<SlotInfo[]> {
  const { data, error } = await supabase
    .from("medications")
    .select("*, patient:patients(id, name)")
    .order("patient_id")
    .order("slot");
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    ...row,
    patient: row.patient ?? null,
  })) as SlotInfo[];
}

export async function fetchSlotsByPatient(patientId: number): Promise<SlotInfo[]> {
  const { data, error } = await supabase
    .from("medications")
    .select("*")
    .eq("patient_id", patientId)
    .order("slot");
  if (error) throw error;
  return data ?? [];
}

// ── Adherence Logs ──

export async function fetchLogs(patientId?: number): Promise<IntakeRecord[]> {
  let query = supabase
    .from("adherence_logs")
    .select("*, patient:patients(id, name)")
    .order("timestamp", { ascending: false });

  if (patientId !== undefined) {
    query = query.eq("patient_id", patientId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    ...row,
    patient: row.patient ?? null,
  })) as IntakeRecord[];
}

// ── Slot Management (per-patient) ──

export async function updateSlot(
  patientId: number,
  slot: number,
  data: { medication_name: string; quantity: number }
): Promise<SlotInfo> {
  const { data: existing } = await supabase
    .from("medications")
    .select("id")
    .eq("patient_id", patientId)
    .eq("slot", slot)
    .single();

  const payload = {
    name: data.medication_name,
    slot,
    quantity: data.quantity,
    patient_id: patientId,
  };

  if (existing) {
    const { data: updated, error } = await supabase
      .from("medications")
      .update(payload)
      .eq("patient_id", patientId)
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

export async function deleteSlot(patientId: number, slot: number): Promise<void> {
  const { error } = await supabase
    .from("medications")
    .delete()
    .eq("patient_id", patientId)
    .eq("slot", slot);
  if (error) throw error;
}
