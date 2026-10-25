package com.xlc.launcher

import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.ZipInputStream

/**
 * 安卓端游戏下载 / 安装引擎。
 *
 * 与桌面端 main.js 的 installVanillaFiles() 保持同一套阶段划分与进度语义，
 * 这样渲染层的进度条 / 状态文案不需要任何改动：
 *
 *   json 2% → client 5% → libraries 8~30% → assets-index 32%
 *        → assets 32~94% → natives 96% → done 100%
 *
 * 平台差异说明（关键）：
 *   Minecraft 的 rules 里 os.name 只认 windows / linux / osx。
 *   安卓内核是 Linux，因此这里把 OS_NAME 固定为 "linux" —— 这样筛出来的
 *   libraries 与 natives（.so）在 x86_64 模拟器上是真实可用的，
 *   为后续接入 JRE / 图形转译留好了地基。
 *
 * 取消语义：桌面端靠 installCancelReq 集合 + 每次下载前 chkCancel()。
 * 这里同样用一个 AtomicBoolean 标志，下载池里的 worker 每项开工前检查，
 * 命中即抛 CancelledException 中止整个池。
 */
class GameInstaller(
    private val gameDir: () -> File,
    private val sourceName: () -> String,
    private val emit: (String, JSONObject) -> Unit,
    private val setStatus: (String) -> Unit
) {

    /** 每个任务一个取消标志，键 = "id|loader"，与桌面端 installing/installCancelReq 同构 */
    private val cancels = ConcurrentHashMap<String, AtomicBoolean>()

    fun isRunning(key: String): Boolean = cancels.containsKey(key)

    fun cancel(key: String): Boolean {
        val flag = cancels[key] ?: return false
        flag.set(true)
        Log.i(TAG, "收到取消请求: $key")
        return true
    }

    /* ==================================================================
     * 版本清单
     * ================================================================== */

    @Throws(IOException::class)
    fun fetchManifest(): JSONObject {
        val order = if (sourceName() == "official") {
            listOf(MANIFEST_OFFICIAL, MANIFEST_BMCLAPI)
        } else {
            listOf(MANIFEST_BMCLAPI, MANIFEST_OFFICIAL)
        }
        var last: Exception? = null
        for (url in order) {
            try {
                return JSONObject(String(httpGet(url), Charsets.UTF_8))
            } catch (e: Exception) {
                last = e
                Log.w(TAG, "清单源不可用 $url: ${e.message}")
            }
        }
        throw IOException("版本清单获取失败（官方源与镜像源均不可达）: ${last?.message}")
    }

    /** 轻量连通性探测：只发 HEAD，不拉正文 */
    fun ping(): JSONObject {
        val url = if (sourceName() == "official") MANIFEST_OFFICIAL else MANIFEST_BMCLAPI
        val t0 = System.currentTimeMillis()
        return try {
            val code = httpHead(url)
            JSONObject().put("ok", code in 200..399)
                .put("ms", (System.currentTimeMillis() - t0).toInt())
                .put("code", code)
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("ms", (System.currentTimeMillis() - t0).toInt())
                .put("error", e.message ?: "网络不可达")
        }
    }

    /* ==================================================================
     * 安装入口
     * ================================================================== */

    /**
     * 启动一个安装任务。立即返回 {started:true}，真正的下载在后台线程跑，
     * 进度通过 install:progress 事件推送、结果通过 install:done 推送。
     * 与桌面端 install:start 的行为一致（渲染层据此判断按钮状态）。
     */
    fun startInstall(payload: JSONObject?): JSONObject {
        val id = payload?.optString("id").orEmpty().trim()
        val loader = payload?.optString("loader").orEmpty().ifEmpty { "Vanilla" }
        val customName = sanitizeVersionId(payload?.optString("customName").orEmpty())
        val reinstall = payload?.optBoolean("reinstall") ?: false
        val build = payload?.optString("build").orEmpty().trim()

        if (id.isEmpty()) return JSONObject().put("started", false).put("reason", "缺少版本号")

        val lc = loader.lowercase()
        // Forge / NeoForge 的安装器是一个 Java 程序（java -jar forge-installer.jar --installClient）。
        // 安卓端还没有可执行 Java，所以这一步只能等 JRE 移植完成后再接 —— 明确告知，不假装成功。
        if (lc == "forge" || lc == "neoforge") {
            return JSONObject().put("started", false).put(
                "reason",
                "$loader 的安装器是一个 Java 程序，需要安卓端先有 Java 运行时（正在移植，属下一阶段）。" +
                    "当前可安装：原版 / Fabric / Quilt / OptiFine（需要已有 Forge 实例作载体）"
            )
        }
        if (lc !in SUPPORTED_LOADERS) {
            return JSONObject().put("started", false).put("reason", "暂不支持的加载器: $loader")
        }

        val key = "$id|$loader"
        if (cancels.containsKey(key)) {
            return JSONObject().put("started", false).put("reason", "该任务已在进行中")
        }
        cancels[key] = AtomicBoolean(false)

        Thread {
            try {
                val versionId = if (lc == "vanilla") {
                    runVanilla(id, customName, reinstall, key)
                } else if (lc == "optifine") {
                    /* OptiFine 本质是个 Forge 模组（桌面端 2026-10-04 实测结论）：
                       不跑安装器，下载 jar 丢进 Forge/NeoForge 实例的 mods/ —— 纯下载可装。 */
                    runOptifine(id, customName, key)
                } else {
                    runFabricLike(id, lc, customName, reinstall, key, build)
                }
                emit("install:done", JSONObject().put("ok", true).put("versionId", versionId).put("loader", loader))
                setStatus("就绪")
            } catch (e: CancelledException) {
                emit("install:done", JSONObject().put("ok", false).put("cancelled", true).put("error", "已取消"))
                setStatus("就绪")
            } catch (t: Throwable) {
                Log.e(TAG, "安装失败", t)
                emit("install:done", JSONObject().put("ok", false).put("error", t.message ?: "安装失败"))
                setStatus("安装失败")
            } finally {
                cancels.remove(key)
            }
        }.apply { isDaemon = true; name = "xlc-install-$id" }.start()

        return JSONObject().put("started", true)
    }

    /**
     * 同步安装「MC 版本 + 加载器」，供整合包导入调用（解析出依赖后才知道要装什么）。
     * 直接在当前线程跑完，返回版本 id。
     */
    @Throws(IOException::class)
    fun installVersionSync(mcVer: String, loader: String, customName: String, cancelKey: String): String {
        val lc = loader.lowercase()
        return when (lc) {
            "vanilla" -> runVanilla(mcVer, customName, false, cancelKey)
            "fabric", "quilt" -> runFabricLike(mcVer, lc, customName, false, cancelKey)
            else -> throw IOException("整合包依赖 $loader 加载器，$loader 的安装器需要 Java 运行时，安卓端尚未接入")
        }
    }

    /**
     * 解析已安装实例的真实 MC 版本与加载器（沿 inheritsFrom 链回溯到根）。
     * 对应桌面端 loadVersionChain + loaderToMr —— MOD 安装必须知道目标实例跑的是什么版本、什么加载器。
     */
    fun resolveVersionContext(versionId: String): JSONObject {
        if (versionId.isEmpty()) return JSONObject().put("ok", false).put("error", "未选择实例")
        val gd = gameDir()
        var cur = versionId
        var loader = "Vanilla"
        var root = versionId
        var depth = 0
        var found = false
        while (depth++ < 10) {
            val vd = File(gd, "versions/$cur")
            val jf = File(vd, "$cur.json")
            if (!jf.isFile) break
            val j = try { JSONObject(jf.readText(Charsets.UTF_8)) } catch (e: Throwable) { break }
            found = true
            val detected = detectLoaderName(j)
            if (detected != "Vanilla") loader = detected
            /* 重建为原版的实例（loader-uninstall 产物）没有 inheritsFrom、目录名也不一定是
               MC 版本号 —— mcVer 记在重建时写入的 xlcMcVersion 字段里，见到它就是根。 */
            val xmc = j.optString("xlcMcVersion")
            if (xmc.isNotEmpty()) { root = xmc; break }
            root = cur
            val parent = j.optString("inheritsFrom")
            if (parent.isEmpty()) break
            cur = parent
        }
        if (!found) return JSONObject().put("ok", false).put("error", "实例不存在或版本 JSON 缺失: $versionId")
        return JSONObject().put("ok", true).put("id", versionId).put("rootId", root)
            .put("loader", loader).put("loaderLc", loaderToMr(loader).orEmpty())
    }

    /** 与桌面端 detectLoaderOf 同思路：只看 libraries / mainClass，不许用名字正则（重命名后名字里没有加载器字样） */
    private fun detectLoaderName(j: JSONObject): String {
        /* Android 的 org.json 会把 "/" 转义成 "\/"，直接 contains("/quiltmc/") 匹配不到
           域名里的坐标段 —— 先把转义还原（与桌面端 JSON.stringify 的行为对齐） */
        val hay = (j.optJSONArray("libraries")?.toString() ?: "").replace("\\/", "/") +
            " " + j.optString("mainClass")
        return when {
            /* Quilt 复用 fabric 的 intermediary 坐标 → quiltmc 必须先查（同 LmcBridge.detectLoader） */
            hay.contains("/quiltmc/") -> "Quilt"
            hay.contains("/fabricmc/") -> "Fabric"
            hay.contains("/neoforged/") -> "NeoForge"
            hay.contains("/minecraftforge/") -> "Forge"
            hay.contains("/optifine/") -> "OptiFine"
            else -> "Vanilla"
        }
    }

    private fun loaderToMr(l: String): String? =
        mapOf("Fabric" to "fabric", "Quilt" to "quilt", "Forge" to "forge", "NeoForge" to "neoforge")[l]

    /* ==================================================================
     * Fabric / Quilt 安装（纯下载，不需要跑任何外部程序）
     * ================================================================== */

    private fun runFabricLike(
        gameVer: String,
        kind: String,
        customName: String,
        reinstall: Boolean,
        cancelKey: String,
        build: String = ""
    ): String {
        val gd = gameDir()
        val label = if (kind == "fabric") "Fabric" else "Quilt"
        val meta = findInManifest(gameVer)

        setStatus("获取 $label 元数据…")
        progress("loader", 4, "获取加载器元数据")

        // Quilt 全球无可用镜像（BMCLAPI 的 quilt-meta 是 404），官方源实测要 22~25s → 给足 30s
        val apiSources: List<Pair<String, Int>> = if (kind == "fabric") listOf(
            "https://meta.fabricmc.net/v2/versions/loader/$gameVer" to 15000,
            "$BMCLAPI/fabric-meta/v2/versions/loader/$gameVer" to 20000
        ) else listOf("https://meta.quiltmc.org/v3/versions/loader/$gameVer" to 30000)

        val list = JSONArray(String(Net.fromSources(apiSources), Charsets.UTF_8))
        if (list.length() == 0) throw IOException("$label 尚未提供 $gameVer 的构建")

        /* build = 用户在「选择版本」下拉里指定的加载器版本（如 0.16.5）。
           指定了却匹配不上必须报错 —— 静默装成最新版等于「选了不生效」（对齐桌面端）。 */
        val wantLoader = build.trim()
        var pick = list.optJSONObject(0) ?: throw IOException("$label 元数据结构异常")
        if (wantLoader.isNotEmpty()) {
            var hit: JSONObject? = null
            for (i in 0 until list.length()) {
                val x = list.optJSONObject(i) ?: continue
                if (x.optJSONObject("loader")?.optString("version") == wantLoader) { hit = x; break }
            }
            if (hit == null) {
                val first3 = (0 until minOf(3, list.length())).mapNotNull {
                    list.optJSONObject(it)?.optJSONObject("loader")?.optString("version")
                }
                throw IOException("$label 未找到加载器版本 $wantLoader（$gameVer 可用: ${first3.joinToString(" / ")} …）")
            }
            pick = hit
        }
        val lm = pick.optJSONObject("launcherMeta") ?: JSONObject()
        val loaderVer = pick.optJSONObject("loader")?.optString("version").orEmpty()
        val versionId = sanitizeVersionId(customName).ifEmpty { "$gameVer-$kind-$loaderVer" }

        // 目标目录占用检查（对应桌面端 instanceStateOf + prepareInstallSlot）
        val vd = File(gd, "versions/$versionId")
        if (vd.isDirectory) {
            if (File(vd, "$versionId.json").isFile && !reinstall) {
                throw IOException("版本 $versionId 已存在（如需重装请勾选重装）")
            }
            Log.i(TAG, "清理残留/重装目录: ${vd.absolutePath}")
            vd.deleteRecursively()
        }

        val mavenBase = if (kind == "fabric") "https://maven.fabricmc.net/" else "https://maven.quiltmc.org/repository/release/"

        // 收集加载器依赖（intermediary + loader 自带库 + launcherMeta 库，去重）
        val libs = ArrayList<JSONObject>()
        val seen = HashSet<String>()
        fun pushLib(name: String, urlBase: String) {
            if (name.isEmpty()) return
            val a = mavenArtifact(name, urlBase)
            val path = a.optJSONObject("downloads")!!.optJSONObject("artifact")!!.optString("path")
            if (!seen.add(path)) return
            libs.add(a)
        }
        pick.optJSONObject("intermediary")?.optString("maven")?.takeIf { it.isNotEmpty() }?.let { pushLib(it, mavenBase) }
        /* loader 本体：新版 meta 把它放在 loader.maven 坐标（launcherMeta.libraries.client 已不含它）。
           漏掉它 = 实例没有 KnotClient 主类，启动直接 ClassNotFound（桌面端同款隐患，别漏）。 */
        pick.optJSONObject("loader")?.optString("maven")?.takeIf { it.isNotEmpty() }?.let { pushLib(it, mavenBase) }
        (pick.optJSONObject("loader")?.opt("libraries") as? JSONArray)?.let { arr ->
            for (i in 0 until arr.length()) {
                val l = arr.optJSONObject(i) ?: continue
                pushLib(l.optString("name"), l.optString("url").ifEmpty { mavenBase })
            }
        }
        val lml = lm.opt("libraries")
        val lmlArr: List<JSONObject> = when (lml) {
            is JSONArray -> (0 until lml.length()).mapNotNull { lml.optJSONObject(it) }
            is JSONObject -> (0 until (lml.optJSONArray("client")?.length() ?: 0)).mapNotNull { lml.optJSONArray("client")?.optJSONObject(it) } +
                (0 until (lml.optJSONArray("common")?.length() ?: 0)).mapNotNull { lml.optJSONArray("common")?.optJSONObject(it) }
            else -> emptyList()
        }
        for (l in lmlArr) pushLib(l.optString("name"), l.optString("url").ifEmpty { mavenBase })

        // 先装父版本（原版资源必须齐全）
        chk(cancelKey)
        runVanilla(gameVer, "", false, cancelKey)

        // 再下加载器依赖
        vd.mkdirs()
        val total = libs.size
        setStatus("下载加载器依赖 (0/$total)")
        var done = 0
        val fails = runPool(total, 10, { d, t ->
            progress("loader-libs", 50 + d * 45 / maxOf(1, t), "加载器依赖 $d/$t", d, t)
        }) { i ->
            chk(cancelKey)
            val art = libs[i].optJSONObject("downloads")!!.optJSONObject("artifact")!!
            val path = art.optString("path")
            val url = art.optString("url")
            val dest = File(gd, "libraries/$path")
            // 官方 maven 慢时退回 BMCLAPI maven 镜像
            try {
                downloadTo(url, dest, null)
            } catch (e: Exception) {
                downloadTo("$BMCLAPI/maven/$path", dest, null)
            }
            done++
        }
        if (fails.isNotEmpty()) throw IOException("${fails.size} 个加载器依赖下载失败，例如 ${fails.first()}")

        // 写 inheritsFrom 版本 json（libraries 里带 maven path，
        // 这样 dir:scan 的 detectLoader 才能靠 "/fabricmc/"、"/quiltmc/" 认出来）
        val vjson = JSONObject()
            .put("id", versionId)
            .put("inheritsFrom", gameVer)
            .put("releaseTime", isoNow())
            .put("time", isoNow())
            .put("type", "release")
            .put("mainClass", lm.optJSONObject("mainClass")?.optString("client").orEmpty()
                .ifEmpty { pick.optJSONObject("loader")?.optString("mainClass").orEmpty() })
            .put("libraries", JSONArray(libs))
        File(vd, "$versionId.json").writeText(vjson.toString(2), Charsets.UTF_8)

        progress("done", 100, "安装完成")
        Log.i(TAG, "安装完成: $versionId → ${vd.absolutePath}")
        return versionId
    }

    /** 把 maven 坐标 net.fabricmc:fabric-loader:0.15.11 展开成可下载的 artifact（对应桌面端 mavenArtifact） */
    private fun mavenArtifact(name: String, urlBase: String): JSONObject {
        val parts = name.split(":")
        val g = parts.getOrElse(0) { "" }
        val a = parts.getOrElse(1) { "" }
        val v = parts.getOrElse(2) { "" }
        val c = parts.getOrElse(3) { "" }
        val file = "$a-$v" + (if (c.isNotEmpty()) "-$c" else "") + ".jar"
        val path = g.replace(".", "/") + "/$a/$v/$file"
        val base = urlBase.ifEmpty { "https://repo1.maven.org/maven2/" }.trimEnd('/')
        return JSONObject().put("name", name).put(
            "downloads",
            JSONObject().put("artifact", JSONObject().put("url", "$base/$path").put("path", path))
        )
    }

    private fun isoNow(): String {
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
        fmt.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return fmt.format(java.util.Date())
    }

    /* ==================================================================
     * OptiFine 安装（以 mod 形式，纯下载，不跑任何安装器）
     * 桌面端 2026-10-04 实测结论：新版 OptiFine 本质就是一个 Forge/NeoForge 模组，
     * 它的官方安装器是无图形环境会卡死的 Swing GUI —— 正确做法是丢进 mods/。
     * ================================================================== */

    private val probe = LoaderProbe()

    /** 安装 OptiFine：找到 Forge/NeoForge 载体实例 → 下载 OptiFine jar 放进其 mods/ */
    private fun runOptifine(mcVer: String, customName: String, cancelKey: String): String {
        val carrier = findForgeLikeInstance(customName)
            ?: throw IOException(
                "OptiFine 需要 Forge 或 NeoForge 实例作为载体，但没有找到（$mcVer 相关实例均不是）。" +
                    "请先安装 Forge / NeoForge —— 安卓端暂无法自动安装它们（安装器需 Java 运行时）"
            )
        optifineDropAsMod(mcVer, carrier)
        return carrier
    }

    /** optifine:asMod 的入口（对齐桌面端 findForgeLikeInstance + optifineDropAsMod） */
    fun optifineAsMod(mcVer: String, instName: String): JSONObject {
        if (mcVer.isBlank()) return JSONObject().put("ok", false).put("error", "缺少游戏版本号")
        return try {
            val carrier = findForgeLikeInstance(instName.trim())
                ?: throw IOException(
                    "没有找到 Forge/NeoForge 实例作载体。" +
                        "OptiFine 依赖 Forge/NeoForge，安卓端暂无法自动安装它们（安装器需 Java 运行时），请先手动安装"
                )
            val r = optifineDropAsMod(mcVer, carrier)
            r.put("ok", true).put("instance", carrier)
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: "OptiFine 安装失败")
        }
    }

    /** 找 Forge/NeoForge 实例：指定名优先（必须真是 Forge 系），否则取最近修改的 Forge 系实例 */
    private fun findForgeLikeInstance(instName: String): String? {
        val vDir = File(gameDir(), "versions")
        if (instName.isNotEmpty()) {
            val jf = File(vDir, "$instName/$instName.json")
            if (!jf.isFile) throw IOException("目标实例「$instName」不存在，无法放入 OptiFine")
            val j = JSONObject(jf.readText(Charsets.UTF_8))
            return if (isForgeLike(j)) instName else null
        }
        var best: Pair<Long, String>? = null
        for (d in vDir.listFiles { f -> f.isDirectory } ?: emptyArray()) {
            val jf = File(d, "${d.name}.json")
            if (!jf.isFile) continue
            val j = try { JSONObject(jf.readText(Charsets.UTF_8)) } catch (_: Throwable) { continue }
            if (!isForgeLike(j)) continue
            val mt = d.lastModified()
            if (best == null || mt > best!!.first) best = Pair(mt, d.name)
        }
        return best?.second
    }

    private fun isForgeLike(j: JSONObject): Boolean {
        val hay = (j.optJSONArray("libraries")?.toString() ?: "").replace("\\/", "/") +
            " " + j.optString("mainClass")
        return hay.contains("/minecraftforge/") || hay.contains("/neoforged/")
    }

    /** 下载 OptiFine jar 到实例的 mods/（版本隔离 → versions/<实例>/mods，与桌面端同路径规则） */
    private fun optifineDropAsMod(mcVer: String, instName: String): JSONObject {
        val instDir = File(gameDir(), "versions/$instName")
        if (!File(instDir, "$instName.json").isFile) {
            throw IOException("目标实例「$instName」不存在，无法放入 OptiFine")
        }
        val builds = probe.optifineBuildsOf(mcVer)
        if (builds.isEmpty()) throw IOException("OptiFine 尚未提供 $mcVer 的构建")
        val pick = probe.pickOptifineBuild(builds)
        val type = pick.optString("type")
        val patch = pick.optString("patch")
        val fileName = pick.optString("filename").ifEmpty { "OptiFine_${mcVer}_${type}_$patch.jar" }
        val isPreview = fileName.startsWith("preview_", ignoreCase = true)
        /* BMCLAPI 直链：/optifine/<mcver>/<type>/<patch>（不带文件名，带了会 404 —— 实测） */
        val url = "$BMCLAPI/optifine/" +
            java.net.URLEncoder.encode(mcVer, "UTF-8") + "/" +
            java.net.URLEncoder.encode(type, "UTF-8") + "/" +
            java.net.URLEncoder.encode(patch, "UTF-8")
        val outName = (if (isPreview) fileName.replace(Regex("^preview_", RegexOption.IGNORE_CASE), "") else fileName)
            .replace(Regex("[^\\w.\\-]"), "_")
        val modsDir = File(instDir, "mods")
        modsDir.mkdirs()
        val dest = File(modsDir, outName)
        chk("$mcVer|OptiFine")
        progress("installer-dl", 5, "下载 OptiFine" + (if (isPreview) "（预览版）" else ""))
        setStatus("下载 OptiFine…")
        Net.download(url, dest, null, 60000) { pct, _, _ ->
            if (pct >= 0) progress("installer-dl", 5 + pct * 85 / 100, "下载 OptiFine $pct%")
        }
        val size = if (dest.isFile) dest.length() else 0
        progress("done", 100, "OptiFine 已放入 $instName 的 mods")
        Log.i(TAG, "[optifine] 已放入 mods: ${dest.absolutePath}（$size 字节）")
        return JSONObject().put("file", outName).put("size", size).put("modsDir", modsDir.absolutePath)
    }

    /* ==================================================================
     * 更改 / 卸载加载器（对齐桌面端 version:loader-change / loader-uninstall）
     * 流程：旧目录挪走 → 装新加载器到临时目录 → 成功则搬数据改名、失败则回滚。
     * Forge/NeoForge 目标在安卓端明确报错（安装器需 Java 运行时），不假装成功。
     * ================================================================== */

    private val INST_DATA_DIRS = listOf("mods", "saves", "config", "resourcepacks", "shaderpacks")

    fun loaderChange(p: JSONObject?): JSONObject {
        val id = p?.optString("id").orEmpty()
        val loader = p?.optString("loader").orEmpty()
        val build = p?.optString("build").orEmpty().trim()
        if (id.isEmpty() || id.contains(Regex("[/\\\\]"))) return JSONObject().put("ok", false).put("error", "实例名无效")
        val vDir = File(gameDir(), "versions")
        val oldDir = File(vDir, id)
        val bak = File(vDir, "${id}__old")
        val tmp = File(vDir, "${id}__new")
        try {
            val ctx = resolveVersionContext(id)
            if (!ctx.optBoolean("ok")) return JSONObject().put("ok", false).put("error", ctx.optString("error"))
            val mcVer = ctx.optString("rootId")
            val cur = ctx.optString("loader")
            if (loader.isBlank()) throw IOException("请选择目标加载器")
            if (loader == cur && build.isEmpty()) {
                throw IOException("当前已是 $cur；如需换构建请在「加载器版本」里选一个具体版本")
            }
            loaderChangeCompat(mcVer, loader)?.let { throw IOException("$mcVer 无法安装 $loader：$it") }
            val children = instanceChildrenOf(id, vDir)
            if (children.isNotEmpty()) {
                throw IOException("该实例被其他版本继承（${children.joinToString(", ")}），请先处理子版本再更改加载器")
            }
            if (!oldDir.isDirectory) throw IOException("实例目录不存在: $id")
            bak.deleteRecursively(); tmp.deleteRecursively()
            setStatus("安装 $loader → 实例 $id")
            if (!oldDir.renameTo(bak)) throw IOException("无法暂存原实例目录（可能有文件被占用）")
            try {
                when (loader.lowercase()) {
                    "vanilla" -> runVanilla(mcVer, tmp.name, false, "loader-change|$id")
                    "fabric" -> runFabricLike(mcVer, "fabric", tmp.name, false, "loader-change|$id", build)
                    "quilt" -> runFabricLike(mcVer, "quilt", tmp.name, false, "loader-change|$id", build)
                    else -> throw IOException("暂不支持的加载器: $loader（Forge/NeoForge 安装器需 Java 运行时，安卓端尚未接入）")
                }
            } catch (e: Throwable) {
                tmp.deleteRecursively()
                if (!bak.renameTo(oldDir)) Log.w(TAG, "回滚失败: $bak → $oldDir")
                setStatus("就绪")
                return JSONObject().put("ok", false)
                    .put("error", "${e.message ?: e}（已回滚，原实例未受影响）")
            }
            moveInstanceData(bak, tmp)
            bak.deleteRecursively()
            renameInstalledVersion(tmp, id, mcVer)
            val nv = detectLoaderVer(File(vDir, "$id/$id.json"))
            emit("app:toast", JSONObject().put("msg", "加载器已更改为 " + (nv.ifEmpty { loader }) + " · 实例 $id"))
            setStatus("就绪")
            return JSONObject().put("ok", true).put("id", id).put("loader", loader).put("loaderVer", nv)
        } catch (e: Exception) {
            setStatus("就绪")
            return JSONObject().put("ok", false).put("error", e.message ?: "更改加载器失败")
        }
    }

    /** 卸载加载器：重建为同 MC 版本的原版实例（保留 mods/存档/设置），失败不动原实例 */
    fun loaderUninstall(p: JSONObject?): JSONObject {
        val id = p?.optString("id").orEmpty()
        if (id.isEmpty() || id.contains(Regex("[/\\\\]"))) return JSONObject().put("ok", false).put("error", "实例名无效")
        val vDir = File(gameDir(), "versions")
        val oldDir = File(vDir, id)
        val tmp = File(vDir, "${id}__new")
        try {
            val ctx = resolveVersionContext(id)
            if (!ctx.optBoolean("ok")) return JSONObject().put("ok", false).put("error", ctx.optString("error"))
            val mcVer = ctx.optString("rootId")
            val cur = ctx.optString("loader")
            if (cur == "Vanilla") throw IOException("该实例已经是原版（Vanilla），无需卸载")
            tmp.deleteRecursively()
            setStatus("重建原版实例: $id")
            runVanilla(mcVer, tmp.name, false, "loader-uninstall|$id")
            moveInstanceData(oldDir, tmp)
            oldDir.deleteRecursively()
            renameInstalledVersion(tmp, id, mcVer)
            emit("app:toast", JSONObject().put("msg", "已卸载 $cur，实例 $id 重建为原版（MC $mcVer）"))
            setStatus("就绪")
            return JSONObject().put("ok", true).put("id", id)
        } catch (e: Exception) {
            tmp.deleteRecursively()
            setStatus("就绪")
            return JSONObject().put("ok", false).put("error", e.message ?: "卸载加载器失败")
        }
    }

    /** 桌面端 loaderChangeCompat 同款兼容规则 */
    private fun loaderChangeCompat(mcVer: String, loader: String): String? {
        if (loader == "Vanilla") return null
        val m = Regex("^(\\d+)\\.(\\d+)(?:\\.(\\d+))?").find(mcVer) ?: return if (loader == "Forge") "该版本无法安装 Forge" else null
        val maj = m.groupValues[1].toInt()
        val min = m.groupValues[2].toInt()
        val pat = m.groupValues[3].ifEmpty { "0" }.toInt()
        if (loader == "NeoForge" && !(maj > 1 || (maj == 1 && (min > 20 || (min == 20 && pat >= 1))))) {
            return "NeoForge 仅支持 1.20.1 及以上版本"
        }
        if ((loader == "Fabric" || loader == "Quilt") && !(maj > 1 || (maj == 1 && min >= 14))) {
            return "$loader 支持自 1.14 开始"
        }
        return null
    }

    /** 找继承 id 的子版本 */
    private fun instanceChildrenOf(id: String, vDir: File): List<String> {
        val out = ArrayList<String>()
        for (d in vDir.listFiles { f -> f.isDirectory } ?: emptyArray()) {
            val jf = File(d, "${d.name}.json")
            if (!jf.isFile) continue
            val j = try { JSONObject(jf.readText(Charsets.UTF_8)) } catch (_: Throwable) { continue }
            if (j.optString("inheritsFrom") == id) out.add(d.name)
        }
        return out
    }

    /** 把实例本体的数据（mods/saves/config/resourcepacks/shaderpacks/options.txt）搬到目标实例目录 */
    private fun moveInstanceData(srcDir: File, dstDir: File) {
        for (n in INST_DATA_DIRS) {
            val s = File(srcDir, n)
            if (!s.exists()) continue
            val d = File(dstDir, n)
            if (!s.renameTo(d)) {
                s.copyRecursively(d, overwrite = true)
                s.deleteRecursively()
            }
        }
        val osrc = File(srcDir, "options.txt")
        if (osrc.isFile) {
            if (!osrc.renameTo(File(dstDir, "options.txt"))) {
                osrc.copyTo(File(dstDir, "options.txt"), overwrite = true)
                osrc.delete()
            }
        }
    }

    /** 目录/JSON 文件/JSON 内 id 三处一起改名（对齐桌面端 renameInstalledVersion）。
        mcVer 写入 xlcMcVersion：重建的原版实例没有 inheritsFrom，下次换/卸加载器靠它还原 MC 版本 */
    private fun renameInstalledVersion(dir: File, newId: String, mcVer: String = "") {
        val oldId = dir.name
        val jf = File(dir, "$oldId.json")
        if (jf.isFile) {
            val j = try { JSONObject(jf.readText(Charsets.UTF_8)) } catch (_: Throwable) { JSONObject() }
            j.put("id", newId)
            if (mcVer.isNotEmpty()) j.put("xlcMcVersion", mcVer)
            File(dir, "$newId.json").writeText(j.toString(2), Charsets.UTF_8)
            jf.delete()
        }
        val jar = File(dir, "$oldId.jar")
        if (jar.isFile) jar.renameTo(File(dir, "$newId.jar"))
        if (!dir.renameTo(File(dir.parentFile, newId))) Log.w(TAG, "重命名实例目录失败: $dir → $newId")
    }

    /** 从版本 json 的 libraries 里提取加载器版本号（fabric-loader / quilt-loader / forge 坐标） */
    private fun detectLoaderVer(jf: File): String {
        return try {
            val j = JSONObject(jf.readText(Charsets.UTF_8))
            val hay = j.optJSONArray("libraries")?.toString() ?: ""
            Regex("(?:fabric|quilt)-loader:([0-9][\\w.+-]*)").find(hay)?.groupValues?.get(1)
                ?: Regex("(?:neoforged|minecraftforge):(neoforge-)?([0-9][\\w.+-]*)")?.find(hay)?.groupValues?.get(2)
                ?: ""
        } catch (_: Throwable) { "" }
    }

    /* ==================================================================
     * 原版安装主流程
     * ================================================================== */
    private fun runVanilla(id: String, customName: String, reinstall: Boolean, cancelKey: String): String {
        val gd = gameDir()
        val gameId = customName.ifEmpty { id }
        val vd = File(gd, "versions/$gameId")

        // 残留目录（有文件夹没 json）= 上次安装中断，直接清掉避免半截状态被误判
        if (vd.isDirectory && !File(vd, "$gameId.json").isFile) {
            Log.i(TAG, "清理残留目录: ${vd.absolutePath}")
            vd.deleteRecursively()
        }
        if (reinstall && vd.isDirectory) {
            Log.i(TAG, "重装模式，清空: ${vd.absolutePath}")
            vd.deleteRecursively()
        }
        vd.mkdirs()
        chk(cancelKey)

        val meta = findInManifest(id)

        // 1. 版本 JSON —— 内容先留在内存，全部下载成功后才落盘。
        //    否则取消/中断会留下「有 json 没 jar」的目录，被扫描误判为已安装。
        progress("json", 2, "下载版本清单")
        setStatus("获取版本清单: $gameId")
        val vjson = JSONObject(String(httpGet(mapUrl(meta.optString("url"))), Charsets.UTF_8))
        vjson.put("id", gameId)   // 自定义名：json.id 必须与目录名一致

        // 2. 客户端 jar
        chk(cancelKey)
        val client = vjson.optJSONObject("downloads")?.optJSONObject("client")
        if (client != null) {
            progress("client", 5, "下载客户端 client.jar")
            setStatus("下载客户端: $gameId")
            downloadTo(client.optString("url"), File(vd, "$gameId.jar"), client.optString("sha1"))
        }

        // 3. libraries（并发 8）
        chk(cancelKey)
        val libs = collectLibraries(vjson)
        setStatus("下载依赖库 (0/${libs.size})")
        progress("libraries", 8, "依赖库 0/${libs.size}", 0, libs.size)
        val libFails = runPool(libs.size, 8, { d, t ->
            progress("libraries", 8 + d * 22 / maxOf(1, t), "依赖库 $d/$t", d, t)
        }) { i ->
            chk(cancelKey)
            if (!cancels.containsKey(cancelKey)) throw CancelledException()   // 用户已在别处取消
            val it = libs[i]
            downloadTo(it.url, File(gd, "libraries/${it.path}"), it.sha1)
        }
        if (libFails.isNotEmpty()) {
            throw IOException("${libFails.size} 个依赖库下载失败，例如 ${libFails.first()}")
        }

        // 4. assetIndex + assets
        chk(cancelKey)
        val ai = vjson.optJSONObject("assetIndex")
        if (ai != null) {
            progress("assets-index", 32, "下载资源索引")
            val idxFile = File(gd, "assets/indexes/${ai.optString("id")}.json")
            downloadTo(ai.optString("url"), idxFile, ai.optString("sha1"))

            val hashes = readAssetHashes(idxFile)
            setStatus("下载资源文件 (0/${hashes.size})")
            progress("assets", 32, "资源文件 0/${hashes.size}", 0, hashes.size)
            val aFails = runPool(hashes.size, 8, { d, t ->
                // 节流放宽到每 10 个刷一次（25 太粗：卡住时看不出真实完成数）
                if (d % 10 == 0 || d == t) {
                    progress("assets", 32 + d * 62 / maxOf(1, t), "资源文件 $d/$t", d, t)
                }
            }) { i ->
                chk(cancelKey)
                val h = hashes[i]
                val sub = h.substring(0, 2)
                downloadTo(
                    "https://resources.download.minecraft.net/$sub/$h",
                    File(gd, "assets/objects/$sub/$h"),
                    h
                )
            }
            if (aFails.isNotEmpty()) {
                // 与桌面端一致：资源文件失败不视为致命，下次安装会补
                Log.w(TAG, "${aFails.size} 个资源文件下载失败，下次安装将重试")
                emit("app:toast", JSONObject().put("msg", "${aFails.size} 个资源文件下载失败，下次安装将重试").put("type", "warn"))
            }
        }

        // 5. natives（按 linux 规则解压 .so）
        chk(cancelKey)
        progress("natives", 96, "解压本地库 natives")
        val nativesDir = File(vd, "natives")
        nativesDir.deleteRecursively()
        nativesDir.mkdirs()
        for (n in collectNativeLibs(vjson)) {
            chk(cancelKey)
            val jar = File(gd, "libraries/${n.path}")
            if (!jar.isFile) downloadTo(n.url, jar, n.sha1)
            try {
                extractNatives(jar, nativesDir)
            } catch (e: Throwable) {
                Log.w(TAG, "解压 natives 失败 ${n.path}: ${e.message}")
            }
        }

        // 6. 全部就绪后才写版本 JSON
        File(vd, "$gameId.json").writeText(vjson.toString(2), Charsets.UTF_8)
        progress("done", 100, "安装完成")
        Log.i(TAG, "安装完成: $gameId → ${vd.absolutePath}")
        return gameId
    }

    private fun findInManifest(id: String): JSONObject {
        val m = fetchManifest()
        val arr = m.optJSONArray("versions") ?: throw IOException("版本清单结构异常")
        for (i in 0 until arr.length()) {
            val v = arr.optJSONObject(i) ?: continue
            if (v.optString("id") == id) return v
        }
        throw IOException("清单中找不到版本: $id")
    }

    /* ==================================================================
     * 依赖清单收集（对应桌面端 rulePass + filter）
     * ================================================================== */

    private data class LibItem(val url: String, val path: String, val sha1: String)

    private fun collectLibraries(vjson: JSONObject): List<LibItem> {
        val out = mutableListOf<LibItem>()
        val arr = vjson.optJSONArray("libraries") ?: return out
        for (i in 0 until arr.length()) {
            val l = arr.optJSONObject(i) ?: continue
            if (!rulePass(l.optJSONArray("rules"))) continue
            val a = l.optJSONObject("downloads")?.optJSONObject("artifact") ?: continue
            val p = a.optString("path")
            val u = a.optString("url")
            if (p.isEmpty() || u.isEmpty()) continue
            out.add(LibItem(u, p, a.optString("sha1")))
        }
        return out
    }

    private fun collectNativeLibs(vjson: JSONObject): List<LibItem> {
        val out = mutableListOf<LibItem>()
        val arr = vjson.optJSONArray("libraries") ?: return out
        for (i in 0 until arr.length()) {
            val l = arr.optJSONObject(i) ?: continue
            if (!rulePass(l.optJSONArray("rules"))) continue
            val natives = l.optJSONObject("natives") ?: continue
            val raw = natives.optString(OS_NAME)
            if (raw.isEmpty()) continue
            val classifier = raw.replace("\${arch}", if (OS_ARCH == "x86_64") "64" else "32")
            val classifiers = l.optJSONObject("downloads")?.optJSONObject("classifiers") ?: continue
            val c = classifiers.optJSONObject(classifier) ?: continue
            val p = c.optString("path")
            if (p.isEmpty()) continue
            out.add(LibItem(c.optString("url"), p, c.optString("sha1")))
        }
        return out
    }

    /**
     * 规则判定。桌面端把非 windows 的 allow 规则全部排除；
     * 这里换成「非 linux 的排除」，其余逻辑（last-match-wins、无规则即通过）保持一致。
     */
    private fun rulePass(rules: JSONArray?): Boolean {
        if (rules == null || rules.length() == 0) return true
        var allow = false
        for (i in 0 until rules.length()) {
            val r = rules.optJSONObject(i) ?: continue
            // features 条件（demo / 分辨率占位等）：一律视为不适用，不改变 allow
            if (r.has("features")) continue
            val os = r.optJSONObject("os")
            val osOk = os == null || os.optString("name") == OS_NAME
            when (r.optString("action")) {
                "allow" -> if (osOk) allow = true
                "disallow" -> if (osOk) allow = false
            }
        }
        return allow
    }

    private fun readAssetHashes(idxFile: File): List<String> {
        val idx = JSONObject(idxFile.readText(Charsets.UTF_8))
        val objects = idx.optJSONObject("objects") ?: return emptyList()
        val out = LinkedHashSet<String>()
        val keys = objects.keys()
        while (keys.hasNext()) {
            val o = objects.optJSONObject(keys.next()) ?: continue
            val h = o.optString("hash")
            if (h.length >= 2) out.add(h)
        }
        return out.toList()
    }

    /* ==================================================================
     * 下载原语
     * ================================================================== */

    /** 已存在且 SHA1 相符则跳过；无校验值时不覆盖已有文件（与桌面端同语义） */
    @Throws(IOException::class)
    private fun downloadTo(url: String, dest: File, expectSha1: String?) {
        if (dest.isFile) {
            if (expectSha1.isNullOrEmpty()) return
            if (sha1File(dest).equals(expectSha1, ignoreCase = true)) return
        }
        val bytes = httpGet(mapUrl(url))
        if (!expectSha1.isNullOrEmpty() && !sha1Bytes(bytes).equals(expectSha1, ignoreCase = true)) {
            throw IOException("SHA1 校验失败: $url")
        }
        dest.parentFile?.mkdirs()
        dest.writeBytes(bytes)
    }

    @Throws(IOException::class)
    private fun httpGet(url: String): ByteArray {
        var target = url
        var hops = 0
        while (true) {
            val conn = openConn(target)
            /* 看门狗：readTimeout 只管「N 秒无字节」，服务器慢速滴流（每 59s 吐 1 字节）
               就能永远续命 —— 实测 1.20.1 资源安装卡在最后 1 个文件 25 分钟。
               所以给整个请求加硬性总预算：90s 没拿到完整响应就强制 disconnect，
               阻塞中的 read 立即抛错 → 计入失败列表，不挂死整个安装。 */
            val deadline = System.currentTimeMillis() + HARD_REQUEST_BUDGET_MS
            val watchdog = Thread {
                while (System.currentTimeMillis() < deadline) {
                    try { Thread.sleep(2000) } catch (_: InterruptedException) { return@Thread }
                }
                try { conn.disconnect() } catch (_: Throwable) {}
            }
            watchdog.isDaemon = true
            watchdog.start()
            try {
                val code = conn.responseCode
                if (code in 300..399) {
                    val loc = conn.getHeaderField("Location")
                    if (loc.isNullOrEmpty()) throw IOException("HTTP $code 未提供 Location")
                    if (++hops > 8) throw IOException("重定向次数过多: $url")
                    target = URL(URL(target), loc).toString()
                    continue
                }
                if (code != 200) throw IOException("HTTP $code ($url)")
                return conn.inputStream.use { it.readBytes() }
            } catch (e: IOException) {
                throw IOException("${e.message ?: "网络错误"}（${hostOf(url)}，单请求限时 ${HARD_REQUEST_BUDGET_MS / 1000}s）")
            } finally {
                watchdog.interrupt()
                try { conn.disconnect() } catch (_: Throwable) {}
            }
        }
    }

    private fun hostOf(url: String): String = try { URL(url).host } catch (_: Exception) { url.take(40) }

    @Throws(IOException::class)
    private fun httpHead(url: String): Int {
        var target = url
        var hops = 0
        while (true) {
            val conn = openConn(target, head = true)
            try {
                val code = conn.responseCode
                if (code in 300..399) {
                    val loc = conn.getHeaderField("Location")
                    if (loc.isNullOrEmpty()) return code
                    if (++hops > 8) return code
                    target = URL(URL(target), loc).toString()
                    continue
                }
                return code
            } finally {
                conn.disconnect()
            }
        }
    }

    private fun openConn(url: String, head: Boolean = false): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = if (head) "HEAD" else "GET"
            connectTimeout = 20000
            readTimeout = 60000
            instanceFollowRedirects = false
            setRequestProperty("User-Agent", UA)
            setRequestProperty("Accept", "*/*")
        }

    /**
     * 并发池：固定数量线程抢一个原子索引，任一 worker 抛 CancelledException
     * 即退出该线程（其余线程也会在下一项开工前看到取消标志）。
     */
    private fun runPool(
        total: Int,
        limit: Int,
        onProgress: (Int, Int) -> Unit,
        worker: (Int) -> Unit
    ): List<String> {
        if (total <= 0) return emptyList()
        val failed = Collections.synchronizedList(mutableListOf<String>())
        val idx = AtomicInteger(0)
        val done = AtomicInteger(0)
        val threads = minOf(limit, total)
        val latch = CountDownLatch(threads)

        repeat(threads) {
            Thread {
                while (true) {
                    val i = idx.getAndIncrement()
                    if (i >= total) break
                    try {
                        worker(i)
                    } catch (e: CancelledException) {
                        break
                    } catch (t: Throwable) {
                        failed.add(t.message ?: "未知错误")
                    }
                    onProgress(done.incrementAndGet(), total)
                }
                latch.countDown()
            }.apply { isDaemon = true }.start()
        }
        latch.await()
        return failed.toList()
    }

    private fun extractNatives(jar: File, destDir: File) {
        ZipInputStream(jar.inputStream().buffered()).use { zin ->
            var e = zin.nextEntry
            while (e != null) {
                val name = e.name
                if (!e.isDirectory && !name.startsWith("META-INF") && name.endsWith(".so")) {
                    val out = File(destDir, File(name).name)
                    out.outputStream().use { zin.copyTo(it) }
                }
                zin.closeEntry()
                e = zin.nextEntry
            }
        }
    }

    /* ==================================================================
     * 工具
     * ================================================================== */

    private fun chk(key: String) {
        if (cancels[key]?.get() == true) throw CancelledException()
    }

    private fun progress(stage: String, percent: Int, text: String, current: Int? = null, total: Int? = null) {
        val o = JSONObject().put("stage", stage).put("percent", percent).put("text", text)
        if (current != null) o.put("current", current)
        if (total != null) o.put("total", total)
        emit("install:progress", o)
    }

    private fun mapUrl(u: String): String {
        if (sourceName() != "bmclapi") return u
        return u
            .replace("https://piston-meta.mojang.com", BMCLAPI)
            .replace("https://launchermeta.mojang.com", BMCLAPI)
            .replace("https://piston-data.mojang.com", BMCLAPI)
            .replace("https://launcher.mojang.com", BMCLAPI)
            .replace("https://resources.download.minecraft.net", "$BMCLAPI/assets")
    }

    private fun sha1Bytes(b: ByteArray): String =
        MessageDigest.getInstance("SHA-1").digest(b).joinToString("") { "%02x".format(it) }

    private fun sha1File(f: File): String =
        f.inputStream().use { ins ->
            val md = MessageDigest.getInstance("SHA-1")
            val buf = ByteArray(16384)
            while (true) {
                val n = ins.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
            md.digest().joinToString("") { "%02x".format(it) }
        }

    /** 自定义实例名：与桌面端 sanitizeVersionId 同规则（只留字母数字._-，防止目录穿越） */
    private fun sanitizeVersionId(name: String): String = sanitizeId(name)

    /** 供整合包命名等外部调用（同 sanitizeVersionId 规则） */
    fun sanitizeId(name: String): String =
        name.trim().replace(Regex("[^A-Za-z0-9._-]+"), "_").replace(Regex("^[._-]+"), "").take(60)

    class CancelledException : Exception("已取消")

    companion object {
        private const val TAG = "XLC-Install"
        private const val BMCLAPI = "https://bmclapi2.bangbang93.com"

        /** 单个 HTTP 请求的硬性总预算：防慢速滴流连接把安装挂死（见 httpGet 看门狗） */
        private const val HARD_REQUEST_BUDGET_MS = 90_000L
        private const val MANIFEST_OFFICIAL = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
        private const val MANIFEST_BMCLAPI = "$BMCLAPI/mc/game/version_manifest_v2.json"

        /** 安卓端可真实安装的加载器（Forge/NeoForge 需要 Java 运行时跑安装器，见 startInstall 注释；
            OptiFine 走「下载 jar 丢进 Forge 实例 mods」的纯下载路径） */
        private val SUPPORTED_LOADERS = listOf("vanilla", "fabric", "quilt", "optifine")

        /** 安卓内核是 Linux，按 linux 规则筛依赖与 natives */
        private const val OS_NAME = "linux"
        private val OS_ARCH: String =
            if (Build.SUPPORTED_ABIS.any { it.startsWith("arm") }) "arm64" else "x86_64"
        private val UA: String = "XLC-Launcher/${BuildConfig.VERSION_NAME} (Android)"
    }
}
