package com.jinko.printbridge;

import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.LinkedHashSet;
import java.util.Set;

/** Shared, process-wide ticket history and short-lived claims for UI/background hand-off. */
final class PrintHistory {
  static final String PREFS = "jinko_print_bridge";
  private static final String PRINTED_KEYS = "printed_keys";
  private static final String CLAIMED_KEYS = "claimed_keys";
  private static final int MAX_PRINTED_KEYS = 500;
  // A claim only covers the short period in which a ticket is actively being sent to a printer.
  // It expires after a crash so a later poll can safely retry the order.
  private static final long CLAIM_TTL_MS = 120_000L;
  private static final Object LOCK = new Object();

  private PrintHistory() {}

  static Set<String> getPrintedKeys(SharedPreferences preferences) {
    synchronized (LOCK) {
      return readPrinted(preferences);
    }
  }

  static boolean claim(SharedPreferences preferences, String key) {
    synchronized (LOCK) {
      if (key == null || key.trim().isEmpty() || readPrinted(preferences).contains(key)) return false;
      JSONObject claims = readClaims(preferences);
      pruneExpiredClaims(claims);
      if (claims.has(key)) {
        saveClaims(preferences, claims);
        return false;
      }
      try {
        claims.put(key, System.currentTimeMillis());
      } catch (JSONException ignored) {
        return false;
      }
      saveClaims(preferences, claims);
      return true;
    }
  }

  static void release(SharedPreferences preferences, String key) {
    synchronized (LOCK) {
      JSONObject claims = readClaims(preferences);
      claims.remove(key);
      saveClaims(preferences, claims);
    }
  }

  static void markPrinted(SharedPreferences preferences, String key) {
    synchronized (LOCK) {
      LinkedHashSet<String> printed = readPrinted(preferences);
      printed.remove(key);
      printed.add(key);
      while (printed.size() > MAX_PRINTED_KEYS) printed.remove(printed.iterator().next());
      JSONObject claims = readClaims(preferences);
      claims.remove(key);
      preferences.edit()
          .putString(PRINTED_KEYS, toJson(printed).toString())
          .putString(CLAIMED_KEYS, claims.toString())
          .apply();
    }
  }

  static void clear(SharedPreferences preferences) {
    synchronized (LOCK) {
      preferences.edit().remove(PRINTED_KEYS).remove(CLAIMED_KEYS).apply();
    }
  }

  private static LinkedHashSet<String> readPrinted(SharedPreferences preferences) {
    LinkedHashSet<String> keys = new LinkedHashSet<>();
    try {
      JSONArray array = new JSONArray(preferences.getString(PRINTED_KEYS, "[]"));
      for (int index = 0; index < array.length(); index++) keys.add(array.getString(index));
    } catch (JSONException ignored) {
      // A damaged local history must not block a new customer order.
    }
    return keys;
  }

  private static JSONObject readClaims(SharedPreferences preferences) {
    try {
      return new JSONObject(preferences.getString(CLAIMED_KEYS, "{}"));
    } catch (JSONException ignored) {
      return new JSONObject();
    }
  }

  private static void pruneExpiredClaims(JSONObject claims) {
    long threshold = System.currentTimeMillis() - CLAIM_TTL_MS;
    JSONArray names = claims.names();
    if (names == null) return;
    for (int index = 0; index < names.length(); index++) {
      String key = names.optString(index);
      if (claims.optLong(key, 0L) < threshold) claims.remove(key);
    }
  }

  private static void saveClaims(SharedPreferences preferences, JSONObject claims) {
    preferences.edit().putString(CLAIMED_KEYS, claims.toString()).apply();
  }

  private static JSONArray toJson(Set<String> keys) {
    JSONArray array = new JSONArray();
    for (String key : keys) array.put(key);
    return array;
  }
}

