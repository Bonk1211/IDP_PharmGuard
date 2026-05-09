-- Phase: agent flag → human-in-the-loop → resolve.
-- Plan: .claude/PRPs/plans/agent-flag-resolve-loop.plan.md
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.agent_flags (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind               text NOT NULL,
    severity           text NOT NULL DEFAULT 'warning',
    status             text NOT NULL DEFAULT 'open',
    title              text NOT NULL,
    detail             text,
    patient_id         bigint,
    dispenser_id       text,
    slot               smallint,
    fingerprint        text,
    payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
    detected_by        text NOT NULL DEFAULT 'heuristic',
    created_at         timestamptz NOT NULL DEFAULT now(),
    acked_at           timestamptz,
    resolved_at        timestamptz,
    resolved_by_user   text,
    resolution_note    text
);

ALTER TABLE public.agent_flags
    DROP CONSTRAINT IF EXISTS agent_flags_kind_allowed;
ALTER TABLE public.agent_flags
    ADD CONSTRAINT agent_flags_kind_allowed
        CHECK (kind IN ('missed_streak', 'low_confidence', 'trending_empty',
                        'notable_pattern')) NOT VALID;
ALTER TABLE public.agent_flags
    VALIDATE CONSTRAINT agent_flags_kind_allowed;

ALTER TABLE public.agent_flags
    DROP CONSTRAINT IF EXISTS agent_flags_status_allowed;
ALTER TABLE public.agent_flags
    ADD CONSTRAINT agent_flags_status_allowed
        CHECK (status IN ('open', 'acked', 'resolved', 'dismissed')) NOT VALID;
ALTER TABLE public.agent_flags
    VALIDATE CONSTRAINT agent_flags_status_allowed;

ALTER TABLE public.agent_flags
    DROP CONSTRAINT IF EXISTS agent_flags_severity_allowed;
ALTER TABLE public.agent_flags
    ADD CONSTRAINT agent_flags_severity_allowed
        CHECK (severity IN ('info', 'warning', 'critical')) NOT VALID;
ALTER TABLE public.agent_flags
    VALIDATE CONSTRAINT agent_flags_severity_allowed;

ALTER TABLE public.agent_flags
    DROP CONSTRAINT IF EXISTS agent_flags_detected_by_allowed;
ALTER TABLE public.agent_flags
    ADD CONSTRAINT agent_flags_detected_by_allowed
        CHECK (detected_by IN ('heuristic', 'gemini')) NOT VALID;
ALTER TABLE public.agent_flags
    VALIDATE CONSTRAINT agent_flags_detected_by_allowed;

CREATE INDEX IF NOT EXISTS agent_flags_status_idx
    ON public.agent_flags (status);
CREATE INDEX IF NOT EXISTS agent_flags_created_at_idx
    ON public.agent_flags (created_at DESC);
CREATE INDEX IF NOT EXISTS agent_flags_patient_id_idx
    ON public.agent_flags (patient_id);

-- Partial unique on (fingerprint) WHERE status='open' so re-detecting the
-- same condition while it's still open does NOT duplicate the row. Once
-- acked / resolved / dismissed it can be re-flagged.
CREATE UNIQUE INDEX IF NOT EXISTS agent_flags_open_fingerprint_uniq
    ON public.agent_flags (fingerprint)
    WHERE status = 'open' AND fingerprint IS NOT NULL;
