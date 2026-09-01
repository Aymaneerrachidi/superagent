/** The stages shown while an analysis runs. */
export const STAGES = [
  { key: "verifying_token", label: "Verifying token" },
  { key: "checking_market", label: "Checking market movement" },
  { key: "researching_narrative", label: "Researching narrative and socials" },
  { key: "checking_wallets", label: "Checking creator and wallet activity" },
  { key: "verifying_evidence", label: "Verifying evidence" },
  { key: "building_report", label: "Building report" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];
