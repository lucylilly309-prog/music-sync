package com.syncpair.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Home-screen widget: partner's local time, status, what they are playing, the countdown to the next visit and
 * one-tap pings. It polls GET /api/widget with the account token the app stored (SyncPairWidgetPlugin), every
 * 30 minutes, whenever the app asks for a refresh, and after each ping button press.
 */
public class SyncPairWidgetProvider extends AppWidgetProvider {
  static final String PREFS = "syncpair_widget";
  static final String ACTION_PING = "com.syncpair.app.WIDGET_PING";
  static final String ACTION_REFRESH = "com.syncpair.app.WIDGET_REFRESH";
  static final String EXTRA_KIND = "kind";

  static SharedPreferences prefs(Context context) {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  /** Explicit broadcast to this receiver (works without an intent filter, and is not visible to other apps). */
  static void requestUpdate(Context context) {
    Intent intent = new Intent(context, SyncPairWidgetProvider.class);
    intent.setAction(ACTION_REFRESH);
    context.sendBroadcast(intent);
  }

  @Override
  public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
    refreshAsync(context, goAsync(), null);
  }

  @Override
  public void onReceive(Context context, Intent intent) {
    String action = intent.getAction();
    if (ACTION_PING.equals(action)) {
      refreshAsync(context, goAsync(), intent.getStringExtra(EXTRA_KIND));
      return;
    }
    if (ACTION_REFRESH.equals(action)) {
      refreshAsync(context, goAsync(), null);
      return;
    }
    super.onReceive(context, intent);
  }

  private static boolean isPingKind(String kind) {
    return "think".equals(kind) || "miss".equals(kind) || "night".equals(kind);
  }

  private static void refreshAsync(final Context context, final BroadcastReceiver.PendingResult pending, final String pingKind) {
    final Context app = context.getApplicationContext();
    new Thread(new Runnable() {
      @Override
      public void run() {
        boolean stale = false;
        try {
          SharedPreferences p = prefs(app);
          String base = p.getString("baseUrl", null);
          String token = p.getString("token", null);
          if (base != null && token != null) {
            if (isPingKind(pingKind)) {
              request(base + "/api/ping", token, "POST", "{\"kind\":\"" + pingKind + "\"}");
            }
            String json = request(base + "/api/widget", token, "GET", null);
            if (json != null) {
              p.edit().putString("snapshot", json).apply();
            } else {
              stale = true;
            }
          }
          render(app, stale);
        } catch (Exception e) {
          try {
            render(app, true);
          } catch (Exception ignored) {
            // nothing more to do: the widget keeps showing what it had
          }
        } finally {
          if (pending != null) {
            pending.finish();
          }
        }
      }
    }).start();
  }

  /** Returns the response body for a 2xx answer, otherwise null. */
  private static String request(String address, String token, String method, String body) {
    HttpURLConnection conn = null;
    try {
      conn = (HttpURLConnection) new URL(address).openConnection();
      conn.setRequestMethod(method);
      conn.setConnectTimeout(8000);
      conn.setReadTimeout(8000);
      conn.setRequestProperty("Authorization", "Bearer " + token);
      if (body != null) {
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        OutputStream out = conn.getOutputStream();
        out.write(body.getBytes(StandardCharsets.UTF_8));
        out.close();
      }
      int code = conn.getResponseCode();
      if (code < 200 || code >= 300) {
        return null;
      }
      BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
      StringBuilder sb = new StringBuilder();
      String line;
      while ((line = reader.readLine()) != null) {
        sb.append(line);
      }
      reader.close();
      return sb.toString();
    } catch (Exception e) {
      return null;
    } finally {
      if (conn != null) {
        conn.disconnect();
      }
    }
  }

