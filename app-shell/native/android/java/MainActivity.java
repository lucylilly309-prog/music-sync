package com.syncpair.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(SyncPairWidgetPlugin.class); // must happen before super.onCreate
    super.onCreate(savedInstanceState);
  }
}
