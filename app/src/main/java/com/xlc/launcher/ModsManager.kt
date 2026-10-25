package com.xlc.launcher

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

/**
 * MOD 目录管理。
 *
 * 对应桌面端 main.js 的 mods:list / mods:toggle / mods:delete / mods:enrich。
 *
 * 目录语义（PCL 式版本隔离，必须与桌面端完全一致）：
 *   - instance 为空 → 全局 <gameDir>/mods
 *   - instance 非空 → <gameDir>/versions/<instance>/mods
 *   禁用 = 文件名追加 .disabled（不删文件），与桌面端同规则。
 *
 * enrich 用两条互补的信息源：
 *   1. 离线：读 jar 内置元数据（fabric.mod.json / META-INF/mods.toml / mcmod.info）+ jar 内图标
 *   2. 在线：按 SHA1 批量问 Modrinth（/version_files → /projects），补全标准名 / 简介 / 图标
 * 注意：fabric.mod.json 里可能含裸控制字符（如 ItemScroller/EMF 这类模组），
 * 直接 JSONObject 解析会抛异常 —— 所以先试 JSON，失败退回正则。
 */
class ModsManager(
    private val gameDir: () -> File,
    private val api: ModrinthApi
) {

    /* ==================================================================
     * 目录解析
     * ================================================================== */

    fun safeInstanceDir(instance: String?): File? {
        val id = instance.orEmpty()
        if (id.isEmpty() || id.contains("..") || id.contains(Regex("[/\\\\:*?\"<>|]"))) return null
        return File(gameDir(), "versions/$id")
    }

    fun modsDirFor(instance: String?): File {
        val d = safeInstanceDir(instance)
        return if (d != null) File(d, "mods") else File(gameDir(), "mods")
    }

    private fun safeModsPath(name: String?, instance: String?): File? {
        val base = File(name.orEmpty()).name
        if (!Regex("\\.jar(\\.disabled)?$", RegexOption.IGNORE_CASE).containsMatchIn(base)) return null
        return File(modsDirFor(instance), base)
    }

    /* ==================================================================
     * 列表 / 启用禁用 / 删除
     * ================================================================== */

    fun list(instance: String?): JSONObject {
        val dir = modsDirFor(instance)
        val names = dir.listFiles()?.map { it.name } ?: return JSONObject().put("ok", true).put("mods", JSONArray())
        val mods = JSONArray()
        for (n in names.sortedBy { it.lowercase() }) {
            if (!Regex("\\.(jar|disabled)$", RegexOption.IGNORE_CASE).containsMatchIn(n)) continue
            val f = File(dir, n)
            if (!f.isFile) continue
            mods.put(
                JSONObject().put("name", n)
                    .put("disabled", n.endsWith(".disabled", true))
                    .put("size", f.length())
                    .put("mtime", f.lastModified().toDouble())
            )
        }
        return JSONObject().put("ok", true).put("mods", mods)
    }

    fun toggle(name: String?, instance: String?): JSONObject {
        val f = safeModsPath(name, instance) ?: return err("文件名无效")
        if (!f.isFile) return err("文件不存在")
        val target = if (f.name.endsWith(".disabled", true)) File(f.parentFile, f.name.removeSuffix(".disabled"))
        else File(f.parentFile, f.name + ".disabled")
        return if (f.renameTo(target)) JSONObject().put("ok", true).put("now", target.name)
        else err("重命名失败（文件可能被占用）")
    }

    fun delete(name: String?, instance: String?): JSONObject {
        val f = safeModsPath(name, instance) ?: return err("文件名无效")
        if (!f.isFile) return err("文件不存在")
        return if (f.delete()) JSONObject().put("ok", true) else err("删除失败（文件可能被占用）")
    }

    /* ==================================================================
     * 富化：jar 内置元数据 + Modrinth 在线匹配
     * ================================================================== */

    fun enrich(instance: String?, names: List<String>): JSONObject {
        val dir = modsDirFor(instance)
        val files = ArrayList<Pair<String, File>>()
        for (n in names.take(200)) {
            val f = File(dir, File(n).name)
            if (f.isFile) files.add(n to f)
        }
        if (files.isEmpty()) return JSONObject().put("ok", true).put("meta", JSONObject())

        // 1. 计算 SHA1
        val sha1s = HashMap<String, String>()   // name → sha1
        runConcurrent(files.size, 4) { i ->
            val (n, f) = files[i]
            try { synchronized(sha1s) { sha1s[n] = Net.sha1File(f) } } catch (e: Throwable) {}
        }

        // 2. 批量问 Modrinth：sha1 → 版本对象
        val hashMap = HashMap<String, JSONObject>()
        if (sha1s.isNotEmpty()) {
            try {
                val body = JSONObject()
                    .put("hashes", JSONArray(sha1s.values.toList()))
                    .put("algorithm", "sha1")
                val r = api.mrPost("/version_files", body.toString())
                val keys = r.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    r.optJSONObject(k)?.let { hashMap[k] = it }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Modrinth 批量匹配失败（将只用离线元数据）: ${e.message}")
            }
        }

        // 3. 批量取项目详情
        val projectIds = LinkedHashSet<String>()
        for (v in hashMap.values) v.optString("project_id").takeIf { it.isNotEmpty() }?.let { projectIds.add(it) }
        val projById = HashMap<String, JSONObject>()
        if (projectIds.isNotEmpty()) {
            try {
                val arr = api.projectsByIds(projectIds.toList())
                for (i in 0 until arr.length()) {
                    val p = arr.optJSONObject(i) ?: continue
                    projById[p.optString("id")] = p
                }
            } catch (e: Exception) {
                Log.w(TAG, "Modrinth 项目详情拉取失败: ${e.message}")
            }
        }

        // 4. 逐 jar 组装
        val out = JSONObject()
        for ((name, f) in files) {
            val sha1 = sha1s[name].orEmpty()
            val local = readLocalMeta(f)
            var localIcon = ""
            val iconEntry = local.optString("iconEntry")
            if (iconEntry.isNotEmpty()) {
                try {
                    Net.zipEntry(f, iconEntry)?.let { b ->
                        val du = Net.dataUri(b, 2 * 1024 * 1024)
                        if (du.isNotEmpty()) localIcon = du
                    }
                } catch (e: Throwable) {}
            }

            val ver = if (sha1.isNotEmpty()) hashMap[sha1] else null
            var online: JSONObject? = null
            if (ver != null) {
                val pr = projById[ver.optString("project_id")]
                if (pr != null) {
                    val pid = pr.optString("id")
                    val slug = pr.optString("slug")
                    val zh = api.zhNameFor(pid, local.optString("id"), pr.optString("title"))
                    online = JSONObject()
                        .put("title", pr.optString("title"))
                        .put("titleZh", zh)
                        .put("slug", slug)
                        .put("description", pr.optString("description"))
                        .put("descZh", "")
                        .put("pageUrl", if (slug.isNotEmpty()) "https://modrinth.com/mod/$slug" else "")
                        .put("iconDataUri", api.fetchIcon(pr.optString("icon_url"), pid))
                }
            }
            // 无在线匹配时用内置库按 modid 兜底中文名（离线也能显示中文）
            if (local.optString("id").isNotEmpty() && (online == null || online.optString("titleZh").isEmpty())) {
                val zh = api.zhNameFor(local.optString("id"))
                if (zh.isNotEmpty()) {
                    if (online == null) online = JSONObject()
                    online.put("titleZh", zh)
                }
            }

            val loaders = ver?.optJSONArray("loaders") ?: JSONArray()
            val gvs = ver?.optJSONArray("game_versions") ?: JSONArray()
            out.put(
                name, JSONObject()
                    .put("size", f.length())
                    .put("sha1", sha1)
                    .put("local", local)
                    .put("online", online ?: JSONObject.NULL)
                    .put("localIconDataUri", localIcon)
                    .put("version", ver?.optString("version_number").orEmpty().ifEmpty { local.optString("version") })
                    .put("loaders", loaders)
                    .put("gameVersions", gvs)
            )
        }
        return JSONObject().put("ok", true).put("meta", out)
    }

    /* ==================================================================
     * jar 内置元数据
     * ================================================================== */

    private fun readLocalMeta(f: File): JSONObject {
        // 1) fabric.mod.json（Fabric / Quilt）
        Net.zipEntry(f, "fabric.mod.json")?.let { b ->
            val txt = String(b, Charsets.UTF_8)
            parseFabric(txt)?.let { return it }
        }
        // 2) META-INF/mods.toml（Forge / NeoForge）
        Net.zipEntry(f, "META-INF/mods.toml")?.let { b ->
            val m = parseModsToml(String(b, Charsets.UTF_8))
            if (m.optString("id").isNotEmpty()) return m
        }
        // 3) mcmod.info（老版本 Forge）
        Net.zipEntry(f, "mcmod.info")?.let { b ->
            val txt = String(b, Charsets.UTF_8).removePrefix("\uFEFF")
            parseMcmodInfo(txt)?.let { return it }
        }
        return JSONObject().put("id", "").put("name", "").put("version", "")
            .put("description", "").put("iconEntry", "").put("authors", "")
    }

    /**
     * fabric.mod.json 解析。
     * 优先 JSONObject；失败（含裸控制字符）退回正则逐字段抓 —— 与桌面端 zipReadEntry + 正则同策略。
     */
    private fun parseFabric(txt: String): JSONObject? = try {
        val j = JSONObject(txt)
        val icon = j.opt("icon")
        val iconEntry = when (icon) {
            is String -> icon
            is JSONObject -> icon.optString("default")
            else -> ""
        }
        val authors = StringBuilder()
        j.optJSONArray("authors")?.let { arr ->
            for (i in 0 until arr.length()) {
                val a = arr.opt(i)
                val nm = if (a is JSONObject) a.optString("name") else a?.toString().orEmpty()
                if (nm.isNotEmpty()) { if (authors.isNotEmpty()) authors.append(", "); authors.append(nm) }
            }
        }
        var ver = j.optString("version")
        if (ver.contains("\${")) ver = ""
        JSONObject().put("id", j.optString("id"))
            .put("name", j.optString("name").ifEmpty { j.optString("id") })
            .put("version", ver)
            .put("description", j.optString("description"))
            .put("iconEntry", iconEntry)
            .put("authors", authors.toString())
    } catch (e: Throwable) {
        // 裸控制字符导致 JSON 解析失败 → 正则兜底
        try {
            fun grab(k: String): String {
                val m = Regex("\"$k\"\\s*:\\s*\"([^\"]*)\"").find(txt) ?: return ""
                return m.groupValues[1]
            }
            val id = grab("id")
            if (id.isEmpty()) null
            else JSONObject().put("id", id)
                .put("name", grab("name").ifEmpty { id })
                .put("version", grab("version").let { if (it.contains("\${")) "" else it })
                .put("description", grab("description"))
                .put("iconEntry", grab("icon"))
                .put("authors", "")
        } catch (e2: Throwable) { null }
    }

    /** mods.toml：对应桌面端 parseModsToml，支持 """ 与 ''' 多行值 */
    private fun parseModsToml(src: String): JSONObject {
        fun grab(k: String): String {
            val patterns = listOf(
                Regex("^$k\\s*=\\s*\"\"\"([\\s\\S]*?)\"\"\"", RegexOption.MULTILINE),
                Regex("^$k\\s*=\\s*'''([\\s\\S]*?)'''", RegexOption.MULTILINE),
                Regex("^$k\\s*=\\s*\"([^\"]*)\"", RegexOption.MULTILINE),
                Regex("^$k\\s*=\\s*'([^']*)'", RegexOption.MULTILINE)
            )
            for (p in patterns) p.find(src)?.let { return it.groupValues[1].trim() }
            return ""
        }
        val id = grab("modId")
        var ver = grab("version")
        if (ver.contains("\${")) ver = ""
        return JSONObject().put("id", id)
            .put("name", grab("displayName").ifEmpty { id })
            .put("version", ver)
            .put("description", grab("description"))
            .put("iconEntry", grab("logoFile"))
            .put("authors", grab("authors"))
    }

    private fun parseMcmodInfo(txt: String): JSONObject? = try {
        val arr: JSONArray? = if (txt.trimStart().startsWith("[")) JSONArray(txt) else null
        val obj: JSONObject? = if (arr == null) JSONObject(txt) else null
        val m0: JSONObject? = arr?.optJSONObject(0)
            ?: (obj?.optJSONArray("modList") ?: obj?.optJSONArray("mods"))?.optJSONObject(0)
            ?: obj
        if (m0 == null) null else {
            val authors = StringBuilder()
            m0.optJSONArray("authorList")?.let { a ->
                for (i in 0 until a.length()) {
                    if (i > 0) authors.append(", ")
                    authors.append(a.optString(i))
                }
            }
            JSONObject().put("id", m0.optString("modid"))
                .put("name", m0.optString("name").ifEmpty { m0.optString("modid") })
                .put("version", m0.optString("version"))
                .put("description", m0.optString("description"))
                .put("iconEntry", m0.optString("logoFile"))
                .put("authors", authors.toString())
        }
    } catch (e: Throwable) { null }

    /* ==================================================================
     * 工具
     * ================================================================== */

    private fun err(msg: String) = JSONObject().put("ok", false).put("error", msg)

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
                    try { worker(i) } catch (e: Throwable) {}
                }
                latch.countDown()
            }.apply { isDaemon = true }.start()
        }
        latch.await()
    }

    companion object {
        private const val TAG = "XLC-Mods"
    }
}
