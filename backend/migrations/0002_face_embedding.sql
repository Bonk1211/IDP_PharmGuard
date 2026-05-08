-- Phase 3: face embedding column on patients
-- Plan: .claude/PRPs/plans/face-id-end-to-end.plan.md
-- PRD:  .claude/PRPs/prds/pharmguard.prd.md (Phase 3)
-- Idempotent: safe to re-run.

ALTER TABLE public.patients
    ADD COLUMN IF NOT EXISTS face_embedding real[];

ALTER TABLE public.patients
    DROP CONSTRAINT IF EXISTS patients_face_embedding_dim;
ALTER TABLE public.patients
    ADD CONSTRAINT patients_face_embedding_dim
        CHECK (face_embedding IS NULL OR array_length(face_embedding, 1) = 128) NOT VALID;
ALTER TABLE public.patients
    VALIDATE CONSTRAINT patients_face_embedding_dim;

CREATE INDEX IF NOT EXISTS patients_has_face_embedding_idx
    ON public.patients ((face_embedding IS NOT NULL));
