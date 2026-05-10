-- Add per-slot daily dispense schedule.
-- NULL = manual-only (default). When set, the cycle's manual-mode tick
-- watches for the current HH:MM matching this column and auto-fires that slot.

ALTER TABLE public.medications
ADD COLUMN IF NOT EXISTS schedule_at TIME NULL;

COMMENT ON COLUMN public.medications.schedule_at IS
  'Daily dispense time (HH:MM:SS). NULL = manual-only. When set and the
   current minute matches, the cycle auto-fires this slot.';
