package com.xlc.launcher

import android.annotation.SuppressLint
import android.app.Activity
import android.content.SharedPreferences
import android.net.Uri
import android.util.Base64
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AlertDialog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * 安卓端多账号体系：离线 / 微软 / 第三方（authlib-injector）。
 *
 * 与桌面端 main.js 的 ipcMain.handle('account:*') 逐条对齐：
 *   - 存储：桌面端在 config.accounts 里，安卓用独立 JSON 文件（filesDir/accounts.json），
 *     tokens 等敏感字段同样**绝不进渲染进程**（sanitized 输出）；
 *   - 离线：add / switch / rename / delete / skin / model 语义与桌面端一致，
 *     切换账户时同步 config.activeAccount / config.username；
 *   - 微软：默认流程 = 内置 WebView 打开微软官方登录页（login.live.com，零配置），
 *     截获 oauth20_desktop 回调里的授权码 → live.com 换令牌 → XBL → XSTS →
 *     Minecraft 服务 → 购买检查 → 角色档案。进度通过 account:ms-progress 推给界面打勾；
 *   - 第三方：Yggdrasil 元数据探测（自动 /api/yggdrasil 回落）+ authserver/authenticate；
 *   - 静默续期：启动时后台刷新微软（刷新令牌）/ authlib（accessToken）账户。
 */
