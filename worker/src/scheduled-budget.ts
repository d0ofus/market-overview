import type { Env } from "./types";

export type ScheduledLane = "core" | "market-data" | "scans" | "maintenance" | "reports";

export const SCHEDULED_CORE_CRON = "*/15 * * * *";
export const SCHEDULED_MARKET_DATA_CRON = "2,17,32,47 * * * *";
export const SCHEDULED_SCANS_CRON = "5,20,35,50 * * * *";
export const SCHEDULED_MAINTENANCE_CRON = "8,23,38,53 * * * *";
export const SCHEDULED_REPORTS_CRON = "11,26,41,56 * * * *";

export const SCHEDULED_CRONS = [
  SCHEDULED_CORE_CRON,
  SCHEDULED_MARKET_DATA_CRON,
  SCHEDULED_SCANS_CRON,
  SCHEDULED_MAINTENANCE_CRON,
  SCHEDULED_REPORTS_CRON,
] as const;

export function classifyScheduledCron(cron: string | null | undefined): ScheduledLane {
  switch ((cron ?? "").trim()) {
    case SCHEDULED_MARKET_DATA_CRON:
      return "market-data";
    case SCHEDULED_SCANS_CRON:
      return "scans";
    case SCHEDULED_MAINTENANCE_CRON:
      return "maintenance";
    case SCHEDULED_REPORTS_CRON:
      return "reports";
    case SCHEDULED_CORE_CRON:
    default:
      return "core";
  }
}

const DEFAULT_BUDGETS: Record<ScheduledLane, number> = {
  core: 50,
  "market-data": 35,
  scans: 30,
  maintenance: 20,
  reports: 35,
};

const LANE_BUDGET_ENV: Record<ScheduledLane, string> = {
  core: "SCHEDULED_CORE_BUDGET",
  "market-data": "SCHEDULED_MARKET_DATA_BUDGET",
  scans: "SCHEDULED_SCANS_BUDGET",
  maintenance: "SCHEDULED_MAINTENANCE_BUDGET",
  reports: "SCHEDULED_REPORTS_BUDGET",
};

function envNumber(env: Env, key: string, fallback: number): number {
  const raw = (env as unknown as Record<string, string | undefined>)[key];
  const parsed = Number(raw ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

export type ScheduledBudgetSnapshot = {
  lane: ScheduledLane;
  maxUnits: number;
  reserveUnits: number;
  usedUnits: number;
  availableUnits: number;
};

export class ScheduledBudget {
  readonly lane: ScheduledLane;
  readonly maxUnits: number;
  readonly reserveUnits: number;
  private usedUnitsValue = 0;

  constructor(lane: ScheduledLane, maxUnits: number, reserveUnits: number) {
    this.lane = lane;
    this.maxUnits = Math.max(0, Math.trunc(maxUnits));
    this.reserveUnits = Math.max(0, Math.trunc(reserveUnits));
  }

  get usedUnits(): number {
    return this.usedUnitsValue;
  }

  get availableUnits(): number {
    return Math.max(0, this.maxUnits - this.reserveUnits - this.usedUnitsValue);
  }

  canClaim(units: number): boolean {
    const cost = Math.max(0, Math.trunc(units));
    return cost <= this.availableUnits;
  }

  claim(jobKey: string, units: number): boolean {
    const cost = Math.max(0, Math.trunc(units));
    if (!this.canClaim(cost)) {
      console.warn("scheduled job skipped by budget", {
        lane: this.lane,
        jobKey,
        estimatedUnits: cost,
        usedUnits: this.usedUnitsValue,
        maxUnits: this.maxUnits,
        reserveUnits: this.reserveUnits,
      });
      return false;
    }
    this.usedUnitsValue += cost;
    return true;
  }

  snapshot(): ScheduledBudgetSnapshot {
    return {
      lane: this.lane,
      maxUnits: this.maxUnits,
      reserveUnits: this.reserveUnits,
      usedUnits: this.usedUnitsValue,
      availableUnits: this.availableUnits,
    };
  }
}

export function createScheduledBudget(env: Env, lane: ScheduledLane): ScheduledBudget {
  const maxUnits = envNumber(env, LANE_BUDGET_ENV[lane], DEFAULT_BUDGETS[lane]);
  const reserveUnits = envNumber(env, "SCHEDULED_SUBREQUEST_RESERVE", 10);
  return new ScheduledBudget(lane, maxUnits, reserveUnits);
}
