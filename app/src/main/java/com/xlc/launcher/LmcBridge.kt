package com.xlc.launcher

import android.app.Activity
import android.app.ActivityManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * 安卓端 window.lmc 的原生实现。
 *
 * 每个接口的返回结构都与桌面端 main.js 里的 ipcMain.handle 保持一致，
 * 这样 renderer.js 不需要任何改动就能在安卓上跑。
 *
 * Spike 阶段策略：
 *   - 启动路径上的接口（配置 / 扫描 / Java / 清单 / 好友信令）必须返回**结构正确**的值，
 *     否则 renderer.js 的 init() 链会断在 await 上，界面永远停在启动遮罩；
 *   - 尚未接入的能力统一返回 {ok:false, error:"移动端尚未接入此功能"}，
 *     并带 mobileStub 标记，方便后续按标记逐个补齐。
 */
class LmcBridge(private val ctx: Context, private val webView: WebView) {

    private val pool: ExecutorService = Executors.newFixedThreadPool(4)
    private val prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** 当前下载源（配置里改过就以配置为准，缺省 BMCLAPI） */
    private fun sourceName(): String = prefs.getString("source", "bmclapi") ?: "bmclapi"

    /** 游戏下载引擎：清单 / 安装 / 取消 / 连通性 */
    private val installer = GameInstaller(
        gameDir = { File(gameDirPath()) },
        sourceName = { sourceName() },
        emit = { channel, data -> emit(channel, data) },
        setStatus = { text -> emit("app:status", JSONObject().put("text", text).put("busy", true)) }
    )

    /** 图标磁盘缓存：<files>/icon-cache/<项目id>（对应桌面端 ICON_CACHE） */
    private val iconCache = File(ctx.filesDir, "icon-cache").apply { mkdirs() }

    /** 加载器探针 / 可选版本列表（与桌面端 probeLoaderBuilds / loaderBuildsOf 对齐） */
    private val loaderProbe = LoaderProbe()

    /** Modrinth / CurseForge 接口层（搜索、详情、下载） */
    private val api = ModrinthApi(ctx) { iconCache }

    /** MOD 目录管理（列表 / 启用禁用 / 删除 / 元数据富化） */
    private val modsManager = ModsManager({ File(gameDirPath()) }, api)

    /** MOD / 资源包 / 数据包 / 整合包 / 自定义文件 的下载安装 */
    private val modInstaller = ModInstaller(
        gameDir = { File(gameDirPath()) },
        installer = installer,
        api = api,
        modsManager = modsManager,
        emit = { channel, data -> emit(channel, data) },
        setStatus = { text -> emit("app:status", JSONObject().put("text", text).put("busy", true)) }
    )

    /** Java 运行时：下载（.tar.xz）/ 解压 / 注册 / 运行验证（需要存储权限） */
    private val javaInstaller = JavaInstaller(
        ctx = ctx,
        activityRef = { ctx as? MainActivity },
        emit = { channel, data -> emit(channel, data) }
    )

    /** 多账号体系：离线 / 微软（内置 WebView 登录）/ 第三方（authlib-injector） */
    private val accounts = AccountManager(
        ctx = ctx,
        activityRef = { ctx as? MainActivity },
        prefs = prefs,
        emit = { channel, data -> emit(channel, data) }
    )

    init {
        // 启动时后台静默续期微软 / authlib 令牌（失败不打扰，与桌面端行为一致）
        pool.execute { try { accounts.refreshAll() } catch (_: Throwable) {} }
    }

    /* ==================================================================
     * 原生 → JS 事件推送（对应桌面端的 send()）
     *
     * 桌面端：webContents.send(channel, data) → preload 里转发给 ipcRenderer.on
     * 安卓端：WebView 没有事件总线，直接用 evaluateJavascript 调渲染层的
     *         window.__xlcEmit(channel, json)（见 mobile-bridge.js）。
     * ================================================================== */
    private fun emit(channel: String, data: JSONObject) {
        val js = "window.__xlcEmit(" + JSONObject.quote(channel) +
            ", " + JSONObject.quote(data.toString()) + ")"
        webView.post {
            try {
                webView.evaluateJavascript(js, null)
            } catch (e: Throwable) { /* WebView 已销毁，忽略 */ }
        }
    }

    /* ==================================================================
     * 入口：JS → 原生
     * ================================================================== */
    @JavascriptInterface
    fun invoke(method: String, argsJson: String, cbId: String) {
        val args = parseArgs(argsJson)

        // 确认框要弹原生对话框、等用户点完才回调，不能占用线程池，单独走一条路径
        if (method == "ui:confirm") {
            askConfirm(args.optJSONObject(0), cbId)
            return
        }

        pool.execute {
            val out = try {
                dispatch(method, args).toString()
            } catch (t: Throwable) {
                JSONObject().put("ok", false)
                    .put("error", "接口 $method 异常: ${t.message}").toString()
            }
            respond(cbId, out)
        }
    }

