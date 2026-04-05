const API_BASE = "/api";

export interface SlotInfo {
  slot: number;
  medication_name: string | null;
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
  const res = await fetch(`${API_BASE}/inventory/`);
  if (!res.ok) throw new Error("Failed to fetch slots");
  return res.json();
}

export async function fetchLogs(
  patientId?: number
): Promise<IntakeRecord[]> {
  const url = patientId
    ? `${API_BASE}/logs/?patient_id=${patientId}`
    : `${API_BASE}/logs/`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch logs");
  return res.json();
}

export async function updateSlot(
  slot: number,
  data: { medication_name: string; quantity: number; patient_id: number }
): Promise<SlotInfo> {
  const res = await fetch(`${API_BASE}/inventory/${slot}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update slot");
  return res.json();
}
