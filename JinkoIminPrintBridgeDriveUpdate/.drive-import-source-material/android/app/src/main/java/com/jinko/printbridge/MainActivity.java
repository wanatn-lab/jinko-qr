package com.jinko.printbridge;

import com.facebook.react.ReactActivity;
import com.facebook.react.ReactActivityDelegate;
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint;
import com.facebook.react.defaults.DefaultReactActivityDelegate;

public class MainActivity extends ReactActivity {

  @Override
  protected void onResume() {
    // The React screen owns polling while it is visible.  Stop the native worker before the
    // JavaScript interval resumes so an order cannot be claimed by both paths.
    OrderPollingService.stop(this);
    super.onResume();
  }

  @Override
  protected void onPause() {
    super.onPause();
    // Starting from this user-visible activity is permitted on the D4's Android 7.  The service
    // shows a persistent notification while it keeps fetching and printing after app switching.
    OrderPollingService.start(this);
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  @Override
  protected String getMainComponentName() {
    return "JinkoIminPrintBridge";
  }

  /**
   * Returns the instance of the {@link ReactActivityDelegate}. Here we use a util class {@link
   * DefaultReactActivityDelegate} which allows you to easily enable Fabric and Concurrent React
   * (aka React 18) with two boolean flags.
   */
  @Override
  protected ReactActivityDelegate createReactActivityDelegate() {
    return new DefaultReactActivityDelegate(
        this,
        getMainComponentName(),
        // If you opted-in for the New Architecture, we enable the Fabric Renderer.
        DefaultNewArchitectureEntryPoint.getFabricEnabled());
  }
}

