export const SETTINGS_REFRESH_MS = 5 * 60 * 1000;
export const SETTINGS_RETRY_MS = 60 * 1000;

/** Per-instance cache. Force bypasses freshness, never the failure cooldown. */
export function createSettingsCache<T>(now: () => number = Date.now) {
  let value: T | null = null;
  let succeededAt: number | null = null;
  let failedAt: number | null = null;
  let refreshing: Promise<T | null> | null = null;

  async function refresh(
    load: () => Promise<T>,
    force = false,
  ): Promise<T | null> {
    if (refreshing) {
      return refreshing;
    }
    const current = now();
    if (failedAt !== null && current - failedAt < SETTINGS_RETRY_MS) {
      return value;
    }
    if (
      !force &&
      failedAt === null &&
      succeededAt !== null &&
      current - succeededAt < SETTINGS_REFRESH_MS
    ) {
      return value;
    }
    const request = (async () => {
      try {
        const next = await load();
        value = next;
        succeededAt = now();
        failedAt = null;
      } catch {
        failedAt = now();
      }
      return value;
    })();
    refreshing = request;
    try {
      return await request;
    } finally {
      refreshing = null;
    }
  }

  return {refresh};
}
