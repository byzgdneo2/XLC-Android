package com.xlc.launcher

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.zip.ZipInputStream

/**
 * MOD / 资源包 / 数据包 / 整合包 / 自定义文件 的下载与安装。
 *
 * 对应桌面端 main.js 的：
 *   modrinth:install-mod        → installMod()
 *   modrinth:install-pack       → installPack()    （资源包 / 数据包）
 *   modrinth:install-modpack    → installModpack() （.mrpack 整合包）
 *   custom:download             → customDownload() （任意 URL，含光影包）
 *
 * 与桌面端一致的关键行为：
 *   - MOD 只能装进带加载器的实例；目标是 Vanilla 时明确报错并给出指引
 *   - 重复安装拦截：目标 jar（含 .disabled 变体）已存在时不静默覆盖，避免丢用户禁用状态
 *   - 版本不匹配时查出「它实际支持哪些版本」放进错误文案，而不是只说"没找到"
 *   - 下载全程推送 install:progress，界面进度条不用改
 */
class ModInstaller(
    private val gameDir: () -> File,
    private val installer: GameInstaller,
    private val api: ModrinthApi,
    private val modsManager: ModsManager,
    private val emit: (String, JSONObject) -> Unit,
    private val setStatus: (String) -> Unit
) {

    /* ==================================================================
     * 安装 MOD
     * ================================================================== */

    fun installMod(p: JSONObject): JSONObject {
        return try {
        val projectId = p.optString("projectId")
        val versionId = p.optString("versionId")
        val instance = p.optString("instance")
        val source = p.optString("source", "modrinth")
        val fileRef = p.optString("fileRef")
        if (projectId.isEmpty()) throw IOException("缺少项目 ID")

        val ctx = installer.resolveVersionContext(versionId)
        if (!ctx.optBoolean("ok")) throw IOException(ctx.optString("error").ifEmpty { "目标实例无效" })
        val mcVer = ctx.optString("rootId")
        val loaderLc = ctx.optString("loaderLc")
        if (loaderLc.isEmpty()) {
            throw IOException("目标版本是 Vanilla，无法安装 MOD（请先安装 Fabric / Quilt 等加载器版本）")
        }

        val dir = modsManager.modsDirFor(instance)

        if (source == "curseforge") {
            val modId = projectId.removePrefix("cf")
            if (!Regex("^\\d+$").matches(modId)) throw IOException("CurseForge 项目 ID 无效")
            val files = api.cfFiles(modId, mcVer, loaderLc)
            if (files.length() == 0) throw IOException(cfVersionHint(modId, mcVer, loaderLc))
            val list = (0 until files.length()).mapNotNull { files.optJSONObject(it) }
                .sortedByDescending { it.optString("fileDate") }
            val file = list.find { it.optString("id") == fileRef } ?: list[0]
            val name = file.optString("fileName")
            if (name.isEmpty()) throw IOException("版本下没有可用 jar 文件")
            val dest = File(dir, name)
            dupCheck(dest)?.let { throw IOException(it) }
            setStatus("下载 MOD: $name")
            progress("mod-dl", 10, "下载 MOD $name")
            api.cfDownload(file.optString("id"), name, file.optString("downloadUrl"), dest) { pct, _, _ ->
                progress("mod-dl", pct.coerceAtLeast(10), "下载 MOD $name" + if (pct >= 0) " $pct%" else "")
            }
            setStatus("就绪")
            toast("MOD 已安装到「${instance.ifEmpty { "全局 mods" }}」: $name")
            return JSONObject().put("ok", true).put("file", name)
        }

        val vers = api.projectVersions(projectId, mcVer, loaderLc)
        if (vers.length() == 0) throw IOException(mrVersionHint(projectId, mcVer, loaderLc))
        val picked = pickVersion(vers, fileRef)
        val file = pickFile(picked) ?: throw IOException("版本下没有可用 jar 文件")
        val name = file.optString("filename")
        val dest = File(dir, name)
        dupCheck(dest)?.let { throw IOException(it) }

        setStatus("下载 MOD: $name")
        progress("mod-dl", 10, "下载 MOD $name")
        api.mrDownload(file.optString("url"), dest) { pct, _, _ ->
            progress("mod-dl", pct.coerceAtLeast(10), "下载 MOD $name" + if (pct >= 0) " $pct%" else "")
        }
        // SHA1 校验（Modrinth 会给出 files[].hashes.sha1）
        val sha1 = file.optJSONObject("hashes")?.optString("sha1").orEmpty()
        if (sha1.isNotEmpty() && !Net.sha1File(dest).equals(sha1, true)) {
            dest.delete()
            throw IOException("文件校验失败，请重试")
        }
        setStatus("就绪")
        toast("MOD 已安装到「${instance.ifEmpty { "全局 mods" }}」: $name")
        JSONObject().put("ok", true).put("file", name)
    } catch (e: Exception) {
        setStatus("就绪")
        err(e.message ?: "安装失败")
    }
    }

    private fun mrVersionHint(projectId: String, mcVer: String, loaderLc: String): String {
        val hint = try {            val all = api.mrAllVersions(projectId)
            val gv = LinkedHashSet<String>()
            for (i in 0 until all.length()) {
                val arr = all.optJSONObject(i)?.optJSONArray("game_versions") ?: continue
                for (k in 0 until arr.length()) {
                    val g = arr.optString(k)
                    if (Regex("^\\d+\\.\\d+(\\.\\d+)?$").matches(g)) gv.add(g)
                }
                if (gv.size >= 8) break
            }
            if (gv.isEmpty()) "" else " · 它最新支持: " + gv.sortedDescending().take(5).joinToString(" / ")
        } catch (e: Exception) { "" }
        return "该 MOD 无适配 $mcVer ($loaderLc) 的构建$hint —— 请换用匹配版本的实例，或等待 MOD 更新"
    }

    private fun cfVersionHint(modId: String, mcVer: String, loaderLc: String): String {
        val hint = try {
            val all = api.cfFiles(modId, "", "")
            val gv = LinkedHashSet<String>()
            for (i in 0 until all.length()) {
                val arr = all.optJSONObject(i)?.optJSONArray("gameVersions") ?: continue
                for (k in 0 until arr.length()) {
                    val g = arr.optString(k)
                    if (Regex("^\\d+\\.\\d+(\\.\\d+)?$").matches(g)) gv.add(g)
                }
            }
            if (gv.isEmpty()) "" else " · 它最新支持: " + gv.sortedDescending().take(5).joinToString(" / ")
        } catch (e: Exception) { "" }
        return "该 MOD 无适配 $mcVer ($loaderLc) 的构建$hint —— 请换用匹配版本的实例，或等待 MOD 更新"
    }

    /* ==================================================================
     * 安装资源包 / 数据包
     * ================================================================== */

    fun installPack(p: JSONObject): JSONObject = try {
        val type = if (p.optString("type") == "datapack") "datapack" else "resourcepack"
        val typeName = if (type == "datapack") "数据包" else "资源包"
        val projectId = p.optString("projectId")
        if (projectId.isEmpty()) throw IOException("缺少项目 ID")
        val gd = gameDir()

        // 挑出要下载的文件
        val fileUrl: String
        val fileName: String
        val fileSha1: String
        if (projectId.startsWith("cf")) {
            val modId = projectId.removePrefix("cf")
            val j = api.cfFiles(modId, "", "")
            if (j.length() == 0) throw IOException("该$typeName 没有可用版本")
            val list = (0 until j.length()).mapNotNull { j.optJSONObject(it) }
                .sortedByDescending { it.optString("fileDate") }
            val f = list[0]
            fileUrl = f.optString("downloadUrl")
            fileName = f.optString("fileName")
            fileSha1 = ""
        } else {
            val vers = api.mrAllVersions(projectId)
            if (vers.length() == 0) throw IOException("该$typeName 没有可用版本")
            val v0 = vers.optJSONObject(0) ?: throw IOException("该$typeName 没有可用版本")
            val files = v0.optJSONArray("files") ?: JSONArray()
            var f: JSONObject? = null
            for (i in 0 until files.length()) {
                val x = files.optJSONObject(i) ?: continue
                if (x.optBoolean("primary")) { f = x; break }
            }
            if (f == null && files.length() > 0) f = files.optJSONObject(0)
            if (f == null) throw IOException("没有可下载的文件")
            fileUrl = f.optString("url")
            fileName = f.optString("filename").ifEmpty { fileUrl.substringAfterLast('/') }
            fileSha1 = f.optJSONObject("hashes")?.optString("sha1").orEmpty()
        }
        if (fileName.isEmpty()) throw IOException("没有可下载的文件")

        val dest: File
        if (type == "resourcepack") {
            dest = File(gd, "resourcepacks/$fileName")
        } else {
            // world 可能带实例前缀（版本隔离存档）："实例名|世界名"；全局存档为纯世界名
            val raw = p.optString("world")
            val sep = raw.indexOf('|')
            val inst = if (sep > -1) raw.substring(0, sep) else ""
            val wName = if (sep > -1) raw.substring(sep + 1) else raw
            if (wName.isEmpty() || wName.contains("..") || wName.contains(Regex("[/\\\\:*?\"<>|]"))) {
                throw IOException("请先选择一个有效的存档（世界）")
            }
            var sBase = File(gd, "saves")
            if (inst.isNotEmpty()) {
                val iDir = modsManager.safeInstanceDir(inst) ?: throw IOException("实例名无效: $inst")
                val iSaves = File(iDir, "saves")
                if (iSaves.isDirectory) sBase = iSaves
            }
            val wDir = File(sBase, wName)
            if (!wDir.isDirectory) throw IOException("存档不存在: $wName")
            dest = File(wDir, "datapacks/$fileName")
        }
        dest.parentFile?.mkdirs()

        setStatus("下载$typeName: ${dest.name}")
        progress("pack-dl", 10, "下载$typeName ${dest.name}")
        val onProgress: (Int, Long, Long) -> Unit = { pct, _, _ ->
            progress("pack-dl", pct.coerceAtLeast(10), "下载$typeName ${dest.name}" + if (pct >= 0) " $pct%" else "")
        }
        if (fileUrl.contains("modrinth.com") || fileUrl.contains("mcimirror.top")) {
            api.mrDownload(fileUrl, dest, onProgress)
        } else {
            Net.download(fileUrl, dest, fileSha1.ifEmpty { null }, 60000, onProgress)
        }
        setStatus("就绪")
        toast(
            if (type == "datapack") "数据包已装入「${p.optString("world")}」：${dest.name}（进入世界后自动生效）"
            else "$typeName 已安装: ${dest.name}"
        )
        JSONObject().put("ok", true).put("file", dest.name)
    } catch (e: Exception) {
        setStatus("就绪")
        err(e.message ?: "安装失败")
    }

    /* ==================================================================
     * 安装整合包（.mrpack）
     * ================================================================== */

    fun installModpack(p: JSONObject): JSONObject = try {
        val projectId = p.optString("projectId")
        if (projectId.isEmpty()) throw IOException("缺少项目 ID")
        val vers = api.mrAllVersions(projectId)
        if (vers.length() == 0) throw IOException("该整合包没有可用版本")
        val v0 = vers.optJSONObject(0) ?: throw IOException("该整合包没有可用版本")
        val files = v0.optJSONArray("files") ?: JSONArray()
        var f: JSONObject? = null
        for (i in 0 until files.length()) {
            val x = files.optJSONObject(i) ?: continue
            if (x.optBoolean("primary") && x.optString("filename").endsWith(".mrpack", true)) { f = x; break }
        }
        if (f == null) for (i in 0 until files.length()) {
            val x = files.optJSONObject(i) ?: continue
            if (x.optString("filename").endsWith(".mrpack", true)) { f = x; break }
        }
        if (f == null) throw IOException("未找到 .mrpack 主文件")

        val tmp = File(gameDir(), ".tmp-xlc-pack.mrpack")
        setStatus("下载整合包: ${f.optString("filename")}")
        progress("modpack-dl", 3, "下载整合包")
        api.mrDownload(f.optString("url"), tmp) { pct, _, _ ->
            progress("modpack-dl", (pct * 20 / 100).coerceAtLeast(3), "下载整合包" + if (pct >= 0) " $pct%" else "")
        }

        val indexTxt = readZipEntry(tmp, "modrinth.index.json")
            ?: throw IOException("整合包格式异常（缺少 modrinth.index.json）")
        val index = JSONObject(indexTxt)
        val deps = index.optJSONObject("dependencies") ?: JSONObject()
        val mcVer = deps.optString("minecraft").ifEmpty { deps.optString("minecraft") }
        if (mcVer.isEmpty()) throw IOException("整合包未声明 Minecraft 版本")
        val loader = when {
            deps.has("fabric-loader") -> "fabric"
            deps.has("quilt-loader") -> "quilt"
            deps.has("forge") -> "forge"
            deps.has("neoforge") -> "neoforge"
            else -> "vanilla"
        }
        val displayName = p.optString("name").ifEmpty { v0.optString("name") }.ifEmpty { projectId }
        val name = installer.sanitizeId(displayName).ifEmpty { "modpack-$mcVer" }

        progress("modpack-mc", 20, "安装 Minecraft $mcVer ($loader)")
        setStatus("安装整合包基础: $mcVer / $loader")
        val versionId = installer.installVersionSync(mcVer, loader, name, "")

        // mod 文件（path 相对 gameDir，禁止越界）
        val gd = gameDir()
        val fl = index.optJSONArray("files") ?: JSONArray()
        val total = fl.length()
        progress("modpack-files", 82, "整合包文件 0/$total", 0, total)
        var i = 0
        var doneCount = 0
        for (k in 0 until total) {
            val item = fl.optJSONObject(k) ?: continue
            i++
            val rel = item.optString("path")
            if (rel.isEmpty() || rel.contains("..") || File(rel).isAbsolute) continue
            val downloads = item.optJSONArray("downloads") ?: JSONArray()
            if (downloads.length() == 0) continue
            val url = downloads.optString(0)
            if (url.isEmpty()) continue
            if (i % 3 == 0 || i == total) {
                progress("modpack-files", 82 + i * 15 / maxOf(1, total), "整合包文件 $i/$total", i, total)
            }
            val dest = File(gd, rel)
            if (dest.isFile) { doneCount++; continue }   // 已存在则跳过（重复安装省流量）
            try {
                api.mrDownload(url, dest)
                doneCount++
            } catch (e: Exception) {
                Log.w(TAG, "整合包文件下载失败 $rel: ${e.message}")
            }
        }

        // overrides → 覆盖到 gameDir（已存在的不覆盖，避免冲掉用户设置）
        var copied = 0
        try {
            ZipInputStream(tmp.inputStream().buffered()).use { zin ->
                var e = zin.nextEntry
                while (e != null) {
                    val n = e.name
                    if (!e.isDirectory && n.startsWith("overrides/")) {
                        val rel = n.removePrefix("overrides/")
                        if (rel.isNotEmpty() && !rel.contains("..")) {
                            val dest = File(gd, rel)
                            if (!dest.isFile) {
                                dest.parentFile?.mkdirs()
                                dest.outputStream().use { zin.copyTo(it) }
                                copied++
                            }
                        }
                    }
                    zin.closeEntry()
                    e = zin.nextEntry
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "overrides 应用失败: ${e.message}")
        }
        tmp.delete()

        progress("done", 100, "安装完成")
        setStatus("就绪")
        toast("整合包安装完成: $versionId（$doneCount 个文件，overrides $copied 个）")
        JSONObject().put("ok", true).put("versionId", versionId)
    } catch (e: Exception) {
        setStatus("就绪")
        err(e.message ?: "整合包安装失败")
    }

    /* ==================================================================
     * 自定义文件下载（光影包 / 任意直链）
     * ================================================================== */

    fun customDownload(p: JSONObject): JSONObject = try {
        val url = p.optString("url").trim()
        if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(url)) throw IOException("请输入有效的 http(s) 下载地址")
        var fileName = ""
        try { fileName = java.net.URL(url).path.substringAfterLast('/') } catch (e: Exception) {}
        fileName = fileName.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim()
        if (fileName.isEmpty() || fileName == "_") fileName = "download-${System.currentTimeMillis()}.bin"
        if (!Regex("\\.[A-Za-z0-9]{1,8}$").containsMatchIn(fileName)) fileName += ".jar"

        val gd = gameDir()
        val target = p.optString("target")
        val base = when (target) {
            "mods" -> modsManager.modsDirFor(p.optString("instance"))
            "resourcepacks" -> File(gd, "resourcepacks")
            else -> File(gd, "shaderpacks")
        }
        val dest = File(base, fileName)
        if (dest.exists()) throw IOException("文件已存在: ${dest.absolutePath}")

        setStatus("下载文件: $fileName")
        progress("custom-dl", 0, "下载文件 $fileName")
        Net.download(url, dest, null, 60000) { pct, got, total ->
            val txt = "下载文件 $fileName " + if (pct >= 0) "$pct%" else mb(got) + (if (total > 0) " / ${mb(total)}" else "")
            setStatus(txt)
            progress("custom-dl", if (pct >= 0) pct else 50, txt)
        }
        setStatus("就绪")
        toast("文件已下载到: ${dest.absolutePath}")
        JSONObject().put("ok", true).put("path", dest.absolutePath)
    } catch (e: Exception) {
        setStatus("就绪")
        err(e.message ?: "下载失败")
    }

    private fun mb(n: Long): String = String.format(java.util.Locale.US, "%.1f MB", n / 1048576.0)

    /* ==================================================================
     * 工具
     * ================================================================== */

    private fun err(msg: String) = JSONObject().put("ok", false).put("error", msg)

    private fun toast(msg: String, type: String = "info") {
        emit("app:toast", JSONObject().put("msg", msg).put("type", type))
    }

    private fun progress(stage: String, percent: Int, text: String, current: Int? = null, total: Int? = null) {
        val o = JSONObject().put("stage", stage).put("percent", percent).put("text", text)
        if (current != null) o.put("current", current)
        if (total != null) o.put("total", total)
        emit("install:progress", o)
    }

    /** 重复安装拦截：目标 jar 或其 .disabled 变体已存在时不覆盖（覆盖会丢用户禁用状态） */
    private fun dupCheck(dest: File): String? {
        if (dest.isFile) return "该 MOD 已安装（${dest.name}），如需更新版本请先到「MOD 管理」页删除旧文件"
        if (File(dest.absolutePath + ".disabled").isFile) {
            return "该 MOD 已安装但当前处于禁用状态（${dest.name}.disabled），如需更新请先到「MOD 管理」页删除旧文件"
        }
        return null
    }

    private fun pickVersion(vers: JSONArray, fileRef: String): JSONObject {
        if (fileRef.isNotEmpty()) {
            for (i in 0 until vers.length()) {
                val v = vers.optJSONObject(i) ?: continue
                if (v.optString("id") == fileRef) return v
            }
        }
        return vers.optJSONObject(0)!!
    }

    private fun pickFile(version: JSONObject): JSONObject? {
        val files = version.optJSONArray("files") ?: return null
        for (i in 0 until files.length()) {
            val x = files.optJSONObject(i) ?: continue
            if (x.optBoolean("primary")) return x
        }
        return files.optJSONObject(0)
    }

    private fun readZipEntry(zip: File, name: String): String? {
        ZipInputStream(zip.inputStream().buffered()).use { zin ->
            var e = zin.nextEntry
            while (e != null) {
                if (!e.isDirectory && e.name.equals(name, true)) {
                    return String(zin.readBytes(), Charsets.UTF_8)
                }
                zin.closeEntry()
                e = zin.nextEntry
            }
        }
        return null
    }

    companion object {
        private const val TAG = "XLC-ModInstall"
    }
}
