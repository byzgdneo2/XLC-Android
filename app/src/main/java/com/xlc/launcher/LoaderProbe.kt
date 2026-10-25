package com.xlc.launcher

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/**
 * 加载器探针与版本列表（与桌面端 main.js 的 probeLoaderBuilds / loaderBuildsOf 逐字段对齐）。
 *
 * 数据源与桌面端同一套，不引入新源：
 *   Fabric   官方 meta + BMCLAPI 镜像（桌面端是并行竞速，这里顺序回退，慢一点但语义一致）
 *   Quilt    官方 meta（无镜像，国内 22~25s → 给足超时，超时≠不兼容）
 *   Forge    BMCLAPI 按 MC 版本查构建（官方 promotions 只有推荐/最新两档，不全）
 *   NeoForge 官方 maven API + BMCLAPI maven-metadata.xml
 *   OptiFine BMCLAPI versionList
 *
 * 语义红线（照抄桌面端注释的教训）：
 *   - HTTP 400/404 = 「确实没有构建」→ ok:false + why
 *   - 超时/网络错误 = 「查不到」→ ok:false + unknown:true + slow:true
 *     两者不能混，否则界面会把网络问题说成「✗ 不兼容」。
 */
class LoaderProbe {

    companion object {
        private const val BMCLAPI = "https://bmclapi2.bangbang93.com"
        val KEYS = listOf("Forge", "Fabric", "Quilt", "NeoForge", "OptiFine")
        private val HTTP_MISSING = Regex("HTTP\\s*(400|404)")
    }

    /* ============================ 探针 ============================ */

