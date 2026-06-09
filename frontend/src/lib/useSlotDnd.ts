"use client";
import { useRef, useState, useCallback } from "react";

export interface SlotDragSource {
  patientId: number;
  slot: number;
}

/**
 * Native HTML5 drag-drop for the 10-slot magazine. One source at a time.
 * Drops are accepted only within the SAME patient (same dispenser).
 * `onMove(patientId, fromSlot, toSlot)` runs the actual relocation.
 *
 * The drag source is held in a ref, NOT React state: `onDragStart` sets it
 * synchronously so the very first `onDragOver` can read it and call
 * `preventDefault()` immediately. (If we waited on a state re-render, the
 * first `dragover` events would skip `preventDefault()` and the browser would
 * reject the drop — drag works but nothing lands.) State is used only for the
 * cosmetic drag-over highlight, which is safe to update mid-drag.
 */
export function useSlotDnd(
  onMove: (patientId: number, fromSlot: number, toSlot: number) => void,
) {
  const sourceRef = useRef<SlotDragSource | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const key = (patientId: number, slot: number) => `${patientId}:${slot}`;

  const getCellDragProps = useCallback(
    (patientId: number, slot: number, isFilled: boolean) => {
      return {
        // Only filled cells can start a drag.
        draggable: isFilled,
        onDragStart: (e: React.DragEvent) => {
          sourceRef.current = { patientId, slot };
          e.dataTransfer.effectAllowed = "move";
          // Some browsers require data to be set for the drag to begin.
          e.dataTransfer.setData("text/plain", key(patientId, slot));
        },
        onDragEnd: () => {
          sourceRef.current = null;
          setOverKey(null);
        },
        onDragOver: (e: React.DragEvent) => {
          const src = sourceRef.current;
          if (!src || src.patientId !== patientId) return; // block cross-patient
          e.preventDefault(); // REQUIRED — else onDrop never fires
          e.dataTransfer.dropEffect = "move";
          setOverKey(key(patientId, slot));
        },
        onDragLeave: () => {
          setOverKey((k) => (k === key(patientId, slot) ? null : k));
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          const src = sourceRef.current;
          setOverKey(null);
          sourceRef.current = null;
          if (!src || src.patientId !== patientId) return;
          if (src.slot === slot) return; // dropped on itself
          onMove(patientId, src.slot, slot);
        },
        // Cosmetic highlight for the cell currently under the drag.
        "data-dnd-over": overKey === key(patientId, slot) ? "true" : undefined,
      };
    },
    [overKey, onMove],
  );

  return { getCellDragProps, isDragging: sourceRef.current !== null };
}
