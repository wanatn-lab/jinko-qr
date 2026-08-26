package com.jinko.printbridge;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Fetches the optional receipt logo once and keeps a small in-memory copy for later bills.
 * A failed logo must never fail or delay a food-order receipt, so every error simply returns null.
 */
final class ReceiptAssets {
  private static final int CONNECT_TIMEOUT_MS = 4000;
  private static final int READ_TIMEOUT_MS = 6000;
  private static String cachedUrl = "";
  private static Bitmap cachedLogo;

  private ReceiptAssets() {}

  static synchronized Bitmap logo(String rawUrl, int printableWidth) {
    String url = rawUrl == null ? "" : rawUrl.trim();
    if (url.isEmpty() || !(url.startsWith("https://") || url.startsWith("http://"))) return null;
    if (url.equals(cachedUrl) && cachedLogo != null && !cachedLogo.isRecycled()) return cachedLogo;

    HttpURLConnection connection = null;
    InputStream stream = null;
    try {
      connection = (HttpURLConnection) new URL(url).openConnection();
      connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
      connection.setReadTimeout(READ_TIMEOUT_MS);
      connection.setInstanceFollowRedirects(true);
      connection.setRequestProperty("Accept", "image/*");
      if (connection.getResponseCode() < 200 || connection.getResponseCode() >= 300) return null;
      stream = connection.getInputStream();
      Bitmap decoded = BitmapFactory.decodeStream(stream);
      if (decoded == null) return null;

      int maxWidth = Math.max(160, Math.min(printableWidth - 48, 260));
      int maxHeight = 150;
      float scale = Math.min(1f, Math.min((float) maxWidth / decoded.getWidth(),
          (float) maxHeight / decoded.getHeight()));
      Bitmap scaled = scale < 0.999f
          ? Bitmap.createScaledBitmap(decoded, Math.round(decoded.getWidth() * scale),
              Math.round(decoded.getHeight() * scale), true)
          : decoded;
      if (scaled != decoded) decoded.recycle();
      // iMin's bitmap API ignores setAlignment() and starts every bitmap at x=0. Pad the logo
      // to the complete printable width here, with a white background, so it is physically
      // centred on the 80 mm roll regardless of the SDK's bitmap alignment behaviour.
      Bitmap centred = Bitmap.createBitmap(printableWidth, scaled.getHeight(), Bitmap.Config.ARGB_8888);
      Canvas canvas = new Canvas(centred);
      canvas.drawColor(Color.WHITE);
      canvas.drawBitmap(scaled, Math.max(0, (printableWidth - scaled.getWidth()) / 2f), 0, null);
      if (!scaled.isRecycled()) scaled.recycle();
      if (cachedLogo != null && !cachedLogo.isRecycled()) cachedLogo.recycle();
      cachedLogo = centred;
      cachedUrl = url;
      return cachedLogo;
    } catch (Exception ignored) {
      return null;
    } finally {
      try {
        if (stream != null) stream.close();
      } catch (Exception ignored) {
        // Best effort only.
      }
      if (connection != null) connection.disconnect();
    }
  }
}