    fun shutdown() {
        try { pool.shutdownNow() } catch (e: Throwable) { /* 忽略 */ }
    }

    /* ==================================================================
     * 路由
     * ================================================================== */
    private fun dispatch(m: String, a: JSONArray): Any = when (m) {

        /* ---------- 配置 ---------- */
        "config:get" -> configGet()
        "config:save" -> configSave(a.optJSONObject(0))

        /* ---------- 系统 / 剪贴板 / 外链 ---------- */
        "sys:meminfo" -> sysMem()
        "clipboard:write" -> clipboardWrite(a.optString(0, ""))
        "shell:open-external" -> openExternal(a.optString(0, ""))
        "shell:open" -> JSONObject().put("ok", false).put("error", "移动端暂不支持打开本地目录")
        "app:renderer-error" -> JSONObject().put("ok", true)

        /* ---------- 窗口控制（安卓侧映射为任务栈操作） ---------- */
        "win:close" -> winClose()
        "win:minimize" -> winMinimize()
        "win:maximize-toggle" -> JSONObject().put("ok", true)

        /* ---------- 个性化 ---------- */
        "personalize:get-bg" -> JSONObject().put("ok", false)
        "personalize:pick-bg" -> JSONObject().put("ok", false).put("canceled", true)

        /* ---------- 游戏目录 / Java / 版本清单 ---------- */
        "dir:scan" -> dirScan()
        "dir:pick" -> JSONObject().put("ok", false).put("canceled", true)
        "java:detect" -> javaInstaller.detect()
        "java:download" -> javaInstaller.download(a.optInt(0, 21))
        "java:test" -> javaInstaller.test(a.optInt(0, 21))
        "java:remove" -> javaInstaller.remove(a.optInt(0, 21))
        "java:overview" -> javaInstaller.overview()
        "java:storage-status" -> storageStatus()
        "java:storage-request" -> storageRequest()
        "manifest:get" -> manifestGet()
        "net:ping" -> installer.ping()

        /* ---------- 游戏安装（真实下载） ---------- */
        "install:start" -> installer.startInstall(a.optJSONObject(0))
        "install:cancel" -> installCancel(a.optJSONObject(0))

        /* ---------- 加载器探针 / 版本列表 / OptiFine / 更改卸载（对齐桌面端） ---------- */
        "loader:probe" -> loaderProbe.probe(a.optString(0), a.optString(1), a.optBoolean(2))
        "loader:builds" -> loaderProbe.buildsOf(a.optString(0), a.optString(1))
        "optifine:asMod" -> installer.optifineAsMod(a.optString(0), a.optString(1))
        "version:loader-change" -> installer.loaderChange(a.optJSONObject(0))
        "version:loader-uninstall" -> installer.loaderUninstall(a.optJSONObject(0))

        /* ---------- 资源下载：搜索 / 详情 / 安装 ---------- */
        "modrinth:search" -> modrinthSearch(a.optJSONObject(0))
        "modrinth:detail" -> modrinthDetail(a.optJSONObject(0))
        // 中文名由内置库（1 万+ 条）直接给出，不需要远端二次翻译
        "modrinth:translate" -> JSONObject().put("ok", false).put("error", "no-origin")
        // cfwidget 响应常达 20s+，移动端不额外拉取（详情里已有 summary）
        "modrinth:cf-desc" -> JSONObject().put("ok", true).put("descHtml", "")
        "modrinth:install-mod" -> modInstaller.installMod(a.optJSONObject(0) ?: JSONObject())
        "modrinth:install-pack" -> modInstaller.installPack(a.optJSONObject(0) ?: JSONObject())
        "modrinth:install-modpack" -> modInstaller.installModpack(a.optJSONObject(0) ?: JSONObject())

        /* ---------- 自定义文件下载（光影包 / 任意直链） ---------- */
        "custom:download" -> modInstaller.customDownload(a.optJSONObject(0) ?: JSONObject())

        /* ---------- MOD 管理 ---------- */
        "mods:list" -> modsManager.list(a.optJSONObject(0)?.optString("instance"))
        "mods:toggle" -> modsManager.toggle(
            a.optJSONObject(0)?.optString("name"), a.optJSONObject(0)?.optString("instance")
        )
        "mods:delete" -> modsManager.delete(
            a.optJSONObject(0)?.optString("name"), a.optJSONObject(0)?.optString("instance")
        )
        "mods:enrich" -> modsManager.enrich(
            a.optJSONObject(0)?.optString("instance"),
            (a.optJSONObject(0)?.optJSONArray("names") ?: JSONArray()).let { arr ->
                (0 until arr.length()).map { arr.optString(it) }
            }
        )

        /* ---------- 存档 / 版本信息 ---------- */
        "saves:list" -> savesList()
        "saves:delete" -> savesDelete(a.optJSONObject(0)?.optString("path").orEmpty())
        "saves:preview" -> JSONObject().put("ok", false).put("error", "移动端暂不支持存档预览图")
        "version:info" -> versionInfo(a.optJSONObject(0)?.optString("id").orEmpty())

        /* ---------- 实例管理 ---------- */
        "instance:delete" -> instanceDelete(a.optJSONObject(0)?.optString("id").orEmpty())
        "instance:rename" -> instanceRename(
            a.optJSONObject(0)?.optString("id").orEmpty(), a.optJSONObject(0)?.optString("name").orEmpty()
        )

        /* ---------- 账户（离线 / 微软 / 第三方 authlib） ---------- */
        "account:list" -> accounts.list()
        "account:add" -> accounts.add(a.optJSONObject(0))
        "account:switch" -> accounts.switchAcc(a.optJSONObject(0))
        "account:rename" -> accounts.rename(a.optJSONObject(0))
        "account:delete" -> accounts.delete(a.optJSONObject(0))
        "account:skin" -> accounts.skin(a.optJSONObject(0))
        "account:skin-remove" -> accounts.skinRemove(a.optJSONObject(0))
        "account:model" -> accounts.model(a.optJSONObject(0))
        // 微软默认流程：内置 WebView 打开微软官方登录页（零配置）
        "account:ms-web-login" -> accounts.msWebLogin(a.optJSONObject(0))
        "account:ms-web-cancel" -> accounts.msWebCancel()
        "account:ms-app-info" -> accounts.msAppInfo()
        "account:ms-net-check" -> accounts.msNetCheck()
        // 备用流程：自建 Azure 应用（环回回调由 WebView 截获）
        "account:ms-login-start" -> accounts.msLoginStart(a.optJSONObject(0))
        "account:ms-login-wait" -> accounts.msLoginWait(a.optJSONObject(0))
        "account:ms-login-cancel" -> accounts.msLoginCancel()
        // 备用流程：设备码
        "account:ms-start" -> accounts.msStart(a.optJSONObject(0))
        "account:ms-poll" -> accounts.msPoll(a.optJSONObject(0))
        // 第三方外置登录（authlib-injector / Blessing Skin）
        "account:authlib-detect" -> accounts.authlibDetect(a.optJSONObject(0))
        "account:authlib-login" -> accounts.authlibLogin(a.optJSONObject(0))

        /* ---------- 好友 ---------- */
        "friends:get" -> JSONObject().put("ok", true)
            .put("code", friendCode()).put("friends", JSONArray())
        "friends:presence" -> JSONObject().put("ok", true).put("list", JSONArray())
        "friends:signal-poll" -> JSONObject().put("ok", true)
            .put("myCode", friendCode()).put("signals", JSONArray())

        /* ---------- 插件 ---------- */
        "plugin:list" -> JSONObject().put("ok", true).put("plugins", JSONArray())
        "plugin:seedmap-platforms" -> JSONArray()

        /* ---------- 启动器更新：移动端不参与桌面端的自更新 ---------- */
        "update:changelog" -> JSONObject().put("ok", true)
            .put("current", BuildConfig.VERSION_NAME)
            .put("entry", JSONObject.NULL)
            .put("list", JSONArray())
            .put("unseen", false)
        "update:seen" -> JSONObject().put("ok", true).put("version", BuildConfig.VERSION_NAME)
        "update:cached" -> JSONObject.NULL
        "update:check" -> JSONObject().put("ok", true).put("hasUpdate", false)
        "update:ignore" -> JSONObject().put("ok", true)

        /* ---------- 其余未接入能力 ---------- */
        else -> stub()
    }

