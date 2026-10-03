package com.jinko.printbridge;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;

/**
 * Schedules the Bridge UI to open one minute after Android has completed booting.
 *
 * A BroadcastReceiver must return promptly, so this deliberately uses AlarmManager instead of
 * Handler.postDelayed(). A receiver-owned Handler can be killed by Android before its one-minute
 * delay has elapsed.
 */
public final class BootReceiver extends BroadcastReceiver {
  static final long AUTO_START_DELAY_MS = 60_000L;
  private static final int AUTO_START_REQUEST_CODE = 1001;

  @Override
  public void onReceive(Context context, Intent intent) {
    if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;

    Intent launchIntent = new Intent(context, MainActivity.class)
        .setAction("com.jinko.printbridge.action.AUTO_START")
        .addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
        );

    int pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      pendingIntentFlags |= PendingIntent.FLAG_IMMUTABLE;
    }

    PendingIntent launchApp = PendingIntent.getActivity(
        context,
        AUTO_START_REQUEST_CODE,
        launchIntent,
        pendingIntentFlags
    );

    AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    if (alarmManager == null) return;

    // An OEM may replay BOOT_COMPLETED; retain just one scheduled launch in that case.
    alarmManager.cancel(launchApp);
    long triggerAt = SystemClock.elapsedRealtime() + AUTO_START_DELAY_MS;

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      alarmManager.setAndAllowWhileIdle(
          AlarmManager.ELAPSED_REALTIME_WAKEUP,
          triggerAt,
          launchApp
      );
    } else {
      alarmManager.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, launchApp);
    }
  }
}
