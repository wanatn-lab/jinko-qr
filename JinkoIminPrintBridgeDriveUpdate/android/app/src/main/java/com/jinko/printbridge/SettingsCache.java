package com.jinko.printbridge;

/** Per-service last-known-good settings. No Android or printer dependencies. */
final class SettingsCache<T> {
  static final long REFRESH_MS = 5 * 60 * 1000L;
  static final long RETRY_MS = 60 * 1000L;
  static final String REFRESH_REQUEST_KEY = "remoteSettingsRefreshRequest";

  interface Clock { long now(); }
  interface Loader<T> { T load() throws Exception; }

  private final Clock clock;
  private T value;
  private Long succeededAt;
  private Long failedAt;

  SettingsCache(T initialValue, Clock clock) {
    this.value = initialValue;
    this.clock = clock;
  }

  synchronized T refresh(Loader<T> loader, boolean force) {
    long current = clock.now();
    if (failedAt != null && current - failedAt < RETRY_MS) return value;
    if (!force && failedAt == null && succeededAt != null
        && current - succeededAt < REFRESH_MS) return value;
    try {
      T next = loader.load();
      value = next;
      succeededAt = clock.now();
      failedAt = null;
    } catch (Exception ignored) {
      // Never replace the last successful settings after an HTTP/JSON failure.
      failedAt = clock.now();
    }
    return value;
  }
}