  /** Whole calendar days from today to a yyyy-MM-dd date (negative once it has passed); Long.MIN_VALUE if unreadable. */
  private static long daysUntil(String day) {
    try {
      SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
      format.setLenient(false);
      Date target = format.parse(day);
      Calendar today = Calendar.getInstance();
      today.set(Calendar.HOUR_OF_DAY, 0);
      today.set(Calendar.MINUTE, 0);
      today.set(Calendar.SECOND, 0);
      today.set(Calendar.MILLISECOND, 0);
      return Math.round((target.getTime() - today.getTimeInMillis()) / 86400000.0);
    } catch (Exception e) {
      return Long.MIN_VALUE;
    }
  }

  private static void setLine(RemoteViews views, int id, String text) {
    views.setTextViewText(id, text);
    views.setViewVisibility(id, text.isEmpty() ? View.GONE : View.VISIBLE);
  }

  private static PendingIntent pingIntent(Context context, String kind, int requestCode) {
    Intent intent = new Intent(context, SyncPairWidgetProvider.class);
    intent.setAction(ACTION_PING);
    intent.putExtra(EXTRA_KIND, kind);
    return PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private static void render(Context context, boolean stale) throws Exception {
    AppWidgetManager manager = AppWidgetManager.getInstance(context);
    int[] ids = manager.getAppWidgetIds(new ComponentName(context, SyncPairWidgetProvider.class));
    if (ids == null || ids.length == 0) {
      return;
    }
    SharedPreferences p = prefs(context);
    String snapshot = p.getString("snapshot", null);
    String title = "SyncPair";
    String time = "";
    String status = "";
    String music = "";
    String count = "";

    if (p.getString("token", null) == null) {
      status = "Open the app to sign in";
    } else if (snapshot == null) {
      status = "Loading…";
    } else {
      JSONObject j = new JSONObject(snapshot);
      if (!j.optBoolean("paired")) {
        status = "Pair with your partner in the app";
      } else {
        title = (j.optBoolean("online") ? "🟢 " : "⚪ ") + j.optString("name", "Partner");
        String tz = j.optString("tz", "");
        if (!tz.isEmpty()) {
          TimeZone zone = TimeZone.getTimeZone(tz);
          SimpleDateFormat clock = new SimpleDateFormat("HH:mm", Locale.getDefault());
          clock.setTimeZone(zone);
          int hour = Calendar.getInstance(zone).get(Calendar.HOUR_OF_DAY);
          time = "🕒 " + clock.format(new Date()) + ((hour >= 23 || hour < 6) ? " · probably asleep" : "");
        }
        JSONObject st = j.optJSONObject("status");
        if (st != null) {
          status = (st.optString("emoji", "") + " " + st.optString("text", "")).trim();
        }
        JSONObject np = j.optJSONObject("nowPlaying");
        if (np != null) {
          String artist = np.optString("artist", "");
          music = (np.optBoolean("isPlaying") ? "🎵 " : "⏸ ") + np.optString("title", "") + (artist.isEmpty() ? "" : " · " + artist);
        }
        JSONObject cd = j.optJSONObject("countdown");
        if (cd != null) {
          long days = daysUntil(cd.optString("date", ""));
          String label = cd.optString("label", "Next visit");
          if (days > 0) {
            count = "⏳ " + days + (days == 1 ? " day" : " days") + " until " + label;
          } else if (days == 0) {
            count = "🎉 Today: " + label;
          }
        }
      }
    }
    if (stale) {
      title = title + " · offline";
    }

    RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.syncpair_widget);
    views.setTextViewText(R.id.w_name, title);
    setLine(views, R.id.w_time, time);
    setLine(views, R.id.w_status, status);
    setLine(views, R.id.w_music, music);
    setLine(views, R.id.w_count, count);
    views.setOnClickPendingIntent(R.id.w_btn_think, pingIntent(context, "think", 1));
    views.setOnClickPendingIntent(R.id.w_btn_miss, pingIntent(context, "miss", 2));
    views.setOnClickPendingIntent(R.id.w_btn_night, pingIntent(context, "night", 3));
    Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
    if (launch != null) {
      views.setOnClickPendingIntent(R.id.w_root, PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    }
    manager.updateAppWidget(ids, views);
  }
}
