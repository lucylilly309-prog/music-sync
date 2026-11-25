package com.syncpair.app;

import android.content.SharedPreferences;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Bridge between the web app and the home-screen widget: the app hands over the server address + account token. */
@CapacitorPlugin(name = "SyncPairWidget")
public class SyncPairWidgetPlugin extends Plugin {

  @PluginMethod
  public void configure(PluginCall call) {
    String baseUrl = call.getString("baseUrl");
    String token = call.getString("token");
    if (baseUrl == null || token == null || !baseUrl.startsWith("http")) {
      call.reject("baseUrl and token are required");
      return;
    }
    SharedPreferences.Editor editor = SyncPairWidgetProvider.prefs(getContext()).edit();
    editor.putString("baseUrl", baseUrl.replaceAll("/+$", ""));
    editor.putString("token", token);
    editor.apply();
    SyncPairWidgetProvider.requestUpdate(getContext());
    call.resolve();
  }

  @PluginMethod
  public void refresh(PluginCall call) {
    SyncPairWidgetProvider.requestUpdate(getContext());
    call.resolve();
  }

  @PluginMethod
  public void clear(PluginCall call) {
    SyncPairWidgetProvider.prefs(getContext()).edit().clear().apply();
    SyncPairWidgetProvider.requestUpdate(getContext());
    call.resolve();
  }
}
