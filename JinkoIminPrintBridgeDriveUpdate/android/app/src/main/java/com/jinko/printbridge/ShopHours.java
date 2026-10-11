package com.jinko.printbridge;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

final class ShopHours {
  private static final TimeZone BANGKOK_FIXED = TimeZone.getTimeZone("GMT+07:00");
  private static final int OPEN_MINUTE = 11 * 60 + 20;
  private static final int CLOSE_MINUTE = 21 * 60;
  private static final int CLOSE_GRACE_MINUTES = 60;
  private static final int SPECIAL_FROM_MINUTE = 10 * 60;
  private static final long SPECIAL_CHECK_INTERVAL_MS = 5 * 60 * 1000L;

  private ShopHours() {}

  static boolean isShopOpen(Date now, String specialOpenDate) {
    Parts parts = parts(now);
    return parts.minute >= OPEN_MINUTE && parts.minute < CLOSE_MINUTE
        && !isNormalMonday(parts, specialOpenDate);
  }

  static boolean canPollOrders(Date now, String specialOpenDate) {
    Parts parts = parts(now);
    if (isNormalMonday(parts, specialOpenDate)) return false;
    return (parts.minute >= OPEN_MINUTE && parts.minute < CLOSE_MINUTE)
        || (parts.minute >= CLOSE_MINUTE && parts.minute < CLOSE_MINUTE + CLOSE_GRACE_MINUTES);
  }

  static boolean shouldCheckSpecialOpen(Date now) {
    Parts parts = parts(now);
    return parts.weekday == Calendar.MONDAY
        && parts.minute >= SPECIAL_FROM_MINUTE && parts.minute < CLOSE_MINUTE;
  }

  static boolean isSpecialCheckDue(Date now, long lastCheckedAt) {
    return shouldCheckSpecialOpen(now)
        && (lastCheckedAt <= 0 || now.getTime() - lastCheckedAt >= SPECIAL_CHECK_INTERVAL_MS);
  }

  static String dateKey(Date now) {
    return parts(now).date;
  }

  private static boolean isNormalMonday(Parts parts, String specialOpenDate) {
    return parts.weekday == Calendar.MONDAY && !parts.date.equals(specialOpenDate);
  }

  private static Parts parts(Date now) {
    Calendar calendar = Calendar.getInstance(BANGKOK_FIXED, Locale.US);
    calendar.setTime(now);
    int minute = calendar.get(Calendar.HOUR_OF_DAY) * 60 + calendar.get(Calendar.MINUTE);
    SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
    formatter.setTimeZone(BANGKOK_FIXED);
    String date = formatter.format(now);
    return new Parts(calendar.get(Calendar.DAY_OF_WEEK), date, minute);
  }

  private static final class Parts {
    final int weekday;
    final String date;
    final int minute;
    Parts(int weekday, String date, int minute) {
      this.weekday = weekday;
      this.date = date;
      this.minute = minute;
    }
  }
}
