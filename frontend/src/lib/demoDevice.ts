/**
 * Scripted mock device for stage-demo insurance.
 *
 * Activated by `?demo=1` (happy path) or `?demo=fail` (wrong-pill rejection)
 * on the guided dispense page. device.ts intercepts its exports at the top of
 * each function, so the whole guided flow runs with ZERO backend — synthetic
 * camera frames are drawn on a canvas and watermarked "SIMULATED", and the
 * intake FSM advances on a wall-clock script so the page's normal polling
 * drives the animation.
 *
 * Honesty rules: demo mode never writes to Supabase (the page guards
 * logIntake) and the header shows an amber SIMULATION chip. This is a
 * deliberate browser-side layer — the backend's PHARMGUARD_STUB mode must
 * never fake success (HI-012), so the simulator lives here instead.
 */

import type {
  DeviceStatus,
  DrawerAction,
  DrawerResult,
  EjectResult,
  IntakeStartResult,
  IntakeState,
  IntakeStepHistoryRow,
  LogRecord,
  PillDetection,
  RotateResult,
  VerifyFaceResult,
  VerifyPillResult,
} from "./device";

export type DemoScenario = "happy" | "fail";

let active = false;
let scenario: DemoScenario = "happy";
let cycleN = 0;
let ejectedSlot: number | null = null;
let intakeStartedAt: number | null = null;
let drawerUnlocked = false;

export function activateDemo(s: DemoScenario): void {
  active = true;
  scenario = s;
}

export function isDemoActive(): boolean {
  return active;
}

/** Turn the simulator off and reset its round state. Called when the guided
 *  page unmounts so the mock layer never leaks into other pages via
 *  client-side navigation. */
