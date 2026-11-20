package com.deadzone.game;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Deadzone as an app: the live game, full screen, landscape, screen kept on. Controllers reach the
 * game through the browser's gamepad support, and sound plays without a tap first. Voice chat gets
 * the microphone: Android asks once, the first time you talk.
 */
public class MainActivity extends Activity {
    private static final String GAME = "https://deadzone-server-production-c9ff7400.up.railway.app/";
    private WebView web;
    private static final int MIC = 7;
    private PermissionRequest pendingMic;   // the game's request for the microphone, waiting on Android's answer

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                    // keeps your character on this device
        s.setMediaPlaybackRequiresUserGesture(false);    // sound starts without touching the screen
        s.setUserAgentString(s.getUserAgentString() + " DeadzoneApp/1");
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(() -> {
                    boolean audio = false;
                    for (String r : req.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
                    if (!audio) { req.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        req.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                    } else {
                        if (pendingMic != null) pendingMic.deny();
                        pendingMic = req;
                        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, MIC);
                    }
                });
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                // Stay in the app for the game itself (lobby, worlds, invite links).
                return !Uri.parse(GAME).getHost().equals(req.getUrl().getHost());
            }
        });
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        setContentView(web);
        web.requestFocus();
        if (saved != null) web.restoreState(saved);
        else web.loadUrl(GAME);
        fullScreen();
    }

    private void fullScreen() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) fullScreen();
    }

    /** The controller's B button is "back" to Android, but in the game it crouches (see dispatchKeyEvent for the way out). */
    @Override
    public void onBackPressed() { }

    private static final long HOLD_MS = 800;   // how long to hold the remote's Back to leave the game
    private boolean leftOnHold;

    /**
     * The TV remote has no Home button on every setup, so the remote's Back gets a way out:
     * a tap closes the open menu (like Esc), holding it goes to the Shield's home screen.
     * The controller's Xbox button also goes home. The controller's B still only crouches.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int key = e.getKeyCode();
        if (key == KeyEvent.KEYCODE_BUTTON_MODE) {
            if (e.getAction() == KeyEvent.ACTION_UP) moveTaskToBack(true);
            return true;
        }
        if (key != KeyEvent.KEYCODE_BACK || fromController(e)) return super.dispatchKeyEvent(e);
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            if (e.getRepeatCount() == 0) leftOnHold = false;
            else if (!leftOnHold && (e.isLongPress() || e.getEventTime() - e.getDownTime() >= HOLD_MS)) {
                leftOnHold = true;
                moveTaskToBack(true);
            }
        } else if (e.getAction() == KeyEvent.ACTION_UP && !leftOnHold && !e.isCanceled()) {
            web.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ESCAPE));
            web.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ESCAPE));
        }
        return true;
    }

    private static boolean fromController(KeyEvent e) {
        int src = e.getSource();
        return (src & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
            || (src & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != MIC || pendingMic == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) pendingMic.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        else pendingMic.deny();
        pendingMic = null;
    }

    @Override
    protected void onPause() { super.onPause(); web.onPause(); }

    @Override
    protected void onResume() { super.onResume(); web.onResume(); fullScreen(); }
}
