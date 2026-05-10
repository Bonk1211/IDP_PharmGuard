/**
 * Shared SWR keys, intervals, and typed hooks for dashboard data.
 *
 * All dashboard panels go through these hooks so the same fetch is
 * deduped across components on the same page (e.g. logs are read by
 * the dashboard stats, IntakeLog, and FloorMap — one HTTP call serves
 * all three thanks to the SWR cache key).
 */

import useSWR, { type SWRConfiguration } from "swr";
import {
  fetchAllSlots,
  fetchAlerts,
  fetchLogs,
  fetchPatients,
  type Alert,
  type IntakeRecord,
  type Patient,
  type SlotInfo,
} from "./api";
import {
  fetchLatestBrief,
  fetchOpenFlags,
  type AgentBrief,
  type AgentFlag,
} from "./agent";

export const KEYS = {
  slots: "slots:all",
  logs: "logs:all",
  patients: "patients:all",
  alerts: "alerts:recent",
  flags: "flags:open",
  brief: "brief:latest",
} as const;

const SECOND = 1000;
export const INTERVAL = {
  flags: 30 * SECOND,
  alerts: 60 * SECOND,
  logs: 30 * SECOND,
  slots: 60 * SECOND,
  patients: 5 * 60 * SECOND,
  brief: 0,
} as const;

const baseConfig: SWRConfiguration = {
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  dedupingInterval: 5 * SECOND,
  keepPreviousData: true,
};

export function useSlots() {
  return useSWR<SlotInfo[]>(KEYS.slots, fetchAllSlots, {
    ...baseConfig,
    refreshInterval: INTERVAL.slots,
    fallbackData: [],
  });
}

export function useLogs() {
  return useSWR<IntakeRecord[]>(KEYS.logs, fetchLogs, {
    ...baseConfig,
    refreshInterval: INTERVAL.logs,
    fallbackData: [],
  });
}

export function usePatients() {
  return useSWR<Patient[]>(KEYS.patients, fetchPatients, {
    ...baseConfig,
    refreshInterval: INTERVAL.patients,
    fallbackData: [],
  });
}

export function useAlerts() {
  return useSWR<Alert[]>(KEYS.alerts, () => fetchAlerts(), {
    ...baseConfig,
    refreshInterval: INTERVAL.alerts,
    fallbackData: [],
  });
}

export function useOpenFlags() {
  return useSWR<AgentFlag[]>(KEYS.flags, () => fetchOpenFlags(), {
    ...baseConfig,
    refreshInterval: INTERVAL.flags,
    fallbackData: [],
  });
}

export function useLatestBrief() {
  return useSWR<AgentBrief | null>(KEYS.brief, fetchLatestBrief, {
    ...baseConfig,
    refreshInterval: INTERVAL.brief,
  });
}
