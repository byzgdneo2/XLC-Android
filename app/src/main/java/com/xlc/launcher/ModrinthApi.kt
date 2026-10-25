package com.xlc.launcher

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

/**
 * Modrinth / CurseForge 接口层。
 *
 * 对应桌面端 main.js 里的 modrinthSearchInner / curseforgeSearchInner / combinedSearchInner
 * / modrinth:detail / mrJson / mrDownload。
 *
 * 三个下载源（与桌面端一致）：
 *   - modrinth   ：官方 api.modrinth.com/v2，慢/超时自动切 MCIM 镜像 mod.mcimirror.top/modrinth/v2
 *   - curseforge ：走 MCIM 免 key 代理 mod.mcimirror.top/curseforge/v1
 *   - all        ：两源各预取 100 条，按下载量全局排序后切片翻页（排序跨页永远正确）
 *
 * 中文名走内置库（assets/data/mod-zh-db.json，10414 条）—— 离线可用，
 * 比桌面端依赖远端 AI 翻译更快，且不消耗流量。
 */
class ModrinthApi(
    private val ctx: Context,
    private val iconCacheDir: () -> File
) {

    /* ==================================================================
     * 中文名 / 关键词库（离线）
     * ================================================================== */

    private class ZhDb(val entries: Map<String, String>, val keywords: Map<String, List<String>>)

    @Volatile private var zhdb: ZhDb? = null

    private fun zhDb(): ZhDb {
        zhdb?.let { return it }
        synchronized(this) {
            zhdb?.let { return it }
            val db = try {
                val txt = ctx.assets.open("data/mod-zh-db.json").use { String(it.readBytes(), Charsets.UTF_8) }
                val j = JSONObject(txt)
                val entries = HashMap<String, String>()
                j.optJSONObject("entries")?.let { e ->
                    val keys = e.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        val v = e.optString(k)
                        if (v.isNotEmpty()) entries[k] = v
                    }
                }
                val kws = HashMap<String, List<String>>()
                j.optJSONObject("keywords")?.let { e ->
                    val keys = e.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        val arr = e.optJSONArray(k) ?: continue
                        kws[k] = (0 until arr.length()).map { arr.optString(it) }.filter { it.isNotEmpty() }
                    }
                }
                ZhDb(entries, kws)
            } catch (e: Throwable) {
                Log.w(TAG, "中文库加载失败（将只用原文名）: ${e.message}")
                ZhDb(emptyMap(), emptyMap())
            }
            zhdb = db
            return db
        }
    }

    /** 按 modid / 项目 id 查内置中文名 */
    fun zhNameFor(vararg keys: String): String {
        val db = zhDb()
        for (k in keys) {
            if (k.isEmpty()) continue
            db.entries[k]?.let { if (it.isNotEmpty()) return it }
        }
        return ""
    }

    /**
     * 中文检索词 → 英文关键词（PCL 式）。
     * 多词必须分头查询再合并 —— 拼成一个 OR 串在 Modrinth 的 relevance 排序下会返回 0 条。
     */
    private fun toSearchKeywords(q: String): List<String>? {
        if (q.isEmpty() || !Regex("[\\u4e00-\\u9fff]").containsMatchIn(q)) return null
        val db = zhDb()
        db.keywords[q]?.let { return it.take(3) }
        for ((k, v) in db.keywords) if (k.length >= 2 && q.contains(k)) return v.take(3)
        return null
    }

    /* ==================================================================
     * 搜索
     * ================================================================== */

    fun search(query: String, type: String, mcVersion: String, loader: String, page: Int, source: String): JSONObject {
        val t = if (type in MR_TYPES) type else "mod"
        return when (source) {
            "curseforge" -> cfSearch(query, t, mcVersion, loader, page)
            "all" -> combinedSearch(query, t, mcVersion, loader, page)
            else -> mrSearch(query, t, mcVersion, loader, page)
        }
    }

    private fun facetsFor(type: String, mcVersion: String, loader: String): JSONArray {
        val facets = JSONArray()
        facets.put(JSONArray().put("project_type:$type"))
        if (mcVersion.isNotEmpty()) facets.put(JSONArray().put("versions:$mcVersion"))
        if (loader.isNotEmpty()) facets.put(JSONArray().put("categories:$loader"))
        return facets
    }

    private fun mrSearch(query: String, type: String, mcVersion: String, loader: String, page: Int): JSONObject {
        val p = maxOf(1, page)
        val kws = toSearchKeywords(query)
        val raw: List<JSONObject>
        var total: Int
        var zhQuery = ""

        if (kws != null) {
            raw = mrSearchByKeywords(kws, type, mcVersion, loader, PAGE_SIZE)
            total = raw.size + (p - 1) * PAGE_SIZE
            zhQuery = kws.joinToString(" / ")
        } else {
            val url = "/search?limit=$PAGE_SIZE&offset=${(p - 1) * PAGE_SIZE}&index=downloads&query=" +
                Net.enc(query) + "&facets=" + Net.enc(facetsFor(type, mcVersion, loader).toString())
            val j = mrJson(url)
            val hits = j.optJSONArray("hits") ?: JSONArray()
            raw = (0 until hits.length()).mapNotNull { hits.optJSONObject(it) }
            total = j.optInt("total_hits", raw.size)
        }

        val hits = raw.map { h ->
            JSONObject()
                .put("id", h.optString("project_id"))
                .put("slug", h.optString("slug"))
                .put("title", h.optString("title"))
                .put("desc", h.optString("description"))
                .put("downloads", h.optLong("downloads"))
                .put("icon", h.optString("icon_url"))
                .put("author", h.optString("author"))
                .put("src", "modrinth")
        }
        decorateHits(hits)
        return JSONObject().put("ok", true).put("hits", JSONArray(hits)).put("total", total).put("zhQuery", zhQuery)
    }

    private fun mrSearchByKeywords(kws: List<String>, type: String, mcVersion: String, loader: String, limit: Int): List<JSONObject> {
        val seen = HashSet<String>()
        val out = ArrayList<JSONObject>()
        val groups = kws.map { kw ->
            try {
                mrJson(
                    "/search?limit=$limit&offset=0&index=relevance&query=" + Net.enc(kw) +
                        "&facets=" + Net.enc(facetsFor(type, mcVersion, loader).toString())
                ).optJSONArray("hits")
            } catch (e: Exception) { null }
        }
        for (g in groups) {
            if (g == null) continue
            for (i in 0 until g.length()) {
                val h = g.optJSONObject(i) ?: continue
                val id = h.optString("project_id")
                if (id.isEmpty() || !seen.add(id)) continue
                out.add(h)
            }
        }
        return out
    }

    /* ==================================================================
     * CurseForge（MCIM 免 key 代理）
     * ================================================================== */

    private fun cfQueryString(type: String, mcVersion: String, loader: String, query: String, offset: Int, size: Int): String {
        val sb = StringBuilder()
        sb.append("gameId=432")
        sb.append("&classId=").append(CF_CLASS[type] ?: 6)
        sb.append("&searchFilter=").append(Net.enc(query))
        sb.append("&sortField=6&sortOrder=desc")
        sb.append("&index=").append(offset)
        sb.append("&pageSize=").append(size)
        if (mcVersion.isNotEmpty()) sb.append("&gameVersion=").append(Net.enc(mcVersion))
        val lt = CF_LOADER[loader.lowercase()]
        if (lt != null && type == "mod") sb.append("&modLoaderType=").append(lt)
        return sb.toString()
    }

    private fun cfHitsFrom(arr: JSONArray): List<JSONObject> = (0 until arr.length()).mapNotNull { i ->
        val m = arr.optJSONObject(i) ?: return@mapNotNull null
        val logo = m.optJSONObject("logo")
        val authors = m.optJSONArray("authors")
        val primary = if (authors != null && authors.length() > 0) {
            var pick = authors.optJSONObject(0)
            for (k in 0 until authors.length()) {
                val a = authors.optJSONObject(k) ?: continue
                if (a.optBoolean("isPrimary")) { pick = a; break }
            }
            pick
        } else null
        JSONObject()
            .put("id", "cf" + m.optInt("id"))
            .put("slug", m.optString("slug"))
            .put("title", m.optString("name"))
            .put("desc", m.optString("summary").replace(Regex("\\s+"), " ").take(200))
            .put("downloads", m.optLong("downloadCount"))
            .put("icon", logo?.optString("thumbnailUrl").orEmpty().ifEmpty { logo?.optString("url").orEmpty() })
            .put("author", primary?.optString("name").orEmpty())
            .put("src", "curseforge")
    }

    private fun cfSearch(query: String, type: String, mcVersion: String, loader: String, page: Int): JSONObject {
        val p = maxOf(1, page)
        val kws = toSearchKeywords(query)
        // CF 的 searchFilter 是整串匹配（不做 OR），多词拼接会 0 结果 → 只取最长的一个关键词
        val cfQuery = if (kws != null) kws.maxByOrNull { it.length } ?: query else query
        val qs = cfQueryString(type, mcVersion, loader, cfQuery, (p - 1) * PAGE_SIZE, PAGE_SIZE)
        val j = cfJson("/mods/search?$qs")
        val hits = cfHitsFrom(j.optJSONArray("data") ?: JSONArray())
        decorateHits(hits)
        val pg = j.optJSONObject("pagination")
        val total = pg?.optInt("totalCount") ?: j.optInt("totalCount", hits.size)
        return JSONObject().put("ok", true).put("hits", JSONArray(hits)).put("total", total)
            .put("zhQuery", if (kws != null) cfQuery else "")
    }

    /* ==================================================================
     * 「综合」源：两源合并按下载量全局排序
     * ================================================================== */

    private class Pool(val items: List<JSONObject>, val at: Long)
    private val combinedCache = ConcurrentHashMap<String, Pool>()

    private fun combinedSearch(query: String, type: String, mcVersion: String, loader: String, page: Int): JSONObject {
        val key = "${query.trim().lowercase()}|$type|$mcVersion|$loader"
        var pool = combinedCache[key]
        if (pool == null || System.currentTimeMillis() - pool.at > COMBINED_TTL || combinedCache.size > 24) {
            val mrRef = arrayOfNulls<List<JSONObject>>(1)
            val cfRef = arrayOfNulls<List<JSONObject>>(1)
            val latch = CountDownLatch(2)
            Thread {
                try { mrRef[0] = mrPoolRaw(query, type, mcVersion, loader, COMBINED_POOL) } catch (e: Throwable) {}
                latch.countDown()
            }.apply { isDaemon = true }.start()
            Thread {
                try { cfRef[0] = cfPoolRaw(query, type, mcVersion, loader, COMBINED_POOL) } catch (e: Throwable) {}
                latch.countDown()
            }.apply { isDaemon = true }.start()
            latch.await()

            val mr = mrRef[0]; val cf = cfRef[0]
            if (mr == null && cf == null) throw IOException("Modrinth 与 CurseForge 都连不上（可先切回单个下载源）")
            val seen = HashSet<String>()
            val merged = ((mr ?: emptyList()) + (cf ?: emptyList()))
                .filter { seen.add("${it.optString("src")}:${it.optString("id")}") }
                .sortedByDescending { it.optLong("downloads") }
            pool = Pool(merged, System.currentTimeMillis())
            combinedCache[key] = pool
            if (combinedCache.size > 24) combinedCache.keys.firstOrNull()?.let { combinedCache.remove(it) }
        }

        val p = maxOf(1, page)
        val from = (p - 1) * PAGE_SIZE
        val slice = pool.items.drop(from).take(PAGE_SIZE).map { JSONObject(it.toString()) }
        decorateHits(slice)
        return JSONObject().put("ok", true).put("hits", JSONArray(slice)).put("total", pool.items.size)
    }

    private fun mrPoolRaw(query: String, type: String, mcVersion: String, loader: String, limit: Int): List<JSONObject> {
        val kws = toSearchKeywords(query)
        val raw: List<JSONObject> = if (kws != null) {
            mrSearchByKeywords(kws, type, mcVersion, loader, limit)
        } else {
            val j = mrJson(
                "/search?limit=$limit&offset=0&index=downloads&query=" + Net.enc(query) +
                    "&facets=" + Net.enc(facetsFor(type, mcVersion, loader).toString())
            )
            val h = j.optJSONArray("hits") ?: JSONArray()
            (0 until h.length()).mapNotNull { h.optJSONObject(it) }
        }
        return raw.map { h ->
            JSONObject().put("id", h.optString("project_id")).put("slug", h.optString("slug"))
                .put("title", h.optString("title")).put("desc", h.optString("description"))
                .put("downloads", h.optLong("downloads")).put("icon", h.optString("icon_url"))
                .put("author", h.optString("author")).put("src", "modrinth")
        }
    }

    private fun cfPoolRaw(query: String, type: String, mcVersion: String, loader: String, limit: Int): List<JSONObject> {
        val kws = toSearchKeywords(query)
        val cfQuery = if (kws != null) kws.maxByOrNull { it.length } ?: query else query
        val out = ArrayList<JSONObject>()
        var off = 0
        while (off < limit) {
            val size = minOf(50, limit - off)
            val j = cfJson("/mods/search?" + cfQueryString(type, mcVersion, loader, cfQuery, off, size))
            val arr = j.optJSONArray("data") ?: JSONArray()
            out.addAll(cfHitsFrom(arr))
            if (arr.length() < size) break
            off += size
        }
        return out
    }

    /* ==================================================================
     * 搜索结果本地化：图标 + 中文名 + PCL 式标题拆分
     * ================================================================== */

    private fun decorateHits(hits: List<JSONObject>) {
        if (hits.isEmpty()) return
        runConcurrent(hits.size, 6) { i ->
            val h = hits[i]
            h.put("icon", fetchIcon(h.optString("icon"), h.optString("id")))
        }
        for (h in hits) {
            val id = h.optString("id").removePrefix("cf")
            val zh = zhNameFor(id, h.optString("title"))
            val t = pclTitle(zh, h.optString("title"))
            h.put("titleZh", zh)
            h.put("titleMain", t.first)
            h.put("titleSub", JSONArray(t.second))
        }
    }

    /** PCL 式标题拆分：中文名作主标题，括号内的英文原名 / 加载器标记进副标题 */
    private fun pclTitle(zhName: String, rawName: String): Pair<String, List<String>> {
        val src = zhName.ifEmpty { rawName }
        if (src.isEmpty()) return "" to emptyList()

        val sub = LinkedHashSet<String>()
        val parenRe = Regex("[\\(（\\[【]([^\\)）\\]】]+)[\\)）\\]】]")
        parenRe.findAll(src).forEach { sub.add(it.groupValues[1].trim()) }
        var title = src.replace(parenRe, " ").replace(Regex("\\s+"), " ").trim().trimEnd('-', '·').trim()

        // " - xxx" 后缀 → 副标题
        val dash = title.lastIndexOf(" - ")
        if (dash > 0) {
            val suffix = title.substring(dash + 3).trim()
            if (suffix.isNotEmpty() && suffix.length < 40) sub.add(suffix)
            title = title.substring(0, dash).trim()
        }

        // 加载器标记：正文里出现时提取为副标题（"XXX Fabric版" → 主标题 XXX，副标题 Fabric 版）
        for (tk in listOf("Fabric", "Forge", "NeoForge", "Quilt", "OptiFine")) {
            if (Regex("(?i)\\b$tk\\b").containsMatchIn(title)) {
                sub.add("$tk 版")
                title = title.replace(Regex("(?i)\\s*\\(?\\b$tk\\b\\s*版?\\)?"), " ").replace(Regex("\\s+"), " ").trim().trimEnd('-', '·').trim()
            }
        }

        if (zhName.isEmpty() && rawName.isNotEmpty() && rawName != title) sub.add(rawName)
        if (title.isEmpty()) title = src

        val list = sub.filter { it.isNotEmpty() && it != title }.toList()
        return title to list
    }

    /* ==================================================================
     * 项目详情
     * ================================================================== */

    fun detail(projectId: String, versionId: String, source: String, mcVer: String, loaderLc: String): JSONObject {
        val out = JSONObject().put("ok", true).put("files", JSONArray()).put("gallery", JSONArray())
        if (source == "curseforge") {
            val modId = projectId.removePrefix("cf")
            val raw = cfJson("/mods/$modId").optJSONObject("data") ?: JSONObject()
            out.put("title", raw.optString("name"))
            out.put("slug", raw.optString("slug"))
            val links = raw.optJSONObject("links")
            out.put("pageUrl", links?.optString("websiteUrl").orEmpty())
            out.put("sourceUrl", links?.optString("sourceUrl").orEmpty())
            out.put("downloads", raw.optLong("downloadCount"))
            out.put("tags", JSONArray((raw.optJSONArray("categories") ?: JSONArray()).let { arr ->
                (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.optString("name") }.map { catZh(it) }.take(4)
            }))
            val logo = raw.optJSONObject("logo")
            out.put("icon", fetchIcon(logo?.optString("url").orEmpty().ifEmpty { logo?.optString("thumbnailUrl").orEmpty() }, projectId))
            out.put("descHtml", Net.sanitizeHtml(raw.optString("summary")))
            val shots = raw.optJSONArray("screenshots") ?: JSONArray()
            val gallery = JSONArray()
            for (i in 0 until minOf(4, shots.length())) {
                val u = shots.optJSONObject(i)?.let { it.optString("url").ifEmpty { it.optString("thumbnailUrl") } }.orEmpty()
                fetchIcon(u, "$projectId-shot-$i", 6 * 1024 * 1024).takeIf { it.isNotEmpty() }?.let { gallery.put(it) }
            }
            out.put("gallery", gallery)
            if (versionId.isNotEmpty()) {
                val lt = CF_LOADER[loaderLc] ?: 0
                var files = JSONArray()
                val variants = listOf(
                    "/mods/$modId/files?gameVersion=" + Net.enc(mcVer) + (if (lt > 0) "&modLoaderType=$lt" else "") + "&pageSize=12",
                    "/mods/$modId/files?gameVersion=" + Net.enc(mcVer) + "&pageSize=12"
                )
                for (u in variants) {
                    files = try { cfJson(u).optJSONArray("data") ?: JSONArray() } catch (e: Exception) { JSONArray() }
                    if (files.length() > 0) break
                }
                val sorted = (0 until files.length()).mapNotNull { files.optJSONObject(it) }
                    .sortedByDescending { it.optString("fileDate") }
                out.put("files", JSONArray(sorted.take(8).map { f ->
                    JSONObject().put("ref", f.optString("id"))
                        .put("name", f.optString("displayName").ifEmpty { f.optString("fileName") })
                        .put("date", f.optString("fileDate"))
                        .put("size", f.optLong("fileLength"))
                        .put("tags", JSONArray((f.optJSONArray("gameVersions") ?: JSONArray()).let { arr ->
                            (0 until arr.length()).map { arr.optString(it) }
                                .filter { Regex("^(forge|fabric|neoforge|quilt|\\d)", RegexOption.IGNORE_CASE).containsMatchIn(it) }.take(4)
                        }))
                }))
            }
            return out
        }

        val pr = mrJson("/project/" + Net.enc(projectId))
        out.put("title", pr.optString("title"))
        out.put("slug", pr.optString("slug"))
        out.put("pageUrl", if (pr.optString("slug").isNotEmpty()) "https://modrinth.com/mod/${pr.optString("slug")}" else "")
        out.put("sourceUrl", pr.optString("source_url"))
        out.put("descHtml", Net.sanitizeHtml(pr.optString("body")))
        out.put("downloads", pr.optLong("downloads"))
        out.put("tags", JSONArray((pr.optJSONArray("categories") ?: JSONArray()).let { arr ->
            (0 until arr.length()).map { catZh(arr.optString(it)) }.take(4)
        }))
        out.put("icon", fetchIcon(pr.optString("icon_url"), projectId))
        val gallery = JSONArray()
        val gal = pr.optJSONArray("gallery") ?: JSONArray()
        for (i in 0 until minOf(4, gal.length())) {
            val u = gal.optJSONObject(i)?.optString("url").orEmpty()
            fetchIcon(u, "$projectId-shot-$i", 6 * 1024 * 1024).takeIf { it.isNotEmpty() }?.let { gallery.put(it) }
        }
        out.put("gallery", gallery)

        if (versionId.isNotEmpty()) {
            val parts = mutableListOf<String>()
            if (mcVer.isNotEmpty()) parts.add("game_versions=" + Net.enc(JSONArray().put(mcVer).toString()))
            if (loaderLc.isNotEmpty()) parts.add("loaders=" + Net.enc(JSONArray().put(loaderLc).toString()))
            val path = "/project/" + Net.enc(projectId) + "/version" + (if (parts.isNotEmpty()) "?" + parts.joinToString("&") else "")
            var vers = try { mrJsonArray(path) } catch (e: Exception) { JSONArray() }
            if (vers.length() == 0 && parts.isNotEmpty()) {
                vers = try { mrJsonArray("/project/" + Net.enc(projectId) + "/version") } catch (e: Exception) { JSONArray() }
            }
            val list = (0 until minOf(8, vers.length())).mapNotNull { vers.optJSONObject(it) }
            out.put("files", JSONArray(list.map { v ->
                val fl = v.optJSONArray("files") ?: JSONArray()
                var f: JSONObject? = null
                for (i in 0 until fl.length()) { val x = fl.optJSONObject(i) ?: continue; if (x.optBoolean("primary")) { f = x; break } }
                if (f == null && fl.length() > 0) f = fl.optJSONObject(0)
                JSONObject().put("ref", v.optString("id"))
                    .put("name", v.optString("name").ifEmpty { f?.optString("filename").orEmpty() }.ifEmpty { v.optString("version_number") })
                    .put("date", v.optString("date_published"))
                    .put("size", f?.optLong("size") ?: 0L)
                    .put("tags", JSONArray((v.optJSONArray("game_versions") ?: JSONArray()).let { arr ->
                        (0 until minOf(4, arr.length())).map { arr.optString(it) }
                    }))
            }))
        }
        return out
    }

    /** 单个版本的详情（整合包安装时取 .mrpack 直链用） */
    fun mrVersion(versionId: String): JSONObject = mrJson("/version/" + Net.enc(versionId))

    /** 项目全部版本（整合包挑选 .mrpack 用） */
    fun mrAllVersions(projectId: String): JSONArray = mrJsonArray("/project/" + Net.enc(projectId) + "/version")

    /** CurseForge 项目文件列表（原始结构，安装时自行挑文件） */
    fun cfFiles(modId: String, mcVer: String, loaderLc: String): JSONArray {
        val lt = CF_LOADER[loaderLc] ?: 0
        val variants = listOf(
            "/mods/$modId/files?gameVersion=" + Net.enc(mcVer) + (if (lt > 0) "&modLoaderType=$lt" else ""),
            "/mods/$modId/files?gameVersion=" + Net.enc(mcVer)
        )
        for (u in variants) {
            val arr = try { cfJson(u).optJSONArray("data") ?: JSONArray() } catch (e: Exception) { JSONArray() }
            if (arr.length() > 0) return arr
        }
        // 都为空：拿最近 8 个构建，供界面给出「它最新支持哪些版本」的提示
        return try { cfJson("/mods/$modId/files?pageIndex=0&pageSize=8").optJSONArray("data") ?: JSONArray() }
        catch (e: Exception) { JSONArray() }
    }

    /** CurseForge 项目基础信息（拿标题做提示文案用） */
    fun cfProject(modId: String): JSONObject = try { cfJson("/mods/$modId").optJSONObject("data") ?: JSONObject() } catch (e: Exception) { JSONObject() }

    /** 按项目 id 批量取详情（MOD 富化用） */
    fun projectsByIds(ids: List<String>): JSONArray {
        if (ids.isEmpty()) return JSONArray()
        return mrJsonArray("/projects?ids=" + Net.enc(JSONArray(ids).toString()))
    }

    /** 取 Modrinth 项目的「版本 → 文件」候选，供安装时精确挑选 */
    fun projectVersions(projectId: String, mcVer: String, loader: String): JSONArray {
        val parts = mutableListOf<String>()
        if (mcVer.isNotEmpty()) parts.add("game_versions=" + Net.enc(JSONArray().put(mcVer).toString()))
        if (loader.isNotEmpty()) parts.add("loaders=" + Net.enc(JSONArray().put(loader).toString()))
        val path = "/project/" + Net.enc(projectId) + "/version" + (if (parts.isNotEmpty()) "?" + parts.joinToString("&") else "")
        return try { mrJsonArray(path) } catch (e: Exception) { JSONArray() }
    }

    /* ==================================================================
     * 下载（源站文件）
     * ================================================================== */

    /** Modrinth CDN 文件：官方优先，超时切镜像；两轮抗抖动 */
    fun mrDownload(url: String, dest: File, onProgress: ((Int, Long, Long) -> Unit)? = null) {
        val mirror = cdnMirror(url)
        val attempts = if (modrinthAvailable) {
            if (preferMirror) listOfNotNull(mirror?.to(20000), url to 15000) else listOf(url to 15000) + listOfNotNull(mirror?.to(20000))
        } else listOf(url to 15000) + listOfNotNull(mirror?.to(20000))

        var last: Exception? = null
        for (round in 0 until 2) {
            if (round > 0) Thread.sleep(1500)
            for ((u, ms) in attempts) {
                try {
                    Net.download(u, dest, null, ms, onProgress)
                    if (u == url) modrinthAvailable = true
                    return
                } catch (e: Exception) { last = e }
            }
        }
        throw IOException(last?.message ?: "下载失败")
    }

    /** CurseForge 文件：API 直链可能 404，补 mediafilez 拼接回退 */
    fun cfDownload(fileId: String, fileName: String, apiUrl: String, dest: File, onProgress: ((Int, Long, Long) -> Unit)? = null) {
        val urls = LinkedHashSet<String>()
        if (apiUrl.isNotEmpty()) urls.add(apiUrl)
        val id = fileId.toIntOrNull() ?: 0
        if (id > 0 && fileName.isNotEmpty()) {
            urls.add("https://mediafilez.forgecdn.net/files/${id / 1000}/${id % 1000}/" + Net.enc(fileName))
        }
        var last: Exception? = null
        for (round in 0 until 2) {
            if (round > 0) Thread.sleep(1500)
            for (u in urls) {
                try { Net.download(u, dest, null, 60000, onProgress); return }
                catch (e: Exception) { last = e }
            }
        }
        throw IOException(last?.message ?: "下载失败")
    }

    private fun cdnMirror(url: String): String? = try {
        val u = java.net.URL(url)
        if (u.host == "cdn.modrinth.com") MIRROR + u.path else null
    } catch (e: Throwable) { null }

    fun fetchIcon(uri: String, cacheKey: String, maxBytes: Int = 4 * 1024 * 1024): String {
        if (uri.isEmpty()) return ""
        // 有些条目 icon 已经是 data URI（CurseForge 偶尔返回）
        if (uri.startsWith("data:")) return uri
        return Net.fetchIconData(uri, cacheKey, iconCacheDir(), maxBytes)
    }

    /* ==================================================================
     * 请求封装
     * ================================================================== */

    @Volatile private var modrinthAvailable = true

    /**
     * 官方源优先（8s），超时切镜像（20s）。
     * 官方一旦失败就进 10 分钟镜像冷却 —— 对应桌面端的 mrMirrorUntil 机制：
     * 弱网下每次都先等 8 秒官方超时，列表页会明显发卡，冷却能避开这段等待。
     */
    private fun mrSources(path: String): List<Pair<String, Int>> =
        if (preferMirror) listOf(MIRROR + MR_PATH + path to 20000, MODRINTH_API + path to 8000)
        else listOf(MODRINTH_API + path to 8000, MIRROR + MR_PATH + path to 20000)

    private fun mrJson(path: String): JSONObject {
        try {
            // 先单独试官方源：成功就能确认官方可用，清掉冷却
            if (!preferMirror) {
                try {
                    val r = JSONObject(Net.get(MODRINTH_API + path, 8000).toString(Charsets.UTF_8))
                    modrinthAvailable = true
                    return r
                } catch (e: Exception) {
                    enterMirrorCooldown()
                }
            }
            val r = Net.fromSourcesJson(mrSources(path))
            modrinthAvailable = true
            return r
        } catch (e: Exception) {
            modrinthAvailable = false
            throw e
        }
    }

    private fun mrJsonArray(path: String): JSONArray {
        try {
            if (!preferMirror) {
                try {
                    return JSONArray(Net.get(MODRINTH_API + path, 8000).toString(Charsets.UTF_8))
                } catch (e: Exception) {
                    enterMirrorCooldown()
                }
            }
            return JSONArray(String(Net.fromSources(mrSources(path)), Charsets.UTF_8))
        } catch (e: Exception) {
            throw e
        }
    }

    private fun enterMirrorCooldown() {
        if (System.currentTimeMillis() >= mirrorUntil) {
            Log.i(TAG, "官方源超时/不可用，10 分钟内优先走镜像")
        }
        mirrorUntil = System.currentTimeMillis() + MIRROR_COOLDOWN
    }

    fun mrPost(path: String, body: String): JSONObject {
        var last: Exception? = null
        for (u in mrSources(path).map { it.first }) {
            try { return JSONObject(Net.postJson(u, body, 12000)) } catch (e: Exception) { last = e }
        }
        throw IOException(last?.message ?: "请求失败")
    }

    private fun cfJson(path: String): JSONObject {
        var last: Exception? = null
        for (round in 0 until 2) {   // 镜像偶发抖动，失败等 1.2s 重试一次
            if (round > 0) Thread.sleep(1200)
            try { return Net.getJson(CF_API + path, 15000) } catch (e: Exception) { last = e }
        }
        throw IOException("CurseForge 接口不可用: ${last?.message}")
    }

    /** 分类英文 → 中文（未命中保留原文） */
    fun catZh(name: String): String {
        val n = name.lowercase()
        if (Regex("[\\u4e00-\\u9fff]").containsMatchIn(n)) return name
        for ((re, zh) in CAT_ZH) if (re.containsMatchIn(n)) return zh
        return name
    }

    /** 并发跑一批任务（图标拉取用） */
    private fun runConcurrent(total: Int, limit: Int, worker: (Int) -> Unit) {
        if (total <= 0) return
        val idx = AtomicInteger(0)
        val threads = minOf(limit, total)
        val latch = CountDownLatch(threads)
        repeat(threads) {
            Thread {
                while (true) {
                    val i = idx.getAndIncrement()
                    if (i >= total) break
                    try { worker(i) } catch (e: Throwable) { /* 单条失败不影响整批 */ }
                }
                latch.countDown()
            }.apply { isDaemon = true }.start()
        }
        latch.await()
    }

    companion object {
        private const val TAG = "XLC-Modrinth"

        const val MIRROR = "https://mod.mcimirror.top"
        private const val MR_PATH = "/modrinth/v2"
        private const val MODRINTH_API = "https://api.modrinth.com/v2"
        private const val CF_API = "$MIRROR/curseforge/v1"

        private const val PAGE_SIZE = 20
        private const val COMBINED_POOL = 100
        private const val COMBINED_TTL = 5 * 60 * 1000L

        /** 镜像冷却窗口：官方源失败后的 10 分钟内优先走镜像（对应桌面端 mrMirrorUntil） */
        private const val MIRROR_COOLDOWN = 10 * 60 * 1000L
        @Volatile private var mirrorUntil = 0L

        /** 冷却窗口内为 true。Net 拉图标时也读这个值决定先试官方还是先试镜像 */
        val preferMirror: Boolean
            get() = System.currentTimeMillis() < mirrorUntil

        private var mirrorUntilJustSet = false

        val MR_TYPES = listOf("mod", "modpack", "resourcepack", "datapack")
        private val CF_CLASS = mapOf("mod" to 6, "modpack" to 4471, "resourcepack" to 12, "datapack" to 6945)
        private val CF_LOADER = mapOf("forge" to 1, "fabric" to 4, "neoforge" to 5, "quilt" to 6)

        private val CAT_ZH = listOf(
            Regex("technolog|tech") to "科技", Regex("adventure|rpg") to "冒险", Regex("magic") to "魔法",
            Regex("utility") to "实用", Regex("storage") to "存储", Regex("equipment|armor|weapon") to "装备",
            Regex("world gen|worldgen") to "世界生成", Regex("mobs|creature") to "生物", Regex("performance|optimiz") to "性能",
            Regex("energy|power") to "能源", Regex("transport") to "物流运输", Regex("processing|automation") to "加工自动化",
            Regex("librar|api") to "前置库", Regex("cosmetic|decoration|deco") to "装饰建筑", Regex("build") to "建筑",
            Regex("explor") to "探索", Regex("economy") to "经济", Regex("social|vot") to "社交", Regex("education") to "教育",
            Regex("quest") to "任务", Regex("mini.?game") to "小游戏", Regex("futur|scifi|sci-fi") to "科幻",
            Regex("medieval") to "中世纪", Regex("skyblock") to "空岛", Regex("hardcore") to "极限生存",
            Regex("combat") to "战斗", Regex("farm|food") to "农业食物", Regex("map") to "地图", Regex("bug fix") to "修复",
            Regex("tweaks|misc") to "杂项改进"
        )
    }
}
