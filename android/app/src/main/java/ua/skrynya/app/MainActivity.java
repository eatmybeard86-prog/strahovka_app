package ua.skrynya.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Обгортка над вебзастосунком «Скриня». Уся логіка, ролі й права лишаються на сервері,
 * тож у додатку доступно все те саме, що й у браузері, з тим самим логіном і паролем.
 */
public class MainActivity extends Activity {

    private static final String APP_URL = BuildConfig.APP_URL;
    private static final int REQ_STORAGE = 1;

    private WebView web;
    private View overlay;
    private TextView status;
    private ProgressBar spinner;
    private Button retry;
    private ProgressBar topProgress;

    private boolean loadFailed;
    private PendingDownload pendingDownload;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable slowHint = () -> {
        if (overlay.getVisibility() == View.VISIBLE && !loadFailed) {
            status.setText("Сервер прокидається після сну.\nЦе може тривати до хвилини…");
        }
    };

    private static final class PendingDownload {
        final String url, userAgent, contentDisposition, mimeType;
        PendingDownload(String url, String userAgent, String contentDisposition, String mimeType) {
            this.url = url; this.userAgent = userAgent;
            this.contentDisposition = contentDisposition; this.mimeType = mimeType;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        setupWebView();
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            load();
        } else {
            overlay.setVisibility(View.GONE);
        }
    }

    // ---------- Інтерфейс ----------

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void buildUi() {
        int bg = getColor(R.color.bg);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(bg);

        web = new WebView(this);
        web.setBackgroundColor(bg);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        topProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        topProgress.setMax(100);
        topProgress.setVisibility(View.GONE);
        root.addView(topProgress, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP));

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(bg);
        box.setPadding(dp(32), dp(32), dp(32), dp(32));
        box.setClickable(true);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.logo);
        box.addView(logo, new LinearLayout.LayoutParams(dp(96), dp(96)));

        TextView title = new TextView(this);
        title.setText(R.string.app_name);
        title.setTextColor(getColor(R.color.text));
        title.setTextSize(26);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, dp(12), 0, dp(20));
        box.addView(title);

        spinner = new ProgressBar(this);
        box.addView(spinner, new LinearLayout.LayoutParams(dp(40), dp(40)));

        status = new TextView(this);
        status.setTextColor(getColor(R.color.muted));
        status.setTextSize(15);
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, dp(16), 0, dp(16));
        box.addView(status);

        retry = new Button(this);
        retry.setText("Спробувати ще раз");
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(v -> load());
        box.addView(retry);

        overlay = box;
        root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // Android 15+ малює вікно під системними панелями: відступаємо від них і від клавіатури.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });

        if (Build.VERSION.SDK_INT >= 30) {
            // Однаково на всіх версіях: малюємо під панелями й самі відступаємо (див. вище).
            getWindow().setDecorFitsSystemWindows(false);
        }
        setContentView(root);
        applySystemBarIcons();
    }

    private boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    private void applySystemBarIcons() {
        if (Build.VERSION.SDK_INT >= 30 && getWindow().getInsetsController() != null) {
            int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            getWindow().getInsetsController().setSystemBarsAppearance(isNight() ? 0 : mask, mask);
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemBarIcons();
    }

    private void showLoading() {
        loadFailed = false;
        overlay.setVisibility(View.VISIBLE);
        spinner.setVisibility(View.VISIBLE);
        retry.setVisibility(View.GONE);
        status.setText("Підключення…");
        handler.removeCallbacks(slowHint);
        handler.postDelayed(slowHint, 4000);
    }

    private void showError(String message) {
        loadFailed = true;
        handler.removeCallbacks(slowHint);
        overlay.setVisibility(View.VISIBLE);
        spinner.setVisibility(View.GONE);
        retry.setVisibility(View.VISIBLE);
        status.setText(message);
    }

    private void load() {
        showLoading();
        String current = web.getUrl();
        if (current != null && isOwnUrl(Uri.parse(current))) {
            web.reload();
        } else {
            web.loadUrl(APP_URL);
        }
    }

    // ---------- WebView ----------

    private boolean isOwnUrl(Uri uri) {
        Uri base = Uri.parse(APP_URL);
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
                && base.getHost() != null && base.getHost().equalsIgnoreCase(uri.getHost());
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // тема оформлення зберігається в localStorage
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " SkrynyaAndroid/" + BuildConfig.VERSION_NAME);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isOwnUrl(uri)) return false;
                openExternally(uri);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                topProgress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                topProgress.setVisibility(View.GONE);
                handler.removeCallbacks(slowHint);
                if (!loadFailed && url != null && isOwnUrl(Uri.parse(url))) {
                    overlay.setVisibility(View.GONE);
                }
                CookieManager.getInstance().flush();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError("Немає зв'язку із сервером.\nПеревірте інтернет і спробуйте ще раз.");
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 500) {
                    showError("Сервер ще не готовий (код " + response.getStatusCode() + ").\nЗачекайте кілька секунд і спробуйте ще раз.");
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                topProgress.setProgress(newProgress);
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("OK", (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.confirm())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("Так", (d, w) -> result.confirm())
                        .setNegativeButton("Скасувати", (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
                EditText input = new EditText(MainActivity.this);
                input.setSingleLine(true);
                if (defaultValue != null) {
                    input.setText(defaultValue);
                    input.setSelection(defaultValue.length());
                }
                FrameLayout wrap = new FrameLayout(MainActivity.this);
                wrap.setPadding(dp(20), dp(8), dp(20), 0);
                wrap.addView(input);
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setView(wrap)
                        .setPositiveButton("OK", (d, w) -> result.confirm(input.getText().toString()))
                        .setNegativeButton("Скасувати", (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }
        });

        // Експорт у CSV: сервер віддає файл як вкладення, зберігаємо його в «Завантаження».
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                startDownload(new PendingDownload(url, userAgent, contentDisposition, mimeType)));
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Немає програми, щоб відкрити це посилання", Toast.LENGTH_SHORT).show();
        }
    }

    private void startDownload(PendingDownload d) {
        Uri uri = Uri.parse(d.url);
        if (!isOwnUrl(uri)) {
            openExternally(uri);
            return;
        }
        if (Build.VERSION.SDK_INT < 29
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingDownload = d;
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
            return;
        }
        try {
            String name = URLUtil.guessFileName(d.url, d.contentDisposition, d.mimeType);
            DownloadManager.Request req = new DownloadManager.Request(uri);
            String cookies = CookieManager.getInstance().getCookie(d.url);
            if (cookies != null) req.addRequestHeader("Cookie", cookies);
            if (d.userAgent != null) req.addRequestHeader("User-Agent", d.userAgent);
            if (d.mimeType != null) req.setMimeType(d.mimeType);
            req.setTitle(name);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            dm.enqueue(req);
            Toast.makeText(this, "Зберігаю " + name + " у «Завантаження»", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Не вдалося завантажити файл: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_STORAGE && pendingDownload != null) {
            PendingDownload d = pendingDownload;
            pendingDownload = null;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startDownload(d);
            } else {
                Toast.makeText(this, "Без дозволу файл не зберегти", Toast.LENGTH_LONG).show();
            }
        }
    }

    // ---------- Життєвий цикл ----------

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (overlay.getVisibility() != View.VISIBLE && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }
}
