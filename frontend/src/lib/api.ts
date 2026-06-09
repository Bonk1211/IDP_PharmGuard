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
  dispenser_id: string | null;        // nullable; null = unassigned
  face_reference_url: string | null;  // Supabase Storage public URL for face-verify
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

export type PatientPatch = Partial<{
  name: string;
  gender: string | null;
  age: number | null;
  condition: string | null;
  status: string | null;
  allergies: string[];
  contraindications: string[];
  dispenser_id: string | null;
  face_reference_url: string | null;
}>;

export async function updatePatient(id: number, patch: PatientPatch): Promise<Patient> {
  const { data, error } = await supabase
    .from("patients")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Upload a reference photo for the patient face-verify (Layer-1) gate.
 *
 * Path layout: `<patient_id>/<epoch_ms>-<filename>` — collision-free across
 * patients and re-uploads. Bucket `patient-faces` is public (per demo
 * choice) so the resulting URL feeds directly into Rekognition CompareFaces
 * server-side without a signed-URL round trip.
 *
 * Returns the public URL on success (also persisted on the patient row).
 * Throws on Supabase Storage / Postgres error so the caller can toast.
 */
export async function uploadPatientFaceReference(
  patientId: number,
  file: File,
): Promise<string> {
  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
  const path = `${patientId}/${Date.now()}-${safeName}`;
  const { error: upErr } = await supabase.storage
    .from("patient-faces")
    .upload(path, file, {
      contentType: file.type || "image/jpeg",
      upsert: false,
    });
  if (upErr) throw upErr;
  const { data } = supabase.storage.from("patient-faces").getPublicUrl(path);
  await updatePatient(patientId, { face_reference_url: data.publicUrl });
  return data.publicUrl;
}

/**
 * Distinct dispenser IDs already in use, sourced from the medications
 * table (which has dispenser_id from migration 0001). Used to populate
 * the autocomplete suggestions on the patient assignment input. Returns
 * an empty array if Supabase is misconfigured — the input still works
 * as plain free text.
 */
export async function fetchKnownDispensers(): Promise<string[]> {
  const { data, error } = await supabase
    .from("medications")
    .select("dispenser_id")
    .not("dispenser_id", "is", null);
  if (error) return [];
  const set = new Set<string>();
  for (const row of (data ?? []) as { dispenser_id: string | null }[]) {
    if (row.dispenser_id) set.add(row.dispenser_id);
  }
  return [...set].sort();
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

export interface CreateIntakeLogInput {
  patient_id: number;
  slot: number;
  pill_taken: boolean;
  dispenser_id?: string | null;
  confidence_score?: number | null;
}

/**
 * Insert one adherence log via Supabase. Used by the dispenser confirm/
 * override actions so the dashboard doesn't need a server-side hop.
 * Mirrors the shape of POST /api/logs on the backend.
 */
export async function createIntakeLog(input: CreateIntakeLogInput): Promise<IntakeRecord> {
  const { data, error } = await supabase
    .from("adherence_logs")
    .insert(input)
    .select("*, patient:patients(id, name)")
    .single();
  if (error) throw error;
  const row = data as Record<string, unknown> & { patient?: Patient | null };
  return { ...row, patient: row.patient ?? null } as IntakeRecord;
}

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

/**
 * Relocate the medication at `fromSlot` to `toSlot` within ONE patient's
 * dispenser. Two cases, both constraint-safe:
 *   • target empty   → UPDATE the source row's `slot` (one write).
 *   • target filled  → SWAP the medication-identifying columns between the
 *                      two rows, leaving `slot`/`id`/`patient_id` fixed.
 *
 * Why swap content instead of swapping the `slot` values: the table has
 *   UNIQUE (patient_id, slot)  AND  CHECK (slot BETWEEN 0 AND 9)
 * so there is NO legal "parking" slot to stash a row in mid-swap, and
 * supabase-js cannot issue a single multi-row UPDATE with per-row values.
 * Swapping the content columns achieves the same visible result with two
 * plain by-id updates and never touches the unique/range-constrained slot.
 */
export async function moveSlot(
  patientId: number,
  fromSlot: number,
  toSlot: number,
): Promise<void> {
  if (fromSlot === toSlot) return;

  // Pull both rows with all columns (need every med field for the swap).
  const { data: rows, error: readErr } = await supabase
    .from("medications")
    .select("*")
    .eq("patient_id", patientId)
    .in("slot", [fromSlot, toSlot]);
  if (readErr) throw readErr;

  const all = (rows ?? []) as Record<string, unknown>[];
  const src = all.find((r) => r.slot === fromSlot);
  const dst = all.find((r) => r.slot === toSlot);
  if (!src) return; // nothing to move (source empty)

  if (!dst) {
    // Target empty → just move the slot index of the source row.
    const { error } = await supabase
      .from("medications")
      .update({ slot: toSlot })
      .eq("id", src.id);
    if (error) throw error;
    return;
  }

  // Both filled → swap the medication-identifying columns by id.
  const fields = (r: Record<string, unknown>) => ({
    name: r.name,
    description: r.description,
    quantity: r.quantity,
    expiry_date: r.expiry_date,
    pills_per_dose: r.pills_per_dose,
    schedule_at: r.schedule_at,
  });
  const { error: e1 } = await supabase
    .from("medications").update(fields(dst)).eq("id", src.id);
  if (e1) throw e1;
  const { error: e2 } = await supabase
    .from("medications").update(fields(src)).eq("id", dst.id);
  if (e2) throw e2;
}

// ── Alerts (Phase 5 schema; Phase 7 dashboard reads from public.alerts) ──

export type AlertKind = "expiry" | "low_stock";
export type AlertSeverity = "info" | "warning" | "critical";

/**
 * Mirrors public.alerts (backend/migrations/0003_alerts.sql).
 * Per-alert detail (medication name, quantity, temperature reading, etc.)
 * lives in the open-ended `payload` jsonb column.
 */
export interface Alert {
  id: number;
  dispenser_id: string | null;
  kind: AlertKind;
  severity: AlertSeverity;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * Fetch the most recent alerts from `public.alerts`. Tolerates a missing
 * table (Phase 5 not yet merged) by returning [] so the dashboard renders
 * an empty state instead of erroring.
 */
export async function fetchAlerts(opts?: {
  limit?: number;
  kind?: AlertKind;
}): Promise<Alert[]> {
  try {
    let query = supabase
      .from("alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(opts?.limit ?? 100);
    if (opts?.kind) {
      query = query.eq("kind", opts.kind);
    }
    const { data, error } = await query;
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
