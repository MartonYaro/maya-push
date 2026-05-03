/**
 * Per-user limits to protect AppTweak credits + prevent abuse.
 * Override via env vars when needed (e.g. premium customers).
 */
export const LIMITS = {
  maxAppsPerUser:        +process.env.MAX_APPS_PER_USER        || 10,
  maxKeywordsPerApp:     +process.env.MAX_KEYWORDS_PER_APP     || 50,
  maxKeywordsPerUserDay: +process.env.MAX_KW_PER_USER_DAY      || 100,
  // Anti-fraud: cap installs per keyword per day even if user has balance.
  // Apple's anti-fraud detects > N installs per keyword/day → ban risk.
  maxInstallsPerKwDay:   +process.env.MAX_INSTALLS_PER_KW_DAY  || 5000,
};
