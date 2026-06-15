// ──────────────────────────── Intake confidence model ────────────────────────────
//
// Goal: verify the patient actually swallowed the pill WITHOUT a human in the
// loop. No single sensor is ever 100% sure, so we blend three independent
// signals into one composite confidence (0..1):
//
//   1. swallow        — MediaPipe swallow-FSM confidence (vision/intake_monitor)
//   2. objectEvidence — AWS Rekognition gate labels (cup / pill / drink seen)
//   3. gaze           — eye-movement / gaze-fixation on the pill during swallow
//
// Eye-movement analysis is a well-established window into human behaviour;
// here the gaze signal is a HARDCODED proof-of-concept (see GAZE_IS_MOCK). In
// a real build it would come from a gaze tracker measuring fixation stability
// on the pill/cup across the swallow window.

export type IntakeSignals = {
  swallow: number; // 0..1
  objectEvidence: number; // 0..1
  gaze: number; // 0..1
};

// Weights sum to 1. Swallow leads (it's the direct act), object-evidence
// corroborates, gaze is a softer behavioural tiebreaker.
export const INTAKE_WEIGHTS = {
  swallow: 0.5,
  objectEvidence: 0.3,
  gaze: 0.2,
} as const;

export const SIGNAL_META: Record<
  keyof IntakeSignals,
  { label: string; short: string; note: string }
> = {
  swallow: {
    label: "Swallow motion",
    short: "Swallow",
    note: "MediaPipe face/hand FSM — tilt → mouth → swallow.",
  },
  objectEvidence: {
    label: "Object evidence",
    short: "Object",
    note: "AWS Rekognition saw the cup / pill / drink on camera.",
  },
  gaze: {
    label: "Gaze fixation",
    short: "Gaze",
    note: "Eye-movement fixation on the pill during the swallow window.",
  },
};

// The gaze signal is synthesised, not measured. Flip this off the day a real
// gaze tracker lands and remove mockGazeScore.
export const GAZE_IS_MOCK = true;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function compositeConfidence(s: IntakeSignals): number {
  const w = INTAKE_WEIGHTS;
  return clamp01(
    s.swallow * w.swallow +
      s.objectEvidence * w.objectEvidence +
      s.gaze * w.gaze,
  );
}

// Deterministic pseudo-random gaze-fixation score in [0.80, 0.98) from a seed
// (record id / round number) so a given intake always shows the same number.
export function mockGazeScore(seed: number): number {
  const x = Math.sin((seed + 1) * 12.9898) * 43758.5453;
  const frac = x - Math.floor(x); // 0..1
  return 0.8 + frac * 0.18;
}

// Object-evidence → 0..1 from the Rekognition gate-label state.
export function objectEvidenceScore(
  satisfied: boolean,
  matched: number,
  required: number,
): number {
  if (required <= 0) return satisfied ? 0.9 : 0.3;
  // Base credit for any match, scaled by how many gate labels were seen.
  const ratio = clamp01(matched / required);
  return satisfied ? clamp01(0.7 + 0.3 * ratio) : clamp01(0.25 + 0.2 * ratio);
}

// Confidence band → label + tone for the UI.
export function confidenceBand(c: number): {
  label: string;
  tone: "ok" | "warn" | "fail";
} {
  if (c >= 0.85) return { label: "High — auto-verified", tone: "ok" };
  if (c >= 0.65) return { label: "Moderate — review suggested", tone: "warn" };
  return { label: "Low — needs human check", tone: "fail" };
}

// Live signals during a dispense cycle (dispenser page). `intake` is the
// IntakeState polled from /api/device/intake.
export function signalsFromLive(
  intake: {
    confidence?: number;
    labels_satisfied?: boolean;
    labels_required?: string[];
    labels_seen_at?: Record<string, number>;
  } | null,
): IntakeSignals {
  const swallow = clamp01(intake?.confidence ?? 0);
  const required = intake?.labels_required ?? [];
  const seenAt = intake?.labels_seen_at ?? {};
  const matched = required.filter((r) => r in seenAt).length;
  const objectEvidence = objectEvidenceScore(
    !!intake?.labels_satisfied,
    matched,
    required.length,
  );
  // Gaze seeded by the rounded swallow confidence so it's stable within a run.
  const gaze = mockGazeScore(Math.round(swallow * 1000));
  return { swallow, objectEvidence, gaze };
}

// Representative breakdown for a historical log row. The composite headline is
// the stored confidence_score (authoritative); these component values are
// illustrative — only `gaze` is purely synthetic, `swallow` uses the stored
// score, and object-evidence is inferred from the taken/missed outcome since
// per-signal evidence isn't persisted per row (PoC).
export function signalsFromRecord(record: {
  id: number;
  pill_taken: boolean;
  confidence_score: number | null;
}): IntakeSignals {
  const swallow = clamp01(
    record.confidence_score ?? (record.pill_taken ? 0.7 : 0.2),
  );
  const objectEvidence = record.pill_taken ? 0.9 : 0.25;
  const gaze = mockGazeScore(record.id);
  return { swallow, objectEvidence, gaze };
}
