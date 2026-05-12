-- Phase: AWS Rekognition face-verify reference image (Layer-1)
-- Plan: .claude/PRPs/plans/patient-face-verify-rekognition.plan.md
-- Idempotent.
--
-- Stores the Supabase Storage public URL of each patient's reference
-- face photo. Read by POST /api/device/verify_face (downloads the bytes
-- and feeds them as SourceImage to Rekognition CompareFaces).

ALTER TABLE public.patients
    ADD COLUMN IF NOT EXISTS face_reference_url text;

CREATE INDEX IF NOT EXISTS patients_has_face_reference_idx
    ON public.patients ((face_reference_url IS NOT NULL));