    private fun stub(): JSONObject =
        JSONObject().put("ok", false).put("error", TODO_MSG).put("mobileStub", true)

    /* ==================================================================
     * 配置
     * ================================================================== */
    private fun configGet(): JSONObject {
        val c = JSONObject(DEFAULT_CONFIG)
        // 本地持久化的改动覆盖默认值
        for (k in prefs.all.keys) {
            val v = prefs.all[k] ?: continue
            c.put(k, v)
        }
        c.put("accounts", accounts.sanitizedArray())    // 脱敏后的账户列表（令牌不进渲染层）
        c.put("activeAccount", accounts.activeName())
        c.put("username", accounts.activeName())
        c.put("gameDir", gameDirPath())
        c.put("appVersion", BuildConfig.VERSION_NAME)
        c.put("updateDefaultUrl", "")
        c.put("updateLocked", true)
        c.put("portableMode", false)
        return c
    }

    private fun configSave(patch: JSONObject?): JSONObject {
        if (patch != null) {
            val e = prefs.edit()
            val keys = patch.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                when (val v = patch.get(k)) {
                    is Boolean -> e.putBoolean(k, v)
                    is Int -> e.putInt(k, v)
                    is Long -> e.putLong(k, v)
                    is Double -> e.putFloat(k, v.toFloat())
                    is String -> e.putString(k, v)
                    else -> e.putString(k, v.toString())
                }
            }
            e.apply()
        }
        return JSONObject().put("ok", true)
    }

    /* ==================================================================
     * 系统信息
     * ================================================================== */
    private fun sysMem(): JSONObject {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        val total = round1(mi.totalMem.toDouble() / 1073741824.0)
        val avail = round1(mi.availMem.toDouble() / 1073741824.0)
        return JSONObject().put("ok", true)
            .put("totalGB", total)
            .put("availGB", avail)
            .put("recommendGB", recommendMem(total, avail))
    }

    private fun round1(v: Double): Double = Math.round(v * 10.0) / 10.0

    /** 与桌面端 smartMemGB() 同思路：按总量分档，再按可用内存收紧 */
    private fun recommendMem(total: Double, avail: Double): Int {
        val rec = when {
            total <= 4 -> 2
            total <= 6 -> 3
            total <= 8 -> 4
            total <= 16 -> 6
            else -> 8
        }
        val byAvail = Math.floor(avail * 0.6).toInt()
        return Math.max(1, Math.min(rec, Math.max(1, byAvail)))
    }

    /* ==================================================================
     * 版本清单 / 安装
     * ================================================================== */
    private fun manifestGet(): JSONObject = try {
        JSONObject().put("ok", true)
            .put("manifest", installer.fetchManifest())
            .put("via", sourceName())
    } catch (e: Exception) {
        JSONObject().put("ok", false).put("error", e.message ?: "清单获取失败")
    }

    private fun installCancel(p: JSONObject?): JSONObject {
        val id = p?.optString("id").orEmpty()
        val loader = p?.optString("loader").orEmpty().ifEmpty { "Vanilla" }
        val ok = installer.cancel("$id|$loader")
        return if (ok) JSONObject().put("ok", true)
        else JSONObject().put("ok", false).put("error", "该任务不在进行中")
    }

    /* ==================================================================
     * 资源搜索 / 详情
     * ================================================================== */
    private fun modrinthSearch(p: JSONObject?): JSONObject = try {
        api.search(
            query = p?.optString("query").orEmpty(),
            type = p?.optString("type").orEmpty().ifEmpty { "mod" },
            mcVersion = p?.optString("mcVersion").orEmpty(),
            loader = p?.optString("loader").orEmpty(),
            page = p?.optInt("page", 1) ?: 1,
            source = p?.optString("source").orEmpty().ifEmpty { "modrinth" }
        )
    } catch (e: Exception) {
        JSONObject().put("ok", false).put("error", e.message ?: "搜索失败")
    }

    private fun modrinthDetail(p: JSONObject?): JSONObject = try {
        val versionId = p?.optString("versionId").orEmpty()
        var mcVer = ""
        var loaderLc = ""
        if (versionId.isNotEmpty()) {
            val c = installer.resolveVersionContext(versionId)
            if (c.optBoolean("ok")) {
                mcVer = c.optString("rootId")
                loaderLc = c.optString("loaderLc")
            }
        }
        api.detail(
            projectId = p?.optString("projectId").orEmpty(),
            versionId = versionId,
            source = p?.optString("source").orEmpty().ifEmpty { "modrinth" },
            mcVer = mcVer,
            loaderLc = loaderLc
        )
    } catch (e: Exception) {
        JSONObject().put("ok", false).put("error", e.message ?: "详情加载失败")
    }

    /* ==================================================================
     * 存档
     * ================================================================== */
    private fun savesList(): JSONObject = try {
        val gd = File(gameDirPath())
        val out = JSONArray()

        // 全局 saves/ + 各实例的 versions/<id>/saves/（版本隔离存档）
        val roots = mutableListOf<Pair<File, String>>(File(gd, "saves") to "")
        File(gd, "versions").listFiles()?.forEach { v ->
            if (v.isDirectory) File(v, "saves").takeIf { it.isDirectory }?.let { roots.add(it to v.name) }
        }

        for ((root, instance) in roots) {
            root.listFiles()?.forEach { s ->
                if (!s.isDirectory) return@forEach
                if (!File(s, "level.dat").isFile) return@forEach
                val data = Nbt.readLevelDat(File(s, "level.dat")).let { Nbt.compound(it?.get("Data")) }
                val dims = JSONArray()
                var regions = 0
                File(s, "region").takeIf { it.isDirectory }?.let { r ->
                    val n = r.listFiles()?.count { it.name.endsWith(".mca") } ?: 0
                    if (n > 0) { dims.put(JSONObject().put("key", "overworld").put("label", "主世界").put("count", n)); regions += n }
                }
                val icon: String? = try {
                    val f = File(s, "icon.png")
                    if (f.isFile && f.length() < 300 * 1024) Net.dataUri(f.readBytes(), 300 * 1024).ifEmpty { null } else null
                } catch (e: Throwable) { null }
                val diff = data?.let { Nbt.asLong(it["Difficulty"]) }?.toInt() ?: 2
                out.put(
                    JSONObject()
                        .put("name", s.name).put("path", s.absolutePath).put("instance", instance)
                        .put("levelName", data?.get("LevelName")?.toString().orEmpty())
                        .put("seed", Nbt.seedOf(data ?: emptyMap()) ?: JSONObject.NULL)
                        .put("lastPlayed", Nbt.asLong(data?.get("LastPlayed")) ?: 0L)
                        .put("mcVersion", Nbt.compound(data?.get("Version"))?.get("Name")?.toString()
                            ?: data?.get("Version")?.toString().orEmpty())
                        .put("gameType", Nbt.asLong(data?.get("GameType"))?.toInt() ?: 0)
                        .put("hardcore", Nbt.asLong(data?.get("hardcore"))?.toInt() == 1)
                        .put("day", (Nbt.asLong(data?.get("DayTime")) ?: 0L) / 24000L)
                        .put("difficulty", diff)
                        .put("difficultyName", listOf("和平", "简单", "普通", "困难").getOrElse(diff) { "普通" })
                        .put("size", dirSize(s))
                        .put("hasRegion", regions > 0).put("regions", regions).put("dims", dims)
                        .put("icon", icon ?: JSONObject.NULL)
                        .put("legacy", regions == 0)
                )
            }
        }
        // 按最后游玩时间倒序
        val sorted = (0 until out.length()).mapNotNull { out.optJSONObject(it) }
            .sortedByDescending { it.optLong("lastPlayed") }
        JSONObject().put("ok", true).put("gameDir", gd.absolutePath).put("saves", JSONArray(sorted))
    } catch (e: Exception) {
        JSONObject().put("ok", false).put("error", e.message ?: "存档扫描失败").put("saves", JSONArray())
    }

    private fun savesDelete(path: String): JSONObject {
        val gd = File(gameDirPath()).absolutePath
        val f = File(path)
        // 只允许删游戏目录下的存档，防止越界删除
        if (!f.absolutePath.startsWith(gd)) return JSONObject().put("ok", false).put("error", "路径不在游戏目录内")
        if (!f.isDirectory) return JSONObject().put("ok", false).put("error", "存档不存在")
        return if (f.deleteRecursively()) JSONObject().put("ok", true)
        else JSONObject().put("ok", false).put("error", "删除失败")
    }

    private fun dirSize(f: File): Long {
        var total = 0L
        val stack = ArrayDeque<File>()
        stack.addLast(f)
        var guard = 0
        while (stack.isNotEmpty() && guard++ < 20000) {
            val cur = stack.removeLast()
            val kids = cur.listFiles() ?: continue
            for (k in kids) if (k.isDirectory) stack.addLast(k) else total += k.length()
        }
        return total
    }

    /* ==================================================================
     * 版本信息 / 实例管理
     * ================================================================== */
    private fun versionInfo(id: String): JSONObject {
        if (id.isEmpty() || File(id).name != id) return JSONObject().put("ok", false).put("error", "实例名无效")
        val ctx = installer.resolveVersionContext(id)
        if (!ctx.optBoolean("ok")) return JSONObject().put("ok", false).put("error", ctx.optString("error"))
        val gd = File(gameDirPath())
        val iDir = File(gd, "versions/$id")

        // 是否被别的实例继承（继承链顶端不能改加载器，会弄坏子版本）
        val children = JSONArray()
        File(gd, "versions").listFiles()?.forEach { sub ->
            if (!sub.isDirectory) return@forEach
            val jf = File(sub, "${sub.name}.json")
            if (!jf.isFile) return@forEach
            try {
                if (JSONObject(jf.readText(Charsets.UTF_8)).optString("inheritsFrom") == id) children.put(sub.name)
            } catch (e: Throwable) {}
        }

        // 加载器版本号：从 libs 里的 fabric-loader / quilt-loader 坐标提取
        var loaderVer = ""
        File(iDir, "$id.json").takeIf { it.isFile }?.let { jf ->
            try {
                val hay = JSONObject(jf.readText(Charsets.UTF_8)).optJSONArray("libraries")?.toString().orEmpty()
                Regex("(?:fabric|quilt)-loader:([0-9][\\w.+-]*)").find(hay)?.let { loaderVer = it.groupValues[1] }
                    ?: Regex("(?:neoforge|forge):([0-9][\\w.+-]*)").find(hay)?.let { loaderVer = it.groupValues[1] }
            } catch (e: Throwable) {}
        }

        return JSONObject().put("ok", true).put("id", id)
            .put("mcVer", ctx.optString("rootId"))
            .put("loader", ctx.optString("loader"))
            .put("loaderVer", loaderVer)
            .put("isolated", File(iDir, "mods").isDirectory || File(iDir, "saves").isDirectory)
            .put("hasChildren", children.length() > 0)
            .put("children", children)
    }

    private fun instanceDelete(id: String): JSONObject {
        if (id.isEmpty() || File(id).name != id) return JSONObject().put("ok", false).put("error", "实例名无效")
        val gd = File(gameDirPath())
        val dir = File(gd, "versions/$id")
        if (!dir.isDirectory) return JSONObject().put("ok", false).put("error", "实例不存在")
        // 被继承的实例不能直接删（会弄坏子版本）
        val children = JSONArray()
        File(gd, "versions").listFiles()?.forEach { sub ->
            if (!sub.isDirectory || sub.name == id) return@forEach
            val jf = File(sub, "${sub.name}.json")
            if (!jf.isFile) return@forEach
            try {
                if (JSONObject(jf.readText(Charsets.UTF_8)).optString("inheritsFrom") == id) children.put(sub.name)
            } catch (e: Throwable) {}
        }
        if (children.length() > 0) {
            return JSONObject().put("ok", false)
                .put("error", "该实例被 ${(0 until children.length()).joinToString(", ") { children.optString(it) }} 继承，请先删除它们")
        }
        val ok = dir.deleteRecursively()
        return if (ok) JSONObject().put("ok", true) else JSONObject().put("ok", false).put("error", "删除失败")
    }

    private fun instanceRename(id: String, newName: String): JSONObject {
        if (id.isEmpty() || newName.isEmpty()) return JSONObject().put("ok", false).put("error", "名称不能为空")
        val safe = installer.sanitizeId(newName)
        if (safe.isEmpty()) return JSONObject().put("ok", false).put("error", "名称无效")
        if (safe == id) return JSONObject().put("ok", true).put("id", safe)
        val gd = File(gameDirPath())
        val oldDir = File(gd, "versions/$id")
        val newDir = File(gd, "versions/$safe")
        if (!oldDir.isDirectory) return JSONObject().put("ok", false).put("error", "实例不存在")
        if (newDir.exists()) return JSONObject().put("ok", false).put("error", "已存在同名实例: $safe")
        if (!oldDir.renameTo(newDir)) return JSONObject().put("ok", false).put("error", "重命名失败")
        // 同步 json 内部 id 与文件名（dir:scan 要求 <目录名>.json 且 id 一致）
        try {
            val oldJson = File(newDir, "$id.json")
            if (oldJson.isFile) {
                val j = JSONObject(oldJson.readText(Charsets.UTF_8))
                j.put("id", safe)
                val nj = File(newDir, "$safe.json")
                nj.writeText(j.toString(2), Charsets.UTF_8)
                if (nj.absolutePath != oldJson.absolutePath) oldJson.delete()
            }
            // 继承的子实例指向要跟着改
            File(gd, "versions").listFiles()?.forEach { sub ->
                if (!sub.isDirectory) return@forEach
                val jf = File(sub, "${sub.name}.json")
                if (!jf.isFile) return@forEach
                try {
                    val j = JSONObject(jf.readText(Charsets.UTF_8))
                    if (j.optString("inheritsFrom") == id) {
                        j.put("inheritsFrom", safe)
                        jf.writeText(j.toString(2), Charsets.UTF_8)
                    }
                } catch (e: Throwable) {}
            }
        } catch (e: Throwable) {
            Log.w("XLC-Bridge", "重命名后更新 json 失败: ${e.message}")
        }
        return JSONObject().put("ok", true).put("id", safe)
    }

    /* ==================================================================
     * 存储权限（Java 安装 / 游戏目录的前置条件）
     * ================================================================== */

    private fun storageStatus(): JSONObject = JSONObject()
        .put("ok", true)
        .put("granted", StoragePerm.has(ctx))
        .put("level", StoragePerm.level(ctx))
        .put("needsSettingsPage", StoragePerm.needsSettingsPage())
        .put("sharedRoot", StoragePerm.sharedRoot(ctx).absolutePath)

    /** 同步返回授权结果（内部会把系统界面拉起来并等待） */
    private fun storageRequest(): JSONObject {
        val act = ctx as? MainActivity
            ?: return JSONObject().put("ok", StoragePerm.has(ctx))
                .put("granted", StoragePerm.has(ctx))
        val latch = java.util.concurrent.CountDownLatch(1)
        var granted = false
        act.runOnUiThread {
            act.requestStorage { ok ->
                granted = ok
                latch.countDown()
            }
        }
        try { latch.await(180, java.util.concurrent.TimeUnit.SECONDS) } catch (e: Throwable) { }
        return JSONObject().put("ok", granted).put("granted", granted)
            .put("level", StoragePerm.level(ctx))
    }

    /* ==================================================================
     * 目录扫描
     * ================================================================== */
    private fun dirScan(): JSONObject {
        val gd = File(gameDirPath())
        val versions = JSONArray()
        val saves = JSONArray()
        val broken = JSONArray()

        val vDir = File(gd, "versions")
        if (vDir.isDirectory) {
            vDir.listFiles()?.forEach { sub ->
                if (!sub.isDirectory) return@forEach
                val json = File(sub, "${sub.name}.json")
                if (!json.isFile) {
                    broken.put(
                        JSONObject().put("folder", sub.name)
                            .put("path", sub.absolutePath)
                            .put("reason", "缺少 ${sub.name}.json")
                    )
                    return@forEach
                }
                // 读版本 json 判断真实加载器与继承关系。
                // 注意：实例重命名后 id / inheritsFrom 里不再含 loader 字样，
                // 所以只能看 libraries / mainClass，不能用名字正则判断。
                var loader = "Vanilla"
                var inheritsFrom = ""
                try {
                    val j = JSONObject(json.readText(Charsets.UTF_8))
                    loader = detectLoader(j)
                    inheritsFrom = j.optString("inheritsFrom")
                } catch (e: Throwable) {
                    // json 损坏：仍按原版条目列出，用户可在界面重装修复
                }
                versions.put(
                    JSONObject().put("id", sub.name)
                        .put("folder", sub.name)
                        .put("loader", loader)
                        .put("inherits", inheritsFrom.isNotEmpty())
                        .put("hasJar", File(sub, "${sub.name}.jar").isFile)
                        .put("mcVersion", if (inheritsFrom.isEmpty()) sub.name else inheritsFrom)
                )
            }
        }

        File(gd, "saves").listFiles()?.forEach { s ->
            if (s.isDirectory) saves.put(JSONObject().put("name", s.name).put("path", s.absolutePath))
        }

        return JSONObject().put("gameDir", gd.absolutePath)
            .put("exists", gd.isDirectory)
            .put("versions", versions)
            .put("saves", saves)
            .put("broken", broken)
    }

    /** 加载器识别：与桌面端 detectLoaderOf 同思路（看 libraries 与 mainClass） */
    private fun detectLoader(j: JSONObject): String {
        /* Android org.json 会把 "/" 转义成 "\/"，先还原再匹配（见 GameInstaller.detectLoaderName） */
        val hay = (j.optJSONArray("libraries")?.toString() ?: "").replace("\\/", "/") +
            " " + j.optString("mainClass")
        return when {
            /* Quilt 复用 net.fabricmc:intermediary 等 fabric 坐标 → 必须先查 quiltmc，
               否则 Quilt 实例会被误判成 Fabric（桌面端 detectLoaderOf 顺序是 fabric 在前，有同款问题） */
            hay.contains("/quiltmc/") -> "Quilt"
            hay.contains("/fabricmc/") -> "Fabric"
            hay.contains("/neoforged/") -> "NeoForge"
            hay.contains("/minecraftforge/") -> "Forge"
            hay.contains("/optifine/") -> "OptiFine"
            else -> "Vanilla"
        }
    }

    /** 游戏目录：安卓上前期固定放在应用私有目录，后续接入 SAF 让用户自选 */
    private fun gameDirPath(): String {
        val d = File(ctx.filesDir, "minecraft")
        if (!d.exists()) d.mkdirs()
        return d.absolutePath
    }

    /* ==================================================================
     * 剪贴板 / 外链 / 窗口
     * ================================================================== */
    private fun clipboardWrite(text: String): JSONObject = try {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("XLC", text))
        JSONObject().put("ok", true)
    } catch (e: Throwable) {
        JSONObject().put("ok", false).put("error", e.message)
    }

    private fun openExternal(url: String): JSONObject = try {
        val i = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(i)
        JSONObject().put("ok", true)
    } catch (e: Throwable) {
        JSONObject().put("ok", false).put("error", "无法打开链接: ${e.message}")
    }

    private fun winClose(): JSONObject {
        (ctx as? Activity)?.runOnUiThread { (ctx as Activity).finish() }
        return JSONObject().put("ok", true)
    }

    private fun winMinimize(): JSONObject {
        (ctx as? Activity)?.runOnUiThread { (ctx as Activity).moveTaskToBack(true) }
        return JSONObject().put("ok", true)
    }

    /* ==================================================================
     * 确认框：替代桌面端的原生 dialog.showMessageBox
     * ================================================================== */
    private fun askConfirm(o: JSONObject?, cbId: String) {
        val act = ctx as? Activity
        if (act == null) {
            respond(cbId, JSONObject().put("ok", false).put("error", "无界面上下文").toString())
            return
        }
        act.runOnUiThread {
            try {
                val msg = o?.optString("message").orEmpty()
                val detail = o?.optString("detail").orEmpty()
                val full = if (detail.isNotEmpty()) "$msg\n\n$detail" else msg
                val okText = o?.optString("okText").orEmpty().ifEmpty { "确定" }
                val cancelText = o?.optString("cancelText").orEmpty().ifEmpty { "取消" }
                AlertDialog.Builder(act)
                    .setMessage(full)
                    .setPositiveButton(okText) { _, _ ->
                        respond(cbId, JSONObject().put("ok", true).toString())
                    }
                    .setNegativeButton(cancelText) { _, _ ->
                        respond(cbId, JSONObject().put("ok", false).toString())
                    }
                    .setCancelable(false)
                    .show()
            } catch (e: Throwable) {
                respond(cbId, JSONObject().put("ok", false).put("error", e.message).toString())
            }
        }
    }

    /* ==================================================================
     * 工具
     * ================================================================== */
    private fun parseArgs(json: String?): JSONArray = try {
        if (json.isNullOrBlank()) JSONArray() else JSONArray(json)
    } catch (e: Exception) {
        JSONArray()
    }

    /** 回推结果：cbId 必须来自 JS 侧的自增序号，这里做一次白名单校验 */
    private fun respond(cbId: String, json: String) {
        if (cbId.isEmpty() || !cbId.all { it.isDigit() }) return
        webView.post {
            try {
                webView.evaluateJavascript(
                    "window.__xlcResolve($cbId, ${JSONObject.quote(json)})", null
                )
            } catch (e: Throwable) { /* WebView 已销毁，忽略 */ }
        }
    }

    /** 本机专属好友码：生成一次后终身不变（与桌面端同格式 XXXX-XXXX-XXXX） */
    private fun friendCode(): String {
        val saved = prefs.getString(KEY_FRIEND_CODE, null)
        if (!saved.isNullOrEmpty()) return saved
        val chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        val sb = StringBuilder()
        repeat(12) { sb.append(chars[(Math.random() * chars.length).toInt()]) }
        val code = sb.substring(0, 4) + "-" + sb.substring(4, 8) + "-" + sb.substring(8, 12)
        prefs.edit().putString(KEY_FRIEND_CODE, code).apply()
        return code
    }

    companion object {
        private const val PREFS_NAME = "xlc.config"
        private const val KEY_FRIEND_CODE = "friendCode"
        private const val TODO_MSG = "移动端尚未接入此功能"

        /** 与桌面端 main.js 的 DEFAULT_CONFIG 保持同构（字段名必须一致） */
        private val DEFAULT_CONFIG = """
        {
          "source": "bmclapi",
          "customSource": "",
          "javaPath": "",
          "mem": 4,
          "memAuto": true,
          "jvmArgs": "",
          "forceChinese": true,
          "defaultVersion": "",
          "lastVersion": "",
          "username": "Steve",
          "accounts": [],
          "msClientId": "",
          "activeAccount": "",
          "bgMode": "default",
          "bgColor": "",
          "accentColor": "",
          "bgImage": "",
          "recent": [],
          "friendCode": "",
          "friends": [],
          "aiApi": { "base": "", "key": "", "model": "gpt-4o-mini" },
          "plugins": {},
          "updateUrl": "",
          "autoCheckUpdate": true,
          "ignoredVersion": "",
          "lastUpdateCheck": 0,
          "seenVersion": ""
        }
        """.trimIndent()
    }
}
