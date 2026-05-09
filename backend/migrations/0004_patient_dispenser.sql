-- Phase: assign each patient to a dispenser. Lets the dashboard navigate
-- patient -> /dispensers/<dispenser_id>/ for the live stream + game UI.
-- Nullable: a patient may be unassigned; UI treats null as "(none)".

ALTER TABLE public.patients
    ADD COLUMN IF NOT EXISTS dispenser_id text;

CREATE INDEX IF NOT EXISTS patients_dispenser_id_idx
    ON public.patients (dispenser_id);
