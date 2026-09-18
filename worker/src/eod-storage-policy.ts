import { resolveEodBudgetProfile } from "./eod-budget-profile";

/** Application safeguards, deliberately below the platform's Paid limits. */
export function eodStoragePolicy(profile?: string) {
  return resolveEodBudgetProfile(profile).name === "paid"
    ? { version: "paid-daily-v2", databaseTargetBytes: 2_000_000_000, databaseStopBytes: 2_000_000_000,
      databaseWarningBytes: 1_750_000_000, databaseCriticalBytes: 1_900_000_000,
      accountWarningBytes: 3_500_000_000, accountOptionalStopBytes: 4_500_000_000 }
    : { version: "free-v1", databaseTargetBytes: 350_000_000, databaseStopBytes: 400_000_000,
      databaseWarningBytes: 350_000_000, databaseCriticalBytes: 375_000_000,
      accountWarningBytes: 4_000_000_000, accountOptionalStopBytes: 4_500_000_000 };
}
