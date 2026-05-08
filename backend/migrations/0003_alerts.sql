-- Phase 5: alerts pipeline (sensor + expiry + low-stock)
-- Plan: .claude/PRPs/plans/sensors-alerts.plan.md
-- PRD:  .claude/PRPs/prds/pharmguard.prd.md (Phase 5)
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.alerts (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dispenser_id  text,
    kind          text NOT NULL,
    severity      text NOT NULL DEFAULT 'info',
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.alerts
    DROP CONSTRAINT IF EXISTS alerts_kind_allowed;
ALTER TABLE public.alerts
    ADD CONSTRAINT alerts_kind_allowed
        CHECK (kind IN ('expiry', 'low_stock', 'over_temperature')) NOT VALID;
ALTER TABLE public.alerts
    VALIDATE CONSTRAINT alerts_kind_allowed;

ALTER TABLE public.alerts
    DROP CONSTRAINT IF EXISTS alerts_severity_allowed;
ALTER TABLE public.alerts
    ADD CONSTRAINT alerts_severity_allowed
        CHECK (severity IN ('info', 'warning', 'critical')) NOT VALID;
ALTER TABLE public.alerts
    VALIDATE CONSTRAINT alerts_severity_allowed;

CREATE INDEX IF NOT EXISTS alerts_created_at_idx
    ON public.alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS alerts_dispenser_id_idx
    ON public.alerts (dispenser_id);
CREATE INDEX IF NOT EXISTS alerts_kind_idx
    ON public.alerts (kind);