    /**
     * 回答「这个加载器在这个 MC 版本上能不能用」。
     * 返回 { ok, builds?, loaderVer?, preview?, unknown?, slow?, why? }。
     */
    fun probe(kind: String, gameVer: String, force: Boolean): JSONObject {
        val k = kind.trim()
        val v = gameVer.trim()
        if (k !in KEYS) return obj("ok" to false, "why" to "不支持的加载器: $kind")
        if (v.isEmpty()) return obj("ok" to false, "why" to "缺少游戏版本号")
        try {
            when (k) {
                "Fabric", "Quilt" -> {
                    /* Fabric：官方源 + BMCLAPI 镜像（桌面端竞速，这里顺序回退）。
                       Quilt：无镜像，官方源极慢 → 25s 超时，超时判「查不到」而不是「无构建」。 */
                    val list = try {
                        if (k == "Fabric") fabricList(v, 8000)
                        else quiltList(v, 25000)
                    } catch (e: Exception) {
                        if (HTTP_MISSING.containsMatchIn(e.message ?: "")) return obj("ok" to false, "why" to "$k 尚未提供 $v 的构建")
                        throw e
                    }
                    if (list.length() == 0) return obj("ok" to false, "why" to "$k 尚未提供 $v 的构建")
                    return obj("ok" to true, "builds" to list.length(),
                        "loaderVer" to list.optJSONObject(0)?.optJSONObject("loader")?.optString("version").orEmpty())
                }
                "Forge" -> {
                    val arr = try {
                        JSONArray(String(Net.get("$BMCLAPI/forge/minecraft/${enc(v)}", 15000), Charsets.UTF_8))
                    } catch (e: Exception) {
                        if (HTTP_MISSING.containsMatchIn(e.message ?: "")) return obj("ok" to false, "why" to "Forge 尚未提供 $v 的构建")
                        return obj("ok" to false, "unknown" to true, "slow" to true,
                            "why" to "Forge 构建列表获取超时（BMCLAPI 未在超时内响应），请重新检测")
                    }
                    if (arr.length() == 0) return obj("ok" to false, "why" to "Forge 尚未提供 $v 的构建")
                    var ver = ""
                    for (i in 0 until arr.length()) {
                        val s = arr.optJSONObject(i)?.optString("version").orEmpty()
                        if (s.isNotEmpty()) { ver = s; break }
                    }
                    return obj("ok" to true, "builds" to arr.length(), "loaderVer" to ver)
                }
                "NeoForge" -> {
                    val artifact = if (v.startsWith("1.20.1")) "forge" else "neoforge"
                    val all = try {
                        neoforgeVersionList(artifact)
                    } catch (e: Exception) {
                        return obj("ok" to false, "unknown" to true, "slow" to true,
                            "why" to "NeoForge 版本列表获取超时（官方源与 BMCLAPI 镜像均未在超时内响应）")
                    }
                    return neoforgeBuildsOf(all, v, artifact)
                }
                "OptiFine" -> {
                    val arr = try {
                        JSONArray(String(Net.get("$BMCLAPI/optifine/versionList", 15000), Charsets.UTF_8))
                    } catch (e: Exception) {
                        if (HTTP_MISSING.containsMatchIn(e.message ?: "")) return obj("ok" to false, "why" to "OptiFine 尚未提供 $v 的构建")
                        return obj("ok" to false, "unknown" to true, "slow" to true,
                            "why" to "OptiFine 构建列表获取超时（BMCLAPI 未在超时内响应），请重新检测")
                    }
                    val hit = (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
                        .filter { it.optString("mcversion") == v }
                    if (hit.isEmpty()) return obj("ok" to false, "why" to "OptiFine 尚未提供 $v 的构建")
                    /* 优先正式版（非 preview），没有就退回预览版 */
                    val stable = hit.filter { !isPreviewName(it.optString("filename")) }
                    val pick = if (stable.isNotEmpty()) stable[0] else hit[0]
                    return obj("ok" to true, "builds" to hit.size,
                        "preview" to (stable.isEmpty()),
                        "loaderVer" to (pick.optString("type") + (if (pick.optString("patch").isNotEmpty()) "_" + pick.optString("patch") else "")))
                }
            }
            return obj("ok" to false, "why" to "不支持的加载器: $kind")
        } catch (e: Exception) {
            return obj("ok" to false, "unknown" to true, "slow" to true,
                "why" to "构建信息获取失败：${e.message ?: e}")
        }
    }

    /* ============================ 版本列表 ============================ */

    /**
     * 回答「能用的话，具体能装哪些版本」。
     * 返回 { ok, kind, mcVer, latest, recommended, list:[{ v, tag }] }，list 新 → 旧。
     * 与安装器的匹配规则完全一致（能选到就一定装得上）。
     */
    fun buildsOf(kind: String, mcVer: String): JSONObject {
        val k = kind.trim()
        val v = mcVer.trim()
        if (k !in KEYS) return obj("ok" to false, "why" to "不支持的加载器: $kind")
        if (v.isEmpty()) return obj("ok" to false, "why" to "缺少游戏版本号")
        return try {
            when (k) {
                "Fabric", "Quilt" -> {
                    val entries = try {
                        val raw = if (k == "Fabric") fabricList(v, 8000) else quiltList(v, 25000)
                        (0 until raw.length()).mapNotNull { raw.optJSONObject(it) }
                            .filter { it.optJSONObject("loader")?.optString("version").orEmpty().isNotEmpty() }
                    } catch (e: Exception) {
                        if (HTTP_MISSING.containsMatchIn(e.message ?: "")) return obj("ok" to false, "why" to "$k 尚未提供 $v 的构建")
                        return obj("ok" to false, "unknown" to true, "slow" to true, "why" to "$k 加载器版本列表获取失败：${e.message ?: e}")
                    }
                    if (entries.isEmpty()) return obj("ok" to false, "why" to "$k 尚未提供 $v 的构建")
                    var items = entries.map { x ->
                        val l = x.optJSONObject("loader")!!
                        Pair(l.optString("version"), l.optBoolean("stable"))
                    }
                    /* Quilt 的接口顺序不可靠（beta 混在正式版前面），必须自己按 semver 降序排；
                       Fabric 上游顺序可靠（新→旧），原样保留 */
                    if (k == "Quilt") {
                        items = items.sortedWith { x, y ->
                            val kx = cmpKey(x.first); val ky = cmpKey(y.first)
                            for (i in 0 until minOf(kx.size, ky.size)) {
                                if (kx[i] != ky[i]) return@sortedWith ky[i] - kx[i]
                            }
                            y.first.compareTo(x.first)
                        }
                    }
                    val rec = items.firstOrNull { it.second }?.first
                        ?: items.firstOrNull { !it.first.contains("-") }?.first.orEmpty()
                    val list = JSONArray()
                    items.forEachIndexed { i, x ->
                        list.put(JSONObject().put("v", x.first).put("tag", if (i == 0) "最新" else ""))
                    }
                    obj("ok" to true, "kind" to k, "mcVer" to v, "latest" to items[0].first,
                        "recommended" to rec, "list" to list)
                }
                "Forge" -> {
                    val raw = try {
                        JSONArray(String(Net.get("$BMCLAPI/forge/minecraft/${enc(v)}", 15000), Charsets.UTF_8))
                    } catch (e: Exception) {
                        if (HTTP_MISSING.containsMatchIn(e.message ?: "")) return obj("ok" to false, "why" to "Forge 尚未提供 $v 的构建")
                        return obj("ok" to false, "unknown" to true, "slow" to true, "why" to "Forge 构建列表获取超时（BMCLAPI 未在超时内响应），请重试")
                    }
                    val arr = (0 until raw.length()).mapNotNull { raw.optJSONObject(it) }
                        .filter { it.optString("version").isNotEmpty() }
                    if (arr.isEmpty()) return obj("ok" to false, "why" to "Forge 尚未提供 $v 的构建")
                    /* bmclapi 是「旧 → 新」，按 build 号倒序成「新 → 旧」 */
                    val sorted = arr.sortedByDescending { it.optInt("build") }
                    /* promotions_slim.json 权威标出「推荐 / 最新」两档；拿不到不影响主流程 */
                    var recommended = ""
                    var newest = ""
                    try {
                        val pr = JSONObject(String(Net.get("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json", 8000), Charsets.UTF_8))
                        val promos = pr.optJSONObject("promos") ?: JSONObject()
                        fun hitOf(suffix: String): String {
                            val b = promos.optString("$v-$suffix")
                            if (b.isEmpty()) return ""
                            val x = sorted.firstOrNull { it.optString("version").endsWith(b) } ?: return ""
                            return x.optString("version")
                        }
                        recommended = hitOf("recommended")
                        newest = hitOf("latest")
                    } catch (_: Exception) {}
                    val list = JSONArray()
                    sorted.forEachIndexed { i, x ->
                        val s = x.optString("version")
                        var tag = ""
                        if (newest.isNotEmpty() && s == newest) tag = "最新"
                        else if (i == 0) tag = "最新"
                        list.put(JSONObject().put("v", s).put("tag", tag))
                    }
                    obj("ok" to true, "kind" to k, "mcVer" to v, "latest" to sorted[0].optString("version"),
                        "recommended" to recommended, "list" to list)
                }
                "NeoForge" -> {
                    val artifact = if (v.startsWith("1.20.1")) "forge" else "neoforge"
                    val all = try { neoforgeVersionList(artifact) } catch (e: Exception) {
                        return obj("ok" to false, "unknown" to true, "slow" to true,
                            "why" to "NeoForge 版本列表获取超时（官方源与 BMCLAPI 镜像均未在超时内响应）")
                    }
                    val prefix = neoforgeBuildPrefix(v, artifact)
                    if (prefix.isEmpty()) return obj("ok" to false, "why" to "NeoForge 不支持 $v（无法解析版本号）")
                    val hit = all.filter { it.startsWith(prefix) }
                    if (hit.isEmpty()) return obj("ok" to false, "why" to "NeoForge 尚未提供 $v 的构建")
                    /* maven 版本表是「旧 → 新」，倒序；角标只打一枚（最新 = 第一项） */
                    val rev = hit.reversed()
                    val rec = rev.firstOrNull { !it.contains("-") } ?: ""
                    val list = JSONArray()
                    rev.forEachIndexed { i, s ->
                        list.put(JSONObject().put("v", s).put("tag", if (i == 0) "最新" else ""))
                    }
                    obj("ok" to true, "kind" to k, "mcVer" to v, "latest" to rev[0],
                        "recommended" to rec, "list" to list)
                }
                else -> obj("ok" to false, "why" to "该加载器暂不支持选择版本: $k")
            }
        } catch (e: Exception) {
            obj("ok" to false, "error" to "${e.message ?: e}")
        }
    }

    /* ============================ OptiFine 构建选择（供安装器复用） ============================ */

    /** BMCLAPI 的 OptiFine 清单中某个 MC 版本的全部构建 */
    fun optifineBuildsOf(mcVer: String): List<JSONObject> {
        val arr = JSONArray(String(Net.get("$BMCLAPI/optifine/versionList", 15000), Charsets.UTF_8))
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
            .filter { it.optString("mcversion") == mcVer }
    }

    /** 正式版优先；全是预览版时退回第一个（与探针同一策略） */
    fun pickOptifineBuild(builds: List<JSONObject>): JSONObject {
        val stable = builds.filter { !isPreviewName(it.optString("filename")) }
        return if (stable.isNotEmpty()) stable[0] else builds[0]
    }

    private fun isPreviewName(fn: String): Boolean = fn.startsWith("preview_", ignoreCase = true)

    /* ============================ 内部工具 ============================ */

    private fun fabricList(v: String, ms: Int): JSONArray =
        JSONArray(String(Net.fromSources(listOf(
            "https://meta.fabricmc.net/v2/versions/loader/${enc(v)}" to ms,
            "$BMCLAPI/fabric-meta/v2/versions/loader/${enc(v)}" to ms
        )), Charsets.UTF_8))

    private fun quiltList(v: String, ms: Int): JSONArray =
        JSONArray(String(Net.get("https://meta.quiltmc.org/v3/versions/loader/${enc(v)}", ms), Charsets.UTF_8))

    /** NeoForge 版本总表：官方 maven API 12s → BMCLAPI maven-metadata.xml 20s */
    private fun neoforgeVersionList(artifact: String): List<String> {
        var lastErr: Exception? = null
        try {
            val data = Net.getJson("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/$artifact", 12000)
            val vs = data.optJSONArray("versions") ?: throw IOException("官方源返回空版本列表")
            val out = (0 until vs.length()).map { vs.optString(it) }
            if (out.isNotEmpty()) return out
            throw IOException("官方源返回空版本列表")
        } catch (e: Exception) { lastErr = e }
        try {
            val xml = String(Net.get("$BMCLAPI/maven/net/neoforged/$artifact/maven-metadata.xml", 20000), Charsets.UTF_8)
            val re = Regex("<version>([^<]+)</version>")
            val all = re.findAll(xml).map { it.groupValues[1] }.toList()
            if (all.isNotEmpty()) return all
            throw IOException("镜像返回空版本列表")
        } catch (e: Exception) { lastErr = e }
        throw IOException("NeoForge 版本列表获取失败（官方源与 BMCLAPI 镜像均不可达）: ${lastErr?.message}")
    }

    /**
     * NeoForge 版本号前缀（照抄桌面端 neoforgeBuildPrefix，两套规则不能混）：
     *   老坐标（MC 1.20.1，artifact='forge'）：条目形如 1.20.1-47.1.106 → 前缀 "1.20.1-"
     *   新坐标（artifact='neoforge'）：1.x.y 丢首段（21.4.） / 26.x 取前两段（26.2.）
     */
    private fun neoforgeBuildPrefix(mcVer: String, artifact: String): String {
        val s = mcVer.trim()
        if (artifact == "forge") return "$s-"
        Regex("^(\\d+)\\.(\\d+)\\.(\\d+)").find(s)?.let { m ->
            return if (m.groupValues[1] == "1") "${m.groupValues[2]}.${m.groupValues[3]}." else "${m.groupValues[1]}.${m.groupValues[2]}."
        }
        Regex("^(\\d+)\\.(\\d+)").find(s)?.let { m ->
            return if (m.groupValues[1] == "1") "${m.groupValues[2]}.0." else "${m.groupValues[1]}.${m.groupValues[2]}."
        }
        return ""
    }

    /** neoforgeBuildsOf：命中 0 = 真没有；正式版优先取最后一个，全是预发布退回最后一个 */
    private fun neoforgeBuildsOf(list: List<String>, mcVer: String, artifact: String): JSONObject {
        val prefix = neoforgeBuildPrefix(mcVer, artifact)
        if (prefix.isEmpty()) return obj("ok" to false, "why" to "NeoForge 不支持 $mcVer（无法解析版本号）")
        val hit = list.filter { it.startsWith(prefix) }
        if (hit.isEmpty()) return obj("ok" to false, "why" to "NeoForge 尚未提供 $mcVer 的构建")
        val stable = hit.filter { !it.contains("-") }
        return obj("ok" to true, "builds" to hit.size,
            "loaderVer" to (if (stable.isNotEmpty()) stable.last() else hit.last()))
    }

    /**
     * Quilt 专用版本比较（照抄桌面端 cmpVerDesc）：正式版在前、数字段大的在前、预发布后缀大的在前。
     * 不能用在 Forge 上（它的 "-" 是 MC 前缀分隔符）。
     */
    private fun cmpKey(s: String): List<Int> {
        val seg = s.split("-")
        val nums = Regex("\\d+").findAll(seg[0]).map { it.value.toInt() }.toList()
        val preNums = if (seg.size > 1) Regex("\\d+").findAll(seg.drop(1).joinToString("-")).map { it.value.toInt() }.toList() else emptyList()
        /* 首位 1=正式版 / 0=预发布：compareByDescending 下正式版排前面（对齐桌面 cmpVerDesc） */
        return listOf(if (seg.size > 1) 0 else 1) + nums.padTo(8) + preNums.padTo(8)
    }

    private fun List<Int>.padTo(n: Int): List<Int> = if (size >= n) this else this + List(n - size) { 0 }

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")

    private fun obj(vararg pairs: Pair<String, Any?>): JSONObject {
        val o = JSONObject()
        for ((k, v) in pairs) o.put(k, v ?: JSONObject.NULL)
        return o
    }
}
