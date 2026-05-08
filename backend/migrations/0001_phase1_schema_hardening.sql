-- Phase 1: schema + telemetry hardening
-- Plan: .claude/PRPs/plans/schema-telemetry-hardening.plan.md
-- PRD:  .claude/PRPs/prds/pharmguard.prd.md (Phase 1)
-- Idempotent: safe to re-run.

-- medications: per-device identity + expiry + dose-multiplicity
ALTER TABLE public.medications
    ADD COLUMN IF NOT EXISTS dispenser_id    text,
    ADD COLUMN IF NOT EXISTS expiry_date     date,
    ADD COLUMN IF NOT EXISTS pills_per_dose  integer NOT NULL DEFAULT 1;

ALTER TABLE public.medications
    DROP CONSTRAINT IF EXISTS medications_pills_per_dose_positive;
ALTER TABLE public.medications
    ADD CONSTRAINT medications_pills_per_dose_positive
        CHECK (pills_per_dose >= 1) NOT VALID;
ALTER TABLE public.medications
    VALIDATE CONSTRAINT medications_pills_per_dose_positive;

CREATE INDEX IF NOT EXISTS medications_dispenser_id_idx
    ON public.medications (dispenser_id);
CREATE INDEX IF NOT EXISTS medications_expiry_date_idx
    ON public.medications (expiry_date);

-- adherence_logs: per-device identity + per-event vision confidence
ALTER TABLE public.adherence_logs
    ADD COLUMN IF NOT EXISTS dispenser_id      text,
    ADD COLUMN IF NOT EXISTS confidence_score  real;

ALTER TABLE public.adherence_logs
    DROP CONSTRAINT IF EXISTS adherence_logs_confidence_score_range;
ALTER TABLE public.adherence_logs
    ADD CONSTRAINT adherence_logs_confidence_score_range
        CHECK (confidence_score IS NULL OR (confidence_score >= 0.0 AND confidence_score <= 1.0)) NOT VALID;
ALTER TABLE public.adherence_logs
    VALIDATE CONSTRAINT adherence_logs_confidence_score_range;

CREATE INDEX IF NOT EXISTS adherence_logs_dispenser_id_idx
    ON public.adherence_logs (dispenser_id);
