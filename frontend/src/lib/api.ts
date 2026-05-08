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
  face_embedding: number[] | null;       // 128-D when enrolled, NULL otherwise
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

// ── Face enrolment (FastAPI) ──

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export async function enrollFace(
  patientId: number,
  file: File,
): Promise<{ ok: boolean; embedding_dim: number }> {
  const fd = new FormData();
  fd.append("patient_id", String(patientId));
  fd.append("file", file);
  const resp = await fetch(`${API_BASE_URL}/api/auth/enroll-face`, {
    method: "POST",
    body: fd,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Enrol failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

// ── Alerts (Phase 5 may not have shipped the table yet — degrade gracefully) ──

export type AlertSeverity = "info" | "warning" | "critical";

// Open-ended union: forward-compat with whatever taxonomy Phase 5 settles on.
export type AlertKind =
  | "low_stock"
  | "out_of_stock"
  | "expiring_soon"
  | "expired"
  | "missed_dose"
  | "temperature"
  | "device_offline"
  | (string & {}); // accept unknown strings, preserve literal autocomplete

export interface Alert {
  id: number | string;
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  patient_id: number | null;
  slot: number | null;
  dispenser_id: string | null;
  created_at: string;
  acknowledged_at: string | null;
}

/**
 * Fetch the most recent alerts from `public.alerts`.
 *
 * The table is created in Phase 5 (sensors + alerts). Until that lands on
 * `main`, the request will fail with a "relation does not exist" error
 * (PostgREST code 42P01) or a schema-cache miss (PGRST205). We treat any
 * of those as "empty list" so the dashboard doesn't error out before
 * Phase 5 merges.
 */
export async function fetchAlerts(): Promise<Alert[]> {
  try {
    const { data, error } = await supabase
      .from("alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      const msg = (error.message ?? "").toLowerCase();
      if (
        error.code === "42P01" ||
        error.code === "PGRST205" ||
        msg.includes("does not exist") ||
        msg.includes("not found") ||
        msg.includes("schema cache")
      ) {
        return [];
      }
      throw error;
    }
    return (data ?? []) as Alert[];
  } catch {
    // Network failure / unknown — never break the dashboard for an optional feed.
    return [];
  }
}
