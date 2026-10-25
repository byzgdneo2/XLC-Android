package com.xlc.launcher

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader

/**
 * XLC 安卓端宿主页面。
 *
 * 界面直接复用桌面端的 src/index.html + styles.css + renderer.js，
 * 放在 assets/web/ 下（由 sync-web.sh 从桌面工程同步），
 * 经 WebViewAssetLoader 以 https 源承载 —— 这样 index.html 里的
 * CSP `default-src 'self'` 才能正常生效，也避开 file:// 的各种限制。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var bridge: LmcBridge

    /* ==================================================================
     * 存储权限
     * ================================================================== */

    /** 等待中的授权回调（同时只会有一次申请） */
    private var permCallback: ((Boolean) -> Unit)? = null

    /** 进入系统设置页的时刻，用于 onResume 兜底判定（避免刚进设置页就被判失败） */
    private var permRequestedAt = 0L

    /** Android 11+：跳到「所有文件访问」设置页后返回 */
    private val allFilesLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            settleStorage()
        }

    /** Android 10 及以下：经典读写运行时权限弹窗 */
    private val legacyPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            settleStorage()
        }

    /**
     * 申请存储权限。已授权时同步回调 true；
     * 否则拉起系统界面，用户操作完（或直接返回）后回调最终状态。
     * 界面侧只需 await 这一个结果。
     */
    fun requestStorage(cb: (Boolean) -> Unit) {
        if (StoragePerm.has(this)) {
            cb(true)
            return
        }
        permCallback = cb
        permRequestedAt = SystemClock.uptimeMillis()
        runOnUiThread {
            if (StoragePerm.needsSettingsPage()) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:$packageName")
                )
                try {
                    allFilesLauncher.launch(intent)
                } catch (e: Throwable) {
                    // 少数 ROM 不认带包名的入口，退回全局列表页
                    try {
                        allFilesLauncher.launch(
                            Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                        )
                    } catch (e2: Throwable) {
                        Log.w(TAG_WEB, "无法打开存储权限设置页: ${e2.message}")
                        settleStorage()
                    }
                }
            } else {
                legacyPermLauncher.launch(
                    arrayOf(
                        android.Manifest.permission.WRITE_EXTERNAL_STORAGE,
                        android.Manifest.permission.READ_EXTERNAL_STORAGE
                    )
                )
            }
        }
    }

    /** 结算一次授权申请：把当前状态回报给等待方 */
    private fun settleStorage() {
        val cb = permCallback ?: return
        permCallback = null
        cb(StoragePerm.has(this))
    }

    /* ==================================================================
     * 图片选择（皮肤上传等）
     * ================================================================== */

    /** 等待中的图片选择回调（同时只有一次） */
    private var imageCallback: ((Uri?) -> Unit)? = null

    private val imagePicker =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            val cb = imageCallback
            imageCallback = null
            cb?.invoke(uri)
        }

    /**
     * 拉起系统图片选择器。用户选完（或取消）后回调 Uri（取消为 null）。
     * AccountManager 的皮肤上传流程阻塞等待这个结果。
     */
    fun pickImage(mime: String, cb: (Uri?) -> Unit) {
        if (imageCallback != null) { cb(null); return }
        imageCallback = cb
        try {
            imagePicker.launch(mime)
        } catch (e: Throwable) {
            imageCallback = null
            cb(null)
        }
    }

    /** 从系统设置页返回时兜底结算（部分 ROM 不返回 result） */
    override fun onResume() {
        super.onResume()
        if (permCallback != null && SystemClock.uptimeMillis() - permRequestedAt > 800) {
            settleStorage()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 注意：此处绝不能碰 window.insetsController —— 窗口尚未 attach，
        // 其内部 decorView 为 null，会直接 NPE 崩进程。
        // 这里只声明「内容延伸到系统栏下方」；真正的隐藏放到 onWindowFocusChanged。
        WindowCompat.setDecorFitsSystemWindows(window, false)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this)
        bridge = LmcBridge(this, webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // localStorage：界面层有依赖
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            textZoom = 100                    // 不被系统字体缩放影响，保证与设计稿一致
        }

        webView.addJavascriptInterface(bridge, "AndroidHost")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d(TAG_WEB, "${m.message()}  @${m.sourceId()}:${m.lineNumber()}")
                return true
            }
        }

        setContentView(webView)
        webView.loadUrl(ASSET_URL)
    }

    /** 窗口获得焦点时才安全：此时 decorView 已 attach，insetsController 可用 */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    /** 无边框沉浸：界面自带标题栏，系统栏只在滑动时临时显示 */
    private fun hideSystemBars() {
        try {
            val controller = WindowCompat.getInsetsController(window, window.decorView)
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } catch (e: Throwable) {
            // 兜底：全屏是锦上添花，绝不能让宿主崩掉
            Log.w(TAG_WEB, "hideSystemBars 失败（窗口未就绪）: ${e.message}")
        }
    }

    /** 返回键：先让 Web 层处理（弹窗 / 子页面可自行消费），未消费再退出 */
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        webView.evaluateJavascript(
            "(function(){try{return String(!!(window.__xlcHandleBack&&window.__xlcHandleBack()))}" +
                "catch(e){return 'false'}})()"
        ) { r ->
            if (r != "true") finish()
        }
    }

    override fun onDestroy() {
        bridge.shutdown()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val TAG_WEB = "XLC-Web"
        const val ASSET_URL = "https://appassets.androidplatform.net/assets/web/index.html"
    }
}
