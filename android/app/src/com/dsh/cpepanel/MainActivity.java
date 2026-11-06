package com.dsh.cpepanel;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Bundle;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * CPE Pilot —— 把面板装进 WebView。
 * 页面放在 assets 里用 file:// 加载；对路由器的 ubus 请求走原生 HTTP，
 * 绕开浏览器跨域限制，所以装到手机上不用再开电脑或小服务。
 */
public class MainActivity extends Activity {
    private static final String HOME = "file:///android_asset/index.html";
    private static final int REQ_FILE = 1001;
    private WebView web;
    private ValueCallback<Uri[]> fileChooserCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setTheme(android.R.style.Theme_DeviceDefault_NoActionBar);
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#07110f"));
        window.setNavigationBarColor(Color.parseColor("#07110f"));

        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#07110f"));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                bindProcessWifi(); // 保证 LuCI 走 WiFi，而不是移动数据
                return false; // LuCI 等外链也在同一个 WebView 里打开，返回键可退回面板
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                bindProcessWifi();
                return false; // 所有 http(s) 页面都由本 WebView 加载（LuCI、面板内部链接）
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (Exception err) {
                    fileChooserCallback = null;
                    return false;
                }
            }
        });
        web.addJavascriptInterface(new Bridge(), "CpeNative");
        setContentView(web);
        bindProcessWifi();
        web.loadUrl(HOME);
    }

    /**
     * 手机常把移动数据当默认网络（WiFi 因探测被墙被判定“无互联网”），
     * 这会让发往 192.168.6.1 的请求走 4G。这里找到 WiFi 网络，
     * 用 Network.openConnection() 逐条连接绑定，避免进程级绑定被网络切换清掉。
     */
    /** 让整个进程（含 WebView 打开 LuCI）也走 WiFi；失败时逐连接绑定仍然兜底。 */
    private void bindProcessWifi() {
        try {
            Network wifi = wifiNetwork();
            if (wifi != null) {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
                cm.bindProcessToNetwork(wifi);
            }
        } catch (Exception ignored) {
            // 保持默认网络
        }
    }

    private Network wifiNetwork() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            for (Network network : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(network);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    return network;
                }
            }
        } catch (Exception ignored) {
            // 没有 WiFi 或读取失败时退回默认网络
        }
        return null;
    }

    private final class Bridge {
        @JavascriptInterface
        public void ubus(final String id, final String router, final String body) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    final String result = post(router, body);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (web == null) return;
                            web.evaluateJavascript(
                                "window.__cpeNativeResult&&window.__cpeNativeResult("
                                    + JSONObject.quote(id) + "," + JSONObject.quote(result) + ")",
                                null
                            );
                        }
                    });
                }
            }).start();
        }
    }

    private String post(String router, String body) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL("http://" + router + "/ubus");
            bindProcessWifi();
            Network wifi = wifiNetwork();
            java.net.URLConnection raw = wifi != null ? wifi.openConnection(url) : url.openConnection();
            conn = (HttpURLConnection) raw;
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Accept", "application/json");
            OutputStream out = conn.getOutputStream();
            out.write(body.getBytes(StandardCharsets.UTF_8));
            out.close();
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buffer.write(chunk, 0, n);
            in.close();
            String text = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
            if (text.trim().isEmpty()) {
                return "{\"error\":{\"message\":\"路由器返回了空内容\"}}";
            }
            return text;
        } catch (Exception err) {
            String message = err.getMessage() == null ? err.toString() : err.getMessage();
            return "{\"error\":{\"message\":" + JSONObject.quote("连不上路由器：" + message) + "}}";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            if (fileChooserCallback != null) {
                fileChooserCallback.onReceiveValue(result);
                fileChooserCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("CpeNative");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
