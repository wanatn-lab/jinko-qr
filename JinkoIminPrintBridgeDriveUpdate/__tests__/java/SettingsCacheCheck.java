package com.jinko.printbridge;

/** Run with javac/Java17 alongside SettingsCache.java; no real HTTP calls. */
public final class SettingsCacheCheck {
  private static long now;
  private static int checks;
  private static final class Design {
    final int paperWidthMm;
    final String receiptTitle;
    Design(int width, String title) { paperWidthMm = width; receiptTitle = title; }
  }
  private static final class MockFetch implements SettingsCache.Loader<Design> {
    int requests;
    boolean offline;
    Design next = new Design(58, "Last successful");
    @Override public Design load() throws Exception {
      requests++;
      if (offline) throw new Exception("HTTP/JSON failure");
      return next;
    }
  }
  private static void check(boolean condition, String label) {
    if (!condition) throw new AssertionError(label);
    checks++;
  }
  public static void main(String[] args) {
    SettingsCache.Clock clock = new SettingsCache.Clock() {
      @Override public long now() { return now; }
    };
    MockFetch fetch = new MockFetch();
    SettingsCache<Design> cache = new SettingsCache<>(null, clock);
    Design first = cache.refresh(fetch, false);
    check(first.paperWidthMm == 58 && first.receiptTitle.equals("Last successful"), "print values");
    for (now = 6000; now < 300000; now += 6000) {
      check(cache.refresh(fetch, false) == first, "cached identity");
    }
    check(fetch.requests == 1, "one settings request before five minutes");
    now = 300000;
    cache.refresh(fetch, false);
    check(fetch.requests == 2, "refresh at five minutes");
    now = 306000;
    fetch.next = new Design(80, "Manual refresh");
    check(cache.refresh(fetch, true) == fetch.next, "manual force refresh");
    check(fetch.requests == 3, "force fetch count");
    now = 312000;
    fetch.offline = true;
    Design latest = cache.refresh(fetch, true);
    check(latest == fetch.next && latest.paperWidthMm == 80, "failed refresh preserves width and receipt");
    now = 371999;
    check(cache.refresh(fetch, true) == latest, "force respects failure cooldown");
    check(fetch.requests == 4, "no retry before 60 seconds");
    fetch.offline = false;
    fetch.next = new Design(58, "Recovered");
    now = 372000;
    check(cache.refresh(fetch, false) == fetch.next, "automatic retry at 60 seconds");
    check(fetch.requests == 5, "retry count");
    now = 671999;
    cache.refresh(fetch, false);
    check(fetch.requests == 5, "freshness anchored to latest success");
    now = 672000;
    cache.refresh(fetch, false);
    check(fetch.requests == 6, "next five minute expiry");
    SettingsCache<Design> startup = new SettingsCache<>(null, clock);
    fetch.offline = true;
    check(startup.refresh(fetch, false) == null, "startup failure fallback unchanged");
    int before = fetch.requests;
    now += 59999;
    startup.refresh(fetch, true);
    check(fetch.requests == before, "startup failure throttled");
    now++;
    fetch.offline = false;
    check(startup.refresh(fetch, false) == fetch.next, "startup recovery at 60 seconds");
    System.out.println("SettingsCache Java: " + checks + " assertions passed");
  }
}