export function deactivateDemo(): void {
  active = false;
  ejectedSlot = null;
  intakeStartedAt = null;
  drawerUnlocked = false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ──────────────────────── synthetic camera frames ────────────────────────

/**
 * Draw a fake camera frame and return it as raw base64 JPEG (no data: prefix
 * — matches the `snapshot_b64` contract the page renders). Empty string under
 * SSR where there is no document.
 */
function synthFrame(
  lines: string[],
  opts?: { box?: boolean; tone?: "ok" | "fail" },
): string {
  if (typeof document === "undefined") return "";
  const w = 640;
  const h = 480;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  ctx.fillStyle = "#1e2430";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (opts?.box) {
    ctx.strokeStyle = opts.tone === "fail" ? "#e5484d" : "#46a758";
    ctx.lineWidth = 3;
    ctx.strokeRect(180, 140, 280, 220);
  }

  ctx.fillStyle = "#e8eaed";
  ctx.font = "bold 28px monospace";
  ctx.fillText(lines[0] ?? "", 24, 48);
  ctx.font = "20px monospace";
  for (let i = 1; i < lines.length; i++) {
    ctx.fillText(lines[i], 24, 48 + i * 32);
  }

  ctx.fillStyle = "rgba(255,196,0,0.85)";
  ctx.font = "bold 16px monospace";
  ctx.fillText("SIMULATED", w - 120, h - 16);

  return canvas.toDataURL("image/jpeg", 0.8).split(",")[1] ?? "";
}

// ──────────────────────────── device API mocks ────────────────────────────

export function demoFetchDeviceStatus(): DeviceStatus {
  return {
    headless: false,
    hardware_stubbed: false,
    cycle_n: cycleN,
    last_cycle:
      cycleN > 0
        ? { cycle: cycleN, pill_taken: scenario === "happy", t_total_ms: 14820 }
        : null,
    task_running: true,
    is_unlocked: drawerUnlocked,
  };
}

export async function demoTriggerDispense(): Promise<{ ok: boolean; status: number }> {
  await sleep(300);
  return { ok: true, status: 202 };
}

export async function demoRotate(slot: number): Promise<RotateResult> {
  await sleep(450);
  return { ok: true, status: 200, slot, current_slot: slot, latency_ms: 410 };
}

export async function demoManualEject(slot: number): Promise<EjectResult> {
  await sleep(1200);
  ejectedSlot = slot;
  cycleN += 1;
  // New round: clear any previous intake run so the next start gets a
  // fresh FSM (mirrors the cycle runner starting a new swallow watch).
  intakeStartedAt = null;
  return { ok: true, status: 200, latency_ms: 1187 };
}

export async function demoVerifyPill(expected?: string): Promise<VerifyPillResult> {
  await sleep(700);
  const fail = scenario === "fail";
  const className = fail ? "Panadol_tablet" : expected ?? "Lomide_capsule";
  const top: PillDetection = {
    class_name: className,
    confidence: fail ? 0.91 : 0.93,
    bbox: [180, 140, 460, 360],
  };
  return {
    ok: true,
    status: 200,
    expected: expected ?? null,
    top,
    match: expected ? !fail : null,
    detections: [top],
    snapshot_b64: synthFrame(
      ["TRAY CAM", `detected: ${className}`, expected ? `expected: ${expected}` : ""],
      { box: true, tone: fail ? "fail" : "ok" },
    ),
    latency_ms: 693,
  };
}

export async function demoVerifyFace(patientId: number): Promise<VerifyFaceResult> {
  await sleep(900);
  // Face verify succeeds in BOTH scenarios — the fail act is about the pill.
  return {
    ok: true,
    status: 200,
    patient_id: patientId,
    patient_name: null,
    match: true,
    similarity: 94.2,
    threshold: 80,
    bbox: { Left: 0.31, Top: 0.22, Width: 0.36, Height: 0.5 },
    snapshot_b64: synthFrame(["FACE CAM", "match 94.2%"], { box: true, tone: "ok" }),
    latency_ms: 884,
  };
}

export async function demoStartIntake(timeoutS: number): Promise<IntakeStartResult> {
  await sleep(200);
  if (intakeStartedAt !== null) {
    // One FSM run per eject: report already_running while in flight, and
    // keep a terminal verdict on screen instead of restarting — a new
    // eject (demoManualEject) resets the round.
    const running = (Date.now() - intakeStartedAt) / 1000 < TOTAL_S;
    return { ok: true, status: 202, already_running: running, timeout_s: timeoutS };
  }
  intakeStartedAt = Date.now();
  return { ok: true, status: 202, already_running: false, timeout_s: timeoutS };
}

// Matches INTAKE_STEP_SLUG keys in the guided page + the 4-step FSM the
// backend runs (vision/intake_monitor.py).
const STEPS: { name: string; label: string; instruction: string }[] = [
  { name: "READY", label: "Take the pill", instruction: "Bring your hand up to your mouth" },
  { name: "INSERT", label: "Place it in your mouth", instruction: "Open wide and place the pill in your mouth" },
  { name: "SWALLOW", label: "Swallow", instruction: "Close your mouth and swallow" },
  { name: "DONE", label: "Show it's gone", instruction: "Open your mouth so I can see it's all gone" },
];

const STEP_S = 4; // seconds per scripted step
const TOTAL_S = STEP_S * STEPS.length;

function idleIntakeState(): IntakeState {
  return {
    running: false,
    step_index: 0,
    total_steps: STEPS.length,
    step_name: "READY",
    step_label: "Take the pill",
    instruction: "Waiting for cycle to start",
    confidence: 0,
    hold_progress: 0,
    face_visible: false,
    hands_count: 0,
    history: [],
    result: null,
    started_at: null,
    ended_at: null,
    updated_at: null,
    labels_seen: [],
    labels_seen_at: {},
    labels_required: [],
    labels_satisfied: false,
    mediapipe_complete: false,
    labels_inflight: false,
    labels_last_call_at: null,
  };
}

export function demoFetchIntakeState(): IntakeState {
  if (intakeStartedAt === null) return idleIntakeState();
  const now = Date.now();
  const elapsedS = (now - intakeStartedAt) / 1000;
  const startedAt = intakeStartedAt / 1000;
  const fail = scenario === "fail";

  if (elapsedS >= TOTAL_S) {
    const endedAt = startedAt + TOTAL_S;
    const history: IntakeStepHistoryRow[] = STEPS.map((s, i) => ({
      step_index: i,
      step_name: s.name,
      passed_at: startedAt + (i + 1) * STEP_S,
    }));
    return {
      ...idleIntakeState(),
      running: false,
      step_index: STEPS.length - 1,
      step_name: "DONE",
      step_label: STEPS[STEPS.length - 1].label,
      instruction: fail ? "No cup or pill was seen" : "All done — well done!",
      confidence: fail ? 0.62 : 0.95,
      hold_progress: 1,
      face_visible: true,
      hands_count: 1,
      history,
      result: fail ? "missing_labels" : "passed",
      started_at: startedAt,
      ended_at: endedAt,
      updated_at: now / 1000,
      labels_seen: fail ? [] : ["cup"],
      labels_seen_at: fail ? {} : { cup: startedAt + 9 },
      labels_required: ["bottle", "cup", "mug", "drink", "drinking", "pill"],
      labels_satisfied: !fail,
      mediapipe_complete: true,
    };
  }

  const stepIdx = Math.min(Math.floor(elapsedS / STEP_S), STEPS.length - 1);
  const holdProgress = (elapsedS - stepIdx * STEP_S) / STEP_S;
  const step = STEPS[stepIdx];
  const history: IntakeStepHistoryRow[] = STEPS.slice(0, stepIdx).map((s, i) => ({
    step_index: i,
    step_name: s.name,
    passed_at: startedAt + (i + 1) * STEP_S,
  }));
  return {
    ...idleIntakeState(),
    running: true,
    step_index: stepIdx,
    step_name: step.name,
    step_label: step.label,
    instruction: step.instruction,
    confidence: 0.55 + 0.4 * holdProgress,
    hold_progress: holdProgress,
    face_visible: true,
    hands_count: 1,
    history,
    started_at: startedAt,
    updated_at: now / 1000,
    labels_seen: !fail && elapsedS > 9 ? ["cup"] : [],
    labels_seen_at: !fail && elapsedS > 9 ? { cup: startedAt + 9 } : {},
    labels_required: ["bottle", "cup", "mug", "drink", "drinking", "pill"],
    labels_satisfied: !fail && elapsedS > 9,
    labels_inflight: Math.floor(elapsedS) % 2 === 0,
    labels_last_call_at: startedAt + Math.floor(elapsedS),
  };
}

export async function demoSetDrawer(action: DrawerAction): Promise<DrawerResult> {
  await sleep(250);
  drawerUnlocked = action === "unlock";
  return { ok: true, status: 200, is_unlocked: drawerUnlocked };
}

export async function demoFetchSnapshot(cam: 0 | 1): Promise<string> {
  await sleep(150);
  const b64 =
    cam === 0
      ? synthFrame(["TRAY CAM", ejectedSlot !== null ? `slot ${ejectedSlot} ejected` : "idle"])
      : synthFrame(["FACE CAM", "patient view"]);
  // fetchSnapshot's contract is "a string usable as <img src>"; a data URI
  // satisfies it without needing object URLs.
  return `data:image/jpeg;base64,${b64}`;
}

export function demoFetchPiLogs(): LogRecord[] {
  const now = Date.now() / 1000;
  return [
    { ts: now - 2, level: "INFO", name: "demo", message: "simulation: intake state polled" },
    { ts: now - 8, level: "INFO", name: "demo", message: "simulation: pill verified" },
    { ts: now - 14, level: "INFO", name: "demo", message: `simulation: slot ${ejectedSlot ?? 0} ejected` },
    { ts: now - 20, level: "INFO", name: "demo", message: "simulation: face verified (94.2%)" },
    { ts: now - 30, level: "WARNING", name: "demo", message: "SIMULATION MODE — no hardware attached" },
  ];
}

/** Browser-native voice so the nurse still talks with zero backend. */
export async function demoSpeak(text: string): Promise<boolean> {
  try {
    if (typeof window === "undefined" || !window.speechSynthesis) return false;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}