class AccountManager(
    private val ctx: android.content.Context,
    private val activityRef: () -> MainActivity?,
    private val prefs: SharedPreferences,
    private val emit: (String, JSONObject) -> Unit
) {

    companion object {
        /* 与桌面端一致的三族常量 */
        const val MS_OFFICIAL_CLIENT_ID = "00000000402b5328"
        const val MS_OAUTH = "https://login.microsoftonline.com/consumers/oauth2/v2.0"
        const val MS_LIVE_BASE = "https://login.live.com"
        const val MS_LIVE_SCOPE = "service::user.auth.xboxlive.com::MBI_SSL"
        const val MS_LIVE_REDIRECT = "https://login.live.com/oauth20_desktop.srf"
        const val MS_SCOPE = "XboxLive.signin offline_access"
        const val AUTHLIB_LITTLESKIN = "https://littleskin.cn/api/yggdrasil"

        val NAME_RE = Regex("^[A-Za-z0-9_]{2,16}$")

        val MS_NET_TARGETS = listOf(
            Triple("live", "微软登录页", "https://login.live.com/oauth20_authorize.srf"),
            Triple("xbl", "Xbox 账户服务", "https://user.auth.xboxlive.com/"),
            Triple("xsts", "Xbox 授权服务", "https://xsts.auth.xboxlive.com/"),
            Triple("mc", "Minecraft 服务", "https://api.minecraftservices.com/"),
            Triple("profile", "Xbox 档案服务", "https://profile.xboxlive.com/")
        )

        private val TAG = "XLC-Accounts"
    }

    private val file = File(ctx.filesDir, "accounts.json")
    private val skinsDir = File(ctx.filesDir, "skins")
    private val rng = SecureRandom()

    private var accounts: JSONArray = JSONArray()
    private var active: String = ""

    init {
        load()
    }

    /* ==================================================================
     * 存储
     * ================================================================== */

    @Synchronized
    private fun load() {
        try {
            if (file.isFile) {
                val j = JSONObject(file.readText(Charsets.UTF_8))
                accounts = j.optJSONArray("accounts") ?: JSONArray()
                active = j.optString("active", "")
            }
        } catch (e: Throwable) {
            accounts = JSONArray(); active = ""
        }
    }

    @Synchronized
    private fun save() {
        try {
            file.parentFile?.mkdirs()
            file.writeText(
                JSONObject().put("accounts", accounts).put("active", active).toString(),
                Charsets.UTF_8
            )
            // 同步到 config 用的两个字段（renderer 全站读 config.username）
            val e = prefs.edit()
            e.putString("activeAccount", active)
            e.putString("username", active.ifEmpty { "Steve" })
            e.apply()
        } catch (e: Throwable) {
            Net.log(TAG, "账户保存失败: ${e.message}")
        }
    }

    private fun find(name: String): JSONObject? {
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optString("name") == name) return a
        }
        return null
    }

    private fun out(): JSONObject {
        val arr = JSONArray()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            arr.put(sanitized(a))
        }
        return JSONObject()
            .put("ok", true)
            .put("accounts", arr)
            .put("active", active.ifEmpty { "Steve" })
    }

    /** 脱敏输出：令牌 / 密码 / 应用 ID 一律剥离；皮肤转 data URI（与桌面端 accountsOut 一致） */
    private fun sanitized(a: JSONObject): JSONObject {
        val o = JSONObject()
        val it = a.keys()
        while (it.hasNext()) {
            val k = it.next()
            if (k in setOf("msRefresh", "mcToken", "accessToken", "clientToken", "password", "msClientId")) continue
            o.put(k, a.get(k))
        }
        o.put("skinUrl", if (a.optString("skin", "").isNotEmpty()) skinDataUri(a.optString("skin")) else JSONObject.NULL)
        return o
    }

    private fun skinDataUri(file0: String): Any {
        return try {
            val b = File(skinsDir, file0).readBytes()
            "data:image/png;base64," + Base64.encodeToString(b, Base64.NO_WRAP)
        } catch (e: Throwable) { JSONObject.NULL }
    }

    /** 供 config:get 使用：脱敏账户数组 + 当前名 */
    fun sanitizedArray(): JSONArray {
        val arr = JSONArray()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            arr.put(sanitized(a))
        }
        return arr
    }

    fun activeName(): String = active.ifEmpty { "Steve" }

    private fun setActive(name: String) {
        active = name
    }

    /* ==================================================================
     * 离线账户
     * ================================================================== */

    fun list(): JSONObject = out()

    fun add(p: JSONObject?): JSONObject {
        val name = (p?.optString("name") ?: "").trim()
        if (!NAME_RE.matches(name)) return err("玩家名限 2-16 个字母/数字/下划线")
        if (find(name) != null || accountsMatchIgnoreCase(name)) return err("该玩家名已存在")
        accounts.put(JSONObject().put("name", name).put("skin", JSONObject.NULL).put("model", "classic"))
        if (active.isEmpty()) setActive(name)
        save()
        return out()
    }

    private fun accountsMatchIgnoreCase(name: String): Boolean {
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optString("name").equals(name, ignoreCase = true)) return true
        }
        return false
    }

    fun switchAcc(p: JSONObject?): JSONObject {
        val name = p?.optString("name") ?: ""
        val acc = find(name) ?: return err("账户不存在")
        setActive(name)
        save()
        return out()
    }

    /** 离线账户改名；在线账户玩家名由认证服务器决定，直接拒绝（与桌面端一致） */
    fun rename(p: JSONObject?): JSONObject {
        val name = p?.optString("name") ?: ""
        val to = (p?.optString("to") ?: "").trim()
        val acc = find(name) ?: return err("账户不存在")
        val type = acc.optString("type", "offline")
        if (type != "offline") return err("在线账户的玩家名由认证服务器决定，不能在这里修改")
        if (!NAME_RE.matches(to)) return err("玩家名限 2-16 个字母/数字/下划线")
        if (to == name) return out()
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a !== acc && a.optString("name").equals(to, ignoreCase = true)) return err("该玩家名已存在")
        }
        // 皮肤文件随名重写（失败沿用旧文件名，不影响内容）
        val oldSkin = acc.optString("skin", "")
        if (oldSkin.isNotEmpty()) {
            try {
                val nf = "skin_" + to.replace(Regex("[^A-Za-z0-9_]"), "_") + "_" + System.currentTimeMillis() + ".png"
                if (File(skinsDir, oldSkin).renameTo(File(skinsDir, nf))) acc.put("skin", nf)
            } catch (_: Throwable) {}
        }
        acc.put("name", to)
        if (active == name) setActive(to)
        save()
        return out()
    }

    fun delete(p: JSONObject?): JSONObject {
        val name = p?.optString("name") ?: ""
        var idx = -1
        var acc: JSONObject? = null
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optString("name") == name) { idx = i; acc = a; break }
        }
        if (idx < 0 || acc == null) return err("账户不存在")
        val skinFile = acc.optString("skin", "")
        val arr = JSONArray()
        for (i in 0 until accounts.length()) {
            if (i == idx) continue
            arr.put(accounts.get(i))
        }
        accounts = arr
        if (skinFile.isNotEmpty()) { try { File(skinsDir, skinFile).delete() } catch (_: Throwable) {} }
        if (active == name) setActive(if (accounts.length() > 0) accounts.optJSONObject(0)?.optString("name") ?: "" else "")
        save()
        return out()
    }

    fun model(p: JSONObject?): JSONObject {
        val name = p?.optString("name") ?: ""
        val acc = find(name) ?: return err("账户不存在")
        acc.put("model", if (p?.optString("model") == "slim") "slim" else "classic")
        save()
        return out()
    }

    fun skinRemove(p: JSONObject?): JSONObject {
        val name = p?.optString("name") ?: ""
        val acc = find(name) ?: return err("账户不存在")
        val skinFile = acc.optString("skin", "")
        if (skinFile.isNotEmpty()) { try { File(skinsDir, skinFile).delete() } catch (_: Throwable) {} }
        acc.put("skin", JSONObject.NULL)
        save()
        return out()
    }

    /** 选皮肤（系统图片选择器）→ 校验 PNG 尺寸 → 存 skins/ 目录 */
    fun skin(p: JSONObject?): JSONObject {
        val name = p?.optString("name") ?: ""
        val acc = find(name) ?: return err("账户不存在")
        val act = activityRef() ?: return err("界面未就绪，请稍后重试")

        // 拉起系统图片选择器（阻塞池线程等用户选完）
        val uriRef = AtomicReference<Uri?>(null)
        val doneRef = AtomicReference<Boolean>(false)
        val latch = CountDownLatch(1)
        act.runOnUiThread {
            act.pickImage("image/png") { u ->
                uriRef.set(u); doneRef.set(true); latch.countDown()
            }
        }
        try {
            if (!latch.await(3, TimeUnit.MINUTES)) return err("选择皮肤超时，请重试")
        } catch (_: InterruptedException) {
            return err("已取消")
        }
        if (!doneRef.get()) return err("已取消")
        val uri = uriRef.get() ?: return err("已取消")

        return try {
            val buf = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                ?: return err("读取文件失败")
            if (buf.size < 24 || !(buf[0] == 0x89.toByte() && buf[1] == 'P'.code.toByte()))
                return err("不是有效的 PNG 文件")
            val w = readU32(buf, 16)
            val h = readU32(buf, 20)
            if (!((w == 64L && h == 64L) || (w == 64L && h == 32L)))
                return err("皮肤必须是 64x64（新版）或 64x32（旧版）的 PNG，当前 ${w}x$h")
            skinsDir.mkdirs()
            val fn = "skin_" + name.replace(Regex("[^A-Za-z0-9_]"), "_") + "_" + System.currentTimeMillis() + ".png"
            File(skinsDir, fn).writeBytes(buf)
            val old = acc.optString("skin", "")
            if (old.isNotEmpty() && old != fn) { try { File(skinsDir, old).delete() } catch (_: Throwable) {} }
            acc.put("skin", fn)
            acc.put("model", if (p?.optString("model") == "slim") "slim" else "classic")
            save()
            out()
        } catch (e: Throwable) {
            err(e.message ?: "保存皮肤失败")
        }
    }

    private fun readU32(b: ByteArray, off: Int): Long {
        var v = 0L
        for (i in 0 until 4) v = (v shl 8) or (b[off + i].toLong() and 0xFF)
        return v
    }

    /* ==================================================================
     * 在线账户落库（微软 / authlib 共用，与桌面端 upsertOnline 一致）
     * ================================================================== */

    private fun upsertOnline(acc: JSONObject): JSONObject {
        val type = acc.optString("type")
        val uuid = acc.optString("uuid")
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            if (a.optString("type") == type && a.optString("uuid") == uuid) {
                val it = acc.keys()
                while (it.hasNext()) { val k = it.next(); a.put(k, acc.get(k)) }
                setActive(acc.optString("name"))
                save()
                return a
            }
        }
        accounts.put(acc)
        setActive(acc.optString("name"))
        save()
        return acc
    }

    private fun err(msg: String): JSONObject = JSONObject().put("ok", false).put("error", msg)

    private fun msStep(step: Int, text: String) {
        emit("account:ms-progress", JSONObject().put("step", step).put("text", text))
    }

    /* ==================================================================
     * 微软登录 · 默认流程（内置 WebView + login.live.com 官方页）
     * ================================================================== */

    /** 一次 WebView 登录的结局 */
    private class MsOutcome(val code: String?, val error: String?, val canceled: Boolean)

    private var msPending: MsPending? = null

    /** 进行中的一次登录（供取消接口关闭） */
    private class MsPending(
        val clientId: String,
        val redirectUri: String,
        val verifier: String,
        val challenge: String,
        val state: String,
        @Volatile var code: String?,
        val latch: CountDownLatch,
        @Volatile var canceled: Boolean
    )

    private fun b64u(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.NO_WRAP or Base64.NO_PADDING or Base64.URL_SAFE)

    private fun randomB64u(n: Int): String = ByteArray(n).also { rng.nextBytes(it) }.let { b64u(it) }

    /** 微软官方登录页 URL（与桌面端 msLiveAuthUrl 一致） */
    private fun msLiveAuthUrl(state: String): String =
        MS_LIVE_BASE + "/oauth20_authorize.srf?" +
            "client_id=$MS_OFFICIAL_CLIENT_ID&response_type=code" +
            "&redirect_uri=" + Net.enc(MS_LIVE_REDIRECT) +
            "&scope=" + Net.enc(MS_LIVE_SCOPE) +
            "&state=" + Net.enc(state) + "&prompt=select_account"

    /** 自建 Azure 应用的授权页（PKCE，与桌面端 msAuthUrl 一致） */
    private fun msAadAuthUrl(clientId: String, redirectUri: String, challenge: String, state: String): String =
        MS_OAUTH + "/authorize?" +
            "client_id=" + Net.enc(clientId) + "&response_type=code" +
            "&redirect_uri=" + Net.enc(redirectUri) +
            "&scope=" + Net.enc(MS_SCOPE) +
            "&code_challenge=" + Net.enc(challenge) +
            "&code_challenge_method=S256" +
            "&state=" + Net.enc(state) + "&prompt=select_account"

    /**
     * 打开内置 WebView 登录窗口并阻塞到拿到授权码 / 出错 / 取消 / 超时。
     * interceptor 返回非 null 表示「这次导航就是结果」，WebView 停止加载并收窗。
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun openLoginDialog(authUrl: String, timeoutMs: Int, isLoopback: Boolean): MsOutcome {
        val act = activityRef() ?: return MsOutcome(null, "界面未就绪，请稍后重试", false)
        val outcome = AtomicReference<MsOutcome>(null)
        val latch = CountDownLatch(1)
        val dialogRef = AtomicReference<AlertDialog?>(null)

        act.runOnUiThread {
            val wv = WebView(act)
            wv.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                // 微软会拒绝「不安全的嵌入式浏览器」：伪装成标准桌面 Chromium（同桌面端 msCleanUA 思路）
                userAgentString =
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
            }
            // WebView 没有内在尺寸，AlertDialog 直接 setView 会得到 0 高度的空白窗 ——
            // 必须包一层并给显式高度
            val frame = android.widget.FrameLayout(act)
            frame.addView(
                wv,
                android.view.ViewGroup.LayoutParams(
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    (act.resources.displayMetrics.heightPixels * 0.72f).toInt()
                )
            )
            wv.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, url: String?): Boolean {
                    if (url == null) return false
                    val r = grabResult(url, isLoopback) ?: return false
                    outcome.compareAndSet(null, r)
                    latch.countDown()
                    try { dialogRef.get()?.dismiss() } catch (_: Throwable) {}
                    return true
                }
            }
            val dlg = AlertDialog.Builder(act)
                .setTitle("登录 Microsoft 账户 · XLC 启动器")
                .setView(frame)
                .setNegativeButton("取消") { d, _ ->
                    outcome.compareAndSet(null, MsOutcome(null, null, true))
                    latch.countDown()
                    d.dismiss()
                }
                .setOnDismissListener {
                    outcome.compareAndSet(null, MsOutcome(null, null, true))
                    latch.countDown()
                    wv.destroy()
                }
                .create()
            dialogRef.set(dlg)
            activeDialog.set(dlg)
            dlg.show()
            dlg.window?.setLayout(
                (act.resources.displayMetrics.widthPixels * 0.86f).toInt(),
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT
            )
            wv.loadUrl(authUrl)
        }

        // 超时（对话框可能持续到用户慢慢输完密码，5 分钟与桌面端一致）
        val timer = java.util.Timer(true)
        timer.schedule(object : java.util.TimerTask() {
            override fun run() {
                outcome.compareAndSet(null, MsOutcome(null, "登录等待超时（5 分钟内未完成），请重试", false))
                latch.countDown()
                try { dialogRef.get()?.dismiss() } catch (_: Throwable) {}
            }
        }, timeoutMs.toLong())

        try { latch.await() } catch (_: InterruptedException) {}
        timer.cancel()
        val o = outcome.get() ?: MsOutcome(null, null, true)
        // 主动关窗（避免泄漏）
        try { dialogRef.get()?.dismiss() } catch (_: Throwable) {}
        if (activeDialog.compareAndSet(dialogRef.get(), null)) { /* 已清理 */ }
        return o
    }

    /** 判定一次导航是否为登录结果（对应桌面端 msGrabAuthCode，null = 继续等） */
    private fun grabResult(url: String, isLoopback: Boolean): MsOutcome? {
        val u = try { Uri.parse(url) } catch (e: Throwable) { return null }
        if (isLoopback) {
            // 自建应用流程：redirect 到 http://localhost:<port>/?code=...（本机没有服务，必须拦下）
            val host = u.host ?: return null
            if (u.scheme !in setOf("http", "https")) return null
            if (host != "localhost" && host != "127.0.0.1") return null
            val err = u.getQueryParameter("error")
            if (err != null) return MsOutcome(null, u.getQueryParameter("error_description") ?: "微软返回错误: $err", false)
            val code = u.getQueryParameter("code") ?: return MsOutcome(null, "回调缺少授权码", false)
            val st = u.getQueryParameter("state")
            if (st != null && msPending != null && st != msPending?.state)
                return MsOutcome(null, "state 校验失败：这次回调不属于本次登录请求", false)
            return MsOutcome(code, null, false)
        }
        // live 流程：只认 login.live.com/oauth20_desktop
        val host = (u.host ?: "").lowercase()
        if (!host.endsWith("login.live.com")) return null
        if (!(u.path ?: "").contains("oauth20_desktop")) return null
        val err = u.getQueryParameter("error")
        if (err != null) return MsOutcome(null, u.getQueryParameter("error_description") ?: "微软返回错误: $err", false)
        val code = u.getQueryParameter("code") ?: return null
        val st = u.getQueryParameter("state")
        if (st != null && st != pendingLiveState) return MsOutcome(null, "state 校验失败：这次回调不属于本次登录请求", false)
        return MsOutcome(code, null, false)
    }

    @Volatile private var pendingLiveState: String = ""

    /** 当前打开的登录窗口（供「取消登录」接口从另一条线程关闭） */
    private val activeDialog = AtomicReference<AlertDialog?>(null)

    /** 默认微软登录（account:ms-web-login） */
    fun msWebLogin(p: JSONObject?): JSONObject {
        val timeoutMs = (p?.optInt("timeoutMs") ?: 300000).coerceIn(60000, 900000)
        try {
            msStep(1, "正在打开微软官方登录页…")
            val state = randomB64u(16)
            pendingLiveState = state
            val o = openLoginDialog(msLiveAuthUrl(state), timeoutMs, isLoopback = false)
            if (o.canceled && o.code == null && o.error == null) {
                msStep(0, "")
                return JSONObject().put("ok", false).put("error", "已取消登录").put("canceled", true)
            }
            if (o.error != null) {
                msStep(0, "")
                return JSONObject().put("ok", false).put("error", o.error).put("canceled", false)
            }
            if (o.code == null) {
                msStep(0, "")
                return JSONObject().put("ok", false).put("error", "登录未完成").put("canceled", true)
            }
            msStep(1, "登录完成，正在处理…")
            val tok = msLiveExchange(MS_OFFICIAL_CLIENT_ID, o.code)
                ?: return failWeb("授权码换令牌失败：无法连接微软服务")
            val chain = msChainFromToken(tok.optString("access_token"), tok.optString("refresh_token"), skipGamertag = false)
            if (chain is String) return failWeb(chain)
            val c = chain as JSONObject
            upsertOnline(
                JSONObject(c.toString())
                    .put("type", "ms")
                    .put("skin", JSONObject.NULL)
                    .put("model", "classic")
                    .put("msClientId", MS_OFFICIAL_CLIENT_ID)
                    .put("msFlow", "live")
            )
            msStep(0, "")
            return out()
                .put("name", c.optString("name"))
                .put("ownership", c.optString("ownership"))
                .put("gamertag", c.optString("gamertag"))
        } catch (e: Throwable) {
            msStep(0, "")
            val msg = e.message ?: "登录失败"
            val r = JSONObject().put("ok", false).put("error", msg)
            if ("取消" in msg) r.put("canceled", true)
            else r.put("netResults", msNetProbe(6000))
            return r
        }
    }

    private fun failWeb(msg: String): JSONObject {
        msStep(0, "")
        return JSONObject().put("ok", false).put("error", msg)
    }

    fun msWebCancel(): JSONObject {
        // 关闭当前登录窗口 → setOnDismissListener 会把等待线程按「已取消」唤醒
        val d = activeDialog.getAndSet(null)
        if (d != null) {
            val act = activityRef()
            act?.runOnUiThread { try { d.dismiss() } catch (_: Throwable) {} }
        }
        pendingLiveState = ""
        return JSONObject().put("ok", true)
    }

    /** live.com 老端点换令牌（公共客户端） */
    private fun msLiveExchange(clientId: String, code: String): JSONObject? {
        val r = Net.postFormResp(
            MS_LIVE_BASE + "/oauth20_token.srf",
            mapOf(
                "client_id" to clientId,
                "grant_type" to "authorization_code",
                "code" to code,
                "redirect_uri" to MS_LIVE_REDIRECT,
                "scope" to MS_LIVE_SCOPE
            )
        )
        val j = r.json()
        if (!r.ok || j.optString("access_token").isEmpty()) {
            throw IOException(j.optString("error_description")
                .ifEmpty { j.optString("error") }.ifEmpty { "授权码换令牌失败 (HTTP ${r.status})" })
        }
        return j
    }

    /* ==================================================================
     * 微软登录 · 备用流程（自建 Azure 应用：内置 WebView + PKCE）
     * ================================================================== */

    fun msAppInfo(): JSONObject = JSONObject()
        .put("ok", true)
        .put("builtin", false)
        .put("custom", false)
        .put("ready", true)
        .put("aadReady", false)   // 安卓端未内置自建应用 ID；设备码/环回流程需用户自填
        .put("defaultFlow", "live")
        .put("officialClientId", MS_OFFICIAL_CLIENT_ID)

    /** 第一步：打开授权页并等待用户完成浏览器侧登录，拿到授权码（不换令牌） */
    fun msLoginStart(p: JSONObject?): JSONObject {
        val typed = (p?.optString("clientId") ?: "").trim()
        val cid = if (typed.matches(Regex("^[0-9a-fA-F-]{8,40}$"))) typed else ""
        if (cid.isEmpty()) return JSONObject().put("ok", false).put("needId", true)
            .put("error", "尚未配置应用 ID：请在下面「高级」里填入你自己的 Azure 应用 ID")
        val verifier = randomB64u(32)
        val challenge = b64u(sha256(verifier.toByteArray(Charsets.UTF_8)))
        val state = randomB64u(16)
        val port = 30000 + (Math.abs(state.hashCode()) % 20000)
        val redirectUri = "http://localhost:$port/"
        val latch = CountDownLatch(1)
        val pending = MsPending(cid, redirectUri, verifier, challenge, state, null, latch, false)
        msPending = pending
        val o = openLoginDialog(msAadAuthUrl(cid, redirectUri, challenge, state), 300000, isLoopback = true)
        if (o.canceled && o.code == null) {
            msPending = null
            return JSONObject().put("ok", false).put("error", "已取消登录").put("canceled", true)
        }
        if (o.error != null || o.code == null) {
            msPending = null
            return JSONObject().put("ok", false).put("error", o.error ?: "登录未完成")
        }
        pending.code = o.code
        return JSONObject().put("ok", true).put("authUrl", "").put("port", port)
            .put("redirectUri", redirectUri).put("builtin", false)
    }

    /** 第二步：拿授权码换令牌 → 走完整链 → 落库 */
    fun msLoginWait(p: JSONObject?): JSONObject {
        val pending = msPending ?: return JSONObject().put("ok", false)
            .put("error", "登录流程已失效，请重新点「微软登录」")
        msPending = null
        val code = pending.code ?: return JSONObject().put("ok", false).put("error", "登录未完成")
        return try {
            val r = Net.postFormResp(
                MS_OAUTH + "/token",
                mapOf(
                    "client_id" to pending.clientId,
                    "grant_type" to "authorization_code",
                    "code" to code,
                    "redirect_uri" to pending.redirectUri,
                    "code_verifier" to pending.verifier,
                    "scope" to MS_SCOPE
                )
            )
            val j = r.json()
            if (!r.ok || j.optString("access_token").isEmpty())
                return err(j.optString("error_description").ifEmpty { "HTTP ${r.status}" })
            val chain = msChainFromToken(j.optString("access_token"), j.optString("refresh_token"), skipGamertag = false)
            if (chain is String) return err(chain as String)
            val c = chain as JSONObject
            upsertOnline(
                JSONObject(c.toString())
                    .put("type", "ms")
                    .put("skin", JSONObject.NULL)
                    .put("model", "classic")
                    .put("msClientId", pending.clientId)
                    .put("msFlow", "aad")
            )
            out()
        } catch (e: Throwable) {
            err(e.message ?: "登录失败")
        }
    }

    fun msLoginCancel(): JSONObject {
        msPending = null
        return JSONObject().put("ok", true)
    }

    /* ==================================================================
     * 微软登录 · 设备码流程
     * ================================================================== */

    fun msStart(p: JSONObject?): JSONObject {
        val typed = (p?.optString("clientId") ?: "").trim()
        val cid = if (typed.matches(Regex("^[0-9a-fA-F-]{8,40}$"))) typed else ""
        if (cid.isEmpty()) return JSONObject().put("ok", false).put("needId", true).put("error", "尚未配置应用 ID")
        val r = Net.postFormResp(MS_OAUTH + "/devicecode", mapOf("client_id" to cid, "scope" to MS_SCOPE))
        val j = r.json()
        if (!r.ok || j.optString("device_code").isEmpty())
            return err(j.optString("error_description").ifEmpty { "获取设备码失败 (HTTP ${r.status})" })
        return JSONObject()
            .put("ok", true)
            .put("deviceCode", j.optString("device_code"))
            .put("userCode", j.optString("user_code"))
            .put("verifyUrl", j.optString("verification_uri"))
            .put("interval", if (j.optInt("interval", 5) > 0) j.optInt("interval", 5) else 5)
            .put("expires", j.optInt("expires_in", 900))
    }

    fun msPoll(p: JSONObject?): JSONObject {
        val typed = (p?.optString("clientId") ?: "").trim()
        val cid = if (typed.matches(Regex("^[0-9a-fA-F-]{8,40}$"))) typed else ""
        if (cid.isEmpty()) return err("应用 ID 无效")
        val r = Net.postFormResp(
            MS_OAUTH + "/token",
            mapOf(
                "client_id" to cid,
                "grant_type" to "urn:ietf:params:oauth:grant-type:device_code",
                "device_code" to (p?.optString("deviceCode") ?: "")
            )
        )
        val j = r.json()
        when (j.optString("error")) {
            "authorization_pending" -> return JSONObject().put("ok", true).put("pending", true)
            "slow_down" -> return JSONObject().put("ok", true).put("pending", true).put("slow", true)
            "" -> {}
            else -> return err(j.optString("error_description").ifEmpty { j.optString("error") })
        }
        if (j.optString("access_token").isEmpty()) return err("HTTP ${r.status}")
        val chain = msChainFromToken(j.optString("access_token"), j.optString("refresh_token"), skipGamertag = false)
        if (chain is String) return err(chain as String)
        val c = chain as JSONObject
        upsertOnline(
            JSONObject(c.toString())
                .put("type", "ms")
                .put("skin", JSONObject.NULL)
                .put("model", "classic")
                .put("msClientId", cid)
                .put("msFlow", "aad")
        )
        return out()
    }

    /* ==================================================================
     * 微软令牌链（XBL → XSTS → MC → 购买检查 → 档案）
     * 返回 String = 人话错误；JSONObject = chain
     * ================================================================== */

    private fun msChainFromToken(msToken: String, refresh: String, skipGamertag: Boolean): Any {
        return try {
            msStep(2, "正在获取 Xbox 账户信息…")
            val xbl = Net.postJsonResp(
                "https://user.auth.xboxlive.com/user/authenticate",
                JSONObject()
                    .put("Properties", JSONObject()
                        .put("AuthMethod", "RPS")
                        .put("SiteName", "user.auth.xboxlive.com")
                        .put("RpsTicket", "d=$msToken"))
                    .put("RelyingParty", "http://auth.xboxlive.com")
                    .put("TokenType", "JWT")
                    .toString()
            )
            val xblJ = xbl.json()
            if (!xbl.ok) throw IOException(msErrText(xblJ, "Xbox 账户服务"))
            val xblToken = xblJ.optString("Token")
            val uhs = xblJ.optJSONObject("DisplayClaims")?.optJSONArray("xui")?.optJSONObject(0)?.optString("uhs") ?: ""
            if (xblToken.isEmpty() || uhs.isEmpty()) throw IOException("Xbox 账户服务返回数据不完整")

            val xsts = Net.postJsonResp(
                "https://xsts.auth.xboxlive.com/xsts/authorize",
                JSONObject()
                    .put("Properties", JSONObject()
                        .put("SandboxId", "RETAIL")
                        .put("UserTokens", JSONArray().put(xblToken)))
                    .put("RelyingParty", "rp://api.minecraftservices.com/")
                    .put("TokenType", "JWT")
                    .toString()
            )
            val xstsJ = xsts.json()
            if (!xsts.ok) throw IOException(msErrText(xstsJ, "Xbox 授权服务"))
            val xstsToken = xstsJ.optString("Token")
            val xstsUhs = xstsJ.optJSONObject("DisplayClaims")?.optJSONArray("xui")?.optJSONObject(0)?.optString("uhs") ?: uhs
            val xuid = try {
                val parts = xstsToken.split(".")
                if (parts.size >= 2) {
                    val payload = String(Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_WRAP), Charsets.UTF_8)
                    JSONObject(payload).optJSONArray("xui")?.optJSONObject(0)?.optString("xid") ?: ""
                } else ""
            } catch (_: Throwable) { "" }

            val gamertag = if (skipGamertag) "" else msXboxGamertag(xstsToken, xstsUhs)

            val mc = Net.postJsonResp(
                "https://api.minecraftservices.com/authentication/login_with_xbox",
                JSONObject().put("identityToken", "XBL3.0 x=$xstsUhs;$xstsToken").toString()
            )
            val mcJ = mc.json()
            if (!mc.ok || mcJ.optString("access_token").isEmpty())
                throw IOException("Minecraft 服务登录失败: ${mcJ.toString().take(120)}")

            msStep(3, "正在检查是否已购买 Minecraft…")
            // 购买检查失败不算"没买"（known=false），别冤枉用户
            val ent = try {
                val er = Net.getResp("https://api.minecraftservices.com/entitlements/mcstore",
                    mapOf("Authorization" to "Bearer ${mcJ.optString("access_token")}"))
                if (!er.ok) JSONObject().put("known", false).put("owned", false).put("items", JSONArray())
                else {
                    val ej = er.json()
                    val items = JSONArray()
                    val raw = ej.optJSONArray("items") ?: JSONArray()
                    for (i in 0 until raw.length()) {
                        val n = raw.optJSONObject(i)?.optString("name") ?: ""
                        if (n.isNotEmpty()) items.put(n)
                    }
                    JSONObject().put("known", true).put("owned", items.length() > 0).put("items", items)
                }
            } catch (_: Throwable) {
                JSONObject().put("known", false).put("owned", false).put("items", JSONArray())
            }

            msStep(4, "正在获取角色档案…")
            val prof = Net.getResp("https://api.minecraftservices.com/minecraft/profile",
                mapOf("Authorization" to "Bearer ${mcJ.optString("access_token")}"))
            if (prof.status == 404) {
                val known = ent.optBoolean("known")
                val owned = ent.optBoolean("owned")
                if (!known || !owned) throw IOException("该微软账户没有 Minecraft 正版：查不到任何购买记录，名下也没有角色档案。请换用已购买过 Java 版的账户登录，或先到 minecraft.net 购买后再试")
                throw IOException("该账户还没有 Minecraft 角色：Java 版首次使用需要先在 minecraft.net 上设置玩家名")
            }
            if (!prof.ok) throw IOException("获取角色档案失败 (HTTP ${prof.status})")
            val profJ = prof.json()
            val profName = profJ.optString("name")
            val profId = profJ.optString("id")
            if (profName.isEmpty() || profId.isEmpty()) throw IOException("角色档案返回数据不完整")

            val ownership = when {
                !ent.optBoolean("known") -> "unknown"
                ent.optBoolean("owned") -> "owned"
                else -> "gamepass"
            }
            JSONObject()
                .put("name", profName)
                .put("uuid", profId)
                .put("mcToken", mcJ.optString("access_token"))
                .put("expiresAt", System.currentTimeMillis() + ((mcJ.optLong("expires_in", 86400) - 600) * 1000))
                .put("msRefresh", refresh)
                .put("xuid", xuid)
                .put("gamertag", gamertag)
                .put("ownership", ownership)
                .put("entitlements", ent.optJSONArray("items") ?: JSONArray())
        } catch (e: Throwable) {
            e.message ?: "登录链路失败"
        }
    }

    private fun msErrText(j: JSONObject, who: String): String {
        val xe = j.optLong("XErr", -1L)
        if (xe > 0) return msXErrText(xe)
        return j.optString("error_description").ifEmpty { j.optString("error") }.ifEmpty { "$who 失败" }
    }

    /** Xbox 错误码 → 人话（照抄桌面端 msXErrText） */
    private fun msXErrText(xerr: Long): String = when (xerr) {
        2148916227L -> "该微软账户已被 Xbox Live 封禁，无法登录"
        2148916233L -> "该微软账户还没有 Xbox 档案：请先用这个账号登录一次 xbox.com 创建档案，再回来登录"
        2148916234L -> "该账户需要先同意 Xbox 服务条款：请到 xbox.com 登录一次并接受条款"
        2148916235L -> "该账户所在国家/地区不支持 Xbox Live，无法登录"
        2148916236L, 2148916237L -> "该账户需要成年验证（韩国地区要求），请到 xbox.com 完成验证"
        2148916238L -> "该账户是儿童账户：需要家长在 Microsoft 家庭组里允许它加入 Xbox 网络"
        2148910053L -> "该微软账户没有 Minecraft 正版（未购买或未关联）"
        2148910067L -> "该账户所在地区受限制，无法玩 Minecraft"
        2148910065L, 2148910066L -> "Xbox 账户未创建或受限，请先在 Xbox 上创建档案"
        2148910069L -> "该账户是儿童账户，需在家长设置中允许加入 Xbox 网络"
        else -> "Xbox 服务返回错误 (XErr=$xerr)"
    }

    private fun msXboxGamertag(xstsToken: String, uhs: String): String {
        return try {
            val r = Net.getResp(
                "https://profile.xboxlive.com/users/me/profile/settings?settings=Gamertag",
                mapOf(
                    "Authorization" to "XBL3.0 x=$uhs;$xstsToken",
                    "x-xbl-contract-version" to "2",
                    "Accept" to "application/json"
                )
            )
            if (!r.ok) "" else {
                val j = r.json()
                val users = j.optJSONArray("profileUsers") ?: return ""
                val settings = users.optJSONObject(0)?.optJSONArray("settings") ?: return ""
                for (i in 0 until settings.length()) {
                    val s = settings.optJSONObject(i) ?: continue
                    if (s.optString("id") == "Gamertag") return s.optString("value")
                }
                ""
            }
        } catch (_: Throwable) { "" }
    }

    /** 静默续期（启动时后台调用；成功则更新账户，失败不打扰） */
    fun refreshAll() {
        for (i in 0 until accounts.length()) {
            val a = accounts.optJSONObject(i) ?: continue
            when (a.optString("type")) {
                "ms" -> {
                    val expiresAt = a.optLong("expiresAt", 0)
                    if (expiresAt > 0 && System.currentTimeMillis() < expiresAt - 3600_000) continue
                    try { msRefreshAcc(a) } catch (_: Throwable) {}
                }
                "authlib" -> {
                    try { authlibRefreshAcc(a) } catch (_: Throwable) {}
                }
            }
        }
    }

    private fun msRefreshAcc(acc: JSONObject) {
        val cid = acc.optString("msClientId").ifEmpty { MS_OFFICIAL_CLIENT_ID }
        val live = acc.optString("msFlow", "live") == "live"
        val url = if (live) MS_LIVE_BASE + "/oauth20_token.srf" else MS_OAUTH + "/token"
        val scope = if (live) MS_LIVE_SCOPE else MS_SCOPE
        val r = Net.postFormResp(
            url,
            mapOf(
                "client_id" to cid,
                "grant_type" to "refresh_token",
                "refresh_token" to acc.optString("msRefresh"),
                "scope" to scope
            )
        )
        val j = r.json()
        if (!r.ok || j.optString("access_token").isEmpty()) return
        val chain = msChainFromToken(j.optString("access_token"), j.optString("refresh_token", acc.optString("msRefresh")), skipGamertag = true)
        if (chain !is JSONObject) return
        // 许可接口没查成功时保留已知结论（与桌面端一致，别降级）
        if (chain.optString("ownership") == "unknown") {
            val prev = acc.optString("ownership", "")
            if (prev == "owned" || prev == "gamepass") chain.put("ownership", prev)
        }
        if (chain.optString("gamertag").isEmpty()) chain.put("gamertag", acc.optString("gamertag", ""))
        val it = chain.keys()
        while (it.hasNext()) { val k = it.next(); acc.put(k, chain.get(k)) }
        save()
    }

    /* ==================================================================
     * 微软网络自检（account:ms-net-check）
     * ================================================================== */

    fun msNetCheck(): JSONObject {
        val results = msNetProbe(6000)
        val rows = mutableListOf<JSONObject>()
        for (i in 0 until results.length()) rows.add(results.optJSONObject(i) ?: JSONObject())
        val allOk = rows.all { it.optBoolean("ok") }
        val bad = rows.filter { !it.optBoolean("ok") }
        val advice = if (bad.isEmpty())
            "这条链路上的服务都连得上 —— 网络没问题，问题多半在账号本身（未购买 Java 版 / 儿童账户 / 地区限制等），下面那行错误信息就是微软的原话。"
        else if (bad.size == rows.size)
            "自检：" + bad.joinToString("、") { it.optString("name") } + " 全部连不上（直连）。请检查网络是否正常、代理/VPN 是否只对浏览器生效，可换线路或关闭代理后重试"
        else
            "自检：" + bad.joinToString("、") { it.optString("name") } + " 连不上，但其余服务正常（直连）。多半是代理/VPN 只代理了部分流量，试试全局模式或换条线路"
        return JSONObject()
            .put("ok", allOk)
            .put("via", "DIRECT")
            .put("results", results)
            .put("advice", advice)
    }

    private fun msNetProbe(timeoutMs: Int): JSONArray {
        val arr = JSONArray()
        val latch = CountDownLatch(MS_NET_TARGETS.size)
        val pool = java.util.concurrent.Executors.newFixedThreadPool(minOf(5, MS_NET_TARGETS.size))
        for ((key, name, url) in MS_NET_TARGETS) {
            pool.execute {
                val t0 = System.currentTimeMillis()
                val row = JSONObject().put("key", key).put("name", name).put("url", url)
                try {
                    val r = Net.getResp(url, null, timeoutMs)
                    if (r.status > 0) row.put("ok", true).put("status", r.status).put("ms", System.currentTimeMillis() - t0)
                    else row.put("ok", false).put("ms", System.currentTimeMillis() - t0).put("error", r.body.ifEmpty { "连不上" })
                } catch (e: Throwable) {
                    row.put("ok", false).put("ms", System.currentTimeMillis() - t0).put("error", e.message ?: "连不上")
                }
                synchronized(arr) { arr.put(row) }
                latch.countDown()
            }
        }
        try { latch.await(timeoutMs + 3000L, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) {}
        pool.shutdownNow()
        return arr
    }

    /* ==================================================================
     * 第三方外置登录（authlib-injector 协议 / Blessing Skin 服务器）
     * ================================================================== */

    private fun authlibRoot(url: String): String = url.trim().trimEnd('/')

    /** 拉 Yggdrasil 元数据；用户粘了站点首页时自动尝试 /api/yggdrasil 回落 */
    private fun authlibFetchMeta(root: String): Pair<JSONObject, String> {
        val try1 = try {
            Net.getResp(root + "/", mapOf("Accept" to "application/json"), 12000)
        } catch (_: Throwable) { null }
        val j1 = try1?.takeIf { it.ok }?.json()
        if (j1 != null && j1.has("meta")) return j1 to root
        val root2 = root + "/api/yggdrasil"
        val try2 = try {
            Net.getResp(root2 + "/", mapOf("Accept" to "application/json"), 12000)
        } catch (_: Throwable) { null }
        val j2 = try2?.takeIf { it.ok }?.json()
        if (j2 != null && j2.has("meta")) return j2 to root2
        throw IOException("该地址不是有效的 authlib-injector 认证服务器（需 Yggdrasil API 根地址，如 https://littleskin.cn/api/yggdrasil）")
    }

    fun authlibDetect(p: JSONObject?): JSONObject {
        val raw = p?.optString("serverUrl").takeUnless { it.isNullOrEmpty() }
            ?: if (p?.optString("server") == "littleskin") AUTHLIB_LITTLESKIN else ""
        val root = authlibRoot(raw ?: "")
        if (!root.startsWith("http://") && !root.startsWith("https://"))
            return err("服务器地址需以 http(s):// 开头")
        return try {
            val (meta, realRoot) = authlibFetchMeta(root)
            val serverName = meta.optJSONObject("meta")?.optString("serverName").takeUnless { it.isNullOrEmpty() } ?: realRoot
            JSONObject().put("ok", true).put("serverName", serverName).put("root", realRoot)
        } catch (e: Throwable) {
            err(e.message ?: "探测失败")
        }
    }

    fun authlibLogin(p: JSONObject?): JSONObject {
        val raw = p?.optString("serverUrl").takeUnless { it.isNullOrEmpty() }
            ?: if (p?.optString("server") == "littleskin") AUTHLIB_LITTLESKIN else ""
        val root = authlibRoot(raw ?: "")
        if (!root.startsWith("http://") && !root.startsWith("https://"))
            return err("服务器地址无效")
        val user = (p?.optString("username") ?: "").trim()
        val pass = p?.optString("password") ?: ""
        if (user.isEmpty() || pass.isEmpty()) return err("请输入账号（邮箱或角色名）和密码")
        return try {
            val (meta, api) = authlibFetchMeta(root)
            val r = Net.postJsonResp(
                api + "/authserver/authenticate",
                JSONObject()
                    .put("username", user)
                    .put("password", pass)
                    .put("agent", JSONObject().put("name", "Minecraft").put("version", 1))
                    .toString(),
                20000
            )
            val j = r.json()
            if (!r.ok || j.optString("accessToken").isEmpty())
                return err(j.optString("errorMessage").ifEmpty { "登录失败 (HTTP ${r.status})" })
            var sel = j.optJSONObject("selectedProfile")
            if (sel == null) {
                val first = j.optJSONArray("availableProfiles")?.optJSONObject(0)
                    ?: return err("该账号下没有 Minecraft 角色，请先在服务器官网创建")
                sel = first // 多角色时默认选第一个（与桌面端一致）
            }
            upsertOnline(
                JSONObject()
                    .put("type", "authlib")
                    .put("name", sel.optString("name"))
                    .put("uuid", sel.optString("id"))
                    .put("serverUrl", api)
                    .put("serverMeta", meta.optJSONObject("meta") ?: JSONObject())
                    .put("skin", JSONObject.NULL)
                    .put("model", "classic")
                    .put("accessToken", j.optString("accessToken"))
                    .put("clientToken", j.optString("clientToken", ""))
            )
            out()
        } catch (e: Throwable) {
            err(e.message ?: "登录失败")
        }
    }

    /** 外置账户令牌静默续期（失败不阻断，旧令牌可能仍有效） */
    private fun authlibRefreshAcc(acc: JSONObject) {
        val root = authlibRoot(acc.optString("serverUrl"))
        if (root.isEmpty()) return
        val r = Net.postJsonResp(
            root + "/authserver/refresh",
            JSONObject()
                .put("accessToken", acc.optString("accessToken"))
                .put("selectedProfile", JSONObject().put("id", acc.optString("uuid")).put("name", acc.optString("name")))
                .toString(),
            12000
        )
        val j = r.json()
        if (r.ok && j.optString("accessToken").isNotEmpty()) {
            acc.put("accessToken", j.optString("accessToken"))
            if (j.optString("clientToken").isNotEmpty()) acc.put("clientToken", j.optString("clientToken"))
            save()
        }
    }

    private fun sha256(b: ByteArray): ByteArray =
        java.security.MessageDigest.getInstance("SHA-256").digest(b)
}
