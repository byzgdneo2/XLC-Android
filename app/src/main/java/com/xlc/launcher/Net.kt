package com.xlc.launcher

import android.os.Build
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest

/**
 * 安卓端网络层：把桌面端 main.js 里散落的 fetch / downloadBig / mrUrls / fetchIconData
 * 这几件事收敛成一套可复用的原语。
 *
 * 设计要点（与桌面端逐条对齐）：
 *   1. 全部请求带超时 —— 安卓上没有 AbortSignal，超时靠 connectTimeout/readTimeout；
 *      "超时 ≠ 失败"，调用方拿到 IOException 后可以换镜像重试。
 *   2. 下载是流式的，边下边回调进度，杜绝把几十 MB 的 jar 一次性读进内存（安卓堆很小）。
 *   3. SHA1 校验：文件已存在且校验通过直接跳过，避免重复下载。
 *   4. 多源回退：candidates 按顺序尝试，第一个成功即返回（官方源超时 → 自动切国内镜像）。
 */
object Net {

    const val UA: String = "XLC-Launcher/${BuildConfig.VERSION_NAME} (Android; +https://github.com/lmc-launcher)"

    /** 单次请求的连接/读取超时（毫秒） */
    private const val CONNECT_TIMEOUT = 15000
    private const val READ_TIMEOUT = 60000

    /* ==================================================================
     * GET / HEAD
     * ================================================================== */

    @Throws(IOException::class)
    fun get(url: String, timeoutMs: Int = READ_TIMEOUT, extraHeaders: Map<String, String>? = null): ByteArray {
        var target = url
        var hops = 0
        while (true) {
            val conn = open(target, "GET", timeoutMs, extraHeaders)
            try {
                val code = conn.responseCode
                if (code in 300..399) {
                    val loc = conn.getHeaderField("Location")
                    if (loc.isNullOrEmpty()) throw IOException("HTTP $code 未提供 Location")
                    if (++hops > 8) throw IOException("重定向次数过多: $url")
                    target = URL(URL(target), loc).toString()
                    continue
                }
                if (code != 200) throw IOException("HTTP $code")
                return conn.inputStream.use { it.readBytes() }
            } finally {
                conn.disconnect()
            }
        }
    }

    fun getText(url: String, timeoutMs: Int = READ_TIMEOUT, extraHeaders: Map<String, String>? = null): String =
        String(get(url, timeoutMs, extraHeaders), Charsets.UTF_8)

    @Throws(Exception::class)
    fun getJson(url: String, timeoutMs: Int = READ_TIMEOUT, extraHeaders: Map<String, String>? = null): JSONObject =
        JSONObject(getText(url, timeoutMs, extraHeaders))

    @Throws(Exception::class)
    fun getJsonArray(url: String, timeoutMs: Int = READ_TIMEOUT, extraHeaders: Map<String, String>? = null): JSONArray =
        JSONArray(getText(url, timeoutMs, extraHeaders))

    fun postJson(url: String, body: String, timeoutMs: Int = READ_TIMEOUT): String {
        val conn = open(url, "POST", timeoutMs, mapOf("Content-Type" to "application/json"))
        return conn.use2 {
            it.doOutput = true
            it.outputStream.use { os -> os.write(body.toByteArray(Charsets.UTF_8)) }
            val code = it.responseCode
            if (code !in 200..299) throw IOException("HTTP $code")
            it.inputStream.use { ins -> String(ins.readBytes(), Charsets.UTF_8) }
        }
    }

    fun head(url: String, timeoutMs: Int = CONNECT_TIMEOUT): Int {
        var target = url
        var hops = 0
        while (true) {
            val conn = open(target, "HEAD", timeoutMs, null)
            try {
                val code = conn.responseCode
                if (code in 300..399) {
                    val loc = conn.getHeaderField("Location")
                    if (loc.isNullOrEmpty() || ++hops > 8) return code
                    target = URL(URL(target), loc).toString()
                    continue
                }
                return code
            } finally {
                conn.disconnect()
            }
        }
    }

    private fun open(url: String, method: String, timeoutMs: Int, headers: Map<String, String>?): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = CONNECT_TIMEOUT
            readTimeout = timeoutMs
            instanceFollowRedirects = false
            setRequestProperty("User-Agent", UA)
            setRequestProperty("Accept", "*/*")
            headers?.forEach { (k, v) -> setRequestProperty(k, v) }
        }

    private inline fun <T> HttpURLConnection.use2(block: (HttpURLConnection) -> T): T =
        try { block(this) } finally { disconnect() }

    /* ==================================================================
     * 多源回退
     * ================================================================== */

    /**
     * 按顺序尝试多个地址，第一个成功的返回。
     * 对应桌面端 mrUrls()（官方优先，超时后自动切镜像）。
     * 失败原因会聚合成一条消息，方便界面直接显示。
     */
    @Throws(IOException::class)
    fun fromSources(sources: List<Pair<String, Int>>, extraHeaders: Map<String, String>? = null): ByteArray {
        val errs = mutableListOf<String>()
        for ((url, ms) in sources) {
            try {
                return get(url, ms, extraHeaders)
            } catch (e: Exception) {
                errs.add("${hostOf(url)}: ${e.message}")
            }
        }
        throw IOException("所有源均不可用（${errs.joinToString("；")}）")
    }

    fun fromSourcesJson(sources: List<Pair<String, Int>>, extraHeaders: Map<String, String>? = null): JSONObject =
        JSONObject(String(fromSources(sources, extraHeaders), Charsets.UTF_8))

    private fun hostOf(url: String): String = try { URL(url).host } catch (e: Exception) { url.take(40) }

    /* ==================================================================
     * 流式下载（带进度）
     * ================================================================== */

    /**
     * 下载到 dest。expectSha1 非空时做校验；失败抛 IOException（不落盘半截文件）。
     * onProgress(percent, gotBytes, totalBytes) —— percent 在拿不到 Content-Length 时为 -1。
     */
    @Throws(IOException::class)
    fun download(
        url: String,
        dest: File,
        expectSha1: String? = null,
        timeoutMs: Int = READ_TIMEOUT,
        onProgress: ((Int, Long, Long) -> Unit)? = null
    ) {
        // 已存在且校验通过 → 直接跳过（重复安装时省掉全部流量）
        if (dest.isFile && !expectSha1.isNullOrEmpty() && sha1File(dest).equals(expectSha1, true)) return

        dest.parentFile?.mkdirs()
        val tmp = File(dest.parentFile, dest.name + ".part")
        var target = url
        var hops = 0

        try {
            while (true) {
                val conn = open(target, "GET", timeoutMs, null)
                var ok = false
                try {
                    val code = conn.responseCode
                    if (code in 300..399) {
                        val loc = conn.getHeaderField("Location")
                        if (loc.isNullOrEmpty()) throw IOException("HTTP $code 未提供 Location")
                        if (++hops > 8) throw IOException("重定向次数过多")
                        target = URL(URL(target), loc).toString()
                        continue
                    }
                    if (code != 200) throw IOException("HTTP $code")
                    val total = conn.contentLengthLong
                    var got = 0L
                    var lastPct = -1
                    conn.inputStream.use { ins ->
                        tmp.outputStream().buffered(65536).use { out ->
                            val buf = ByteArray(65536)
                            while (true) {
                                val n = ins.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                got += n
                                if (onProgress != null) {
                                    val pct = if (total > 0) ((got * 100) / total).toInt() else -1
                                    // 限流：百分比变化才回调，避免每 64KB 刷一次界面
                                    if (pct != lastPct) {
                                        lastPct = pct
                                        onProgress(pct, got, if (total > 0) total else 0L)
                                    }
                                }
                            }
                        }
                    }
                    ok = true
                } finally {
                    conn.disconnect()
                }
                if (ok) break
            }

            if (!expectSha1.isNullOrEmpty() && !sha1File(tmp).equals(expectSha1, true)) {
                tmp.delete()
                throw IOException("SHA1 校验失败")
            }
            if (dest.isFile) dest.delete()
            if (!tmp.renameTo(dest)) {
                tmp.copyTo(dest, overwrite = true)
                tmp.delete()
            }
        } catch (e: Throwable) {
            tmp.delete()
            throw if (e is IOException) e else IOException(e.message ?: "下载失败")
        }
    }

    /** 多源下载：逐个源尝试，成功即止 */
    fun downloadFrom(sources: List<Pair<String, Int>>, dest: File, onProgress: ((Int, Long, Long) -> Unit)? = null) {
        val errs = mutableListOf<String>()
        for ((url, ms) in sources) {
            try {
                download(url, dest, null, ms, onProgress)
                return
            } catch (e: Exception) {
                errs.add("${hostOf(url)}: ${e.message}")
            }
        }
        throw IOException("所有源下载失败（${errs.joinToString("；")}）")
    }

    /* ==================================================================
     * 图标 → data URI（桌面端 bufToDataUri / fetchIconData 的安卓版）
     * ================================================================== */

    /** 按魔数猜 MIME，返回 data:image/xxx;base64,... ；超限返回空串 */
    fun dataUri(bytes: ByteArray, maxBytes: Int = 4 * 1024 * 1024): String {
        if (bytes.isEmpty() || bytes.size > maxBytes) return ""
        val mime = when {
            bytes.size > 8 && bytes[0] == 0x89.toByte() && bytes[1] == 'P'.code.toByte() -> "image/png"
            bytes.size > 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() -> "image/jpeg"
            bytes.size > 4 && String(bytes, 0, 3) == "GIF" -> "image/gif"
            bytes.size > 12 && String(bytes, 0, 4) == "RIFF" && String(bytes, 8, 4) == "WEBP" -> "image/webp"
            else -> "image/png"
        }
        return "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    /**
     * 拉取图标并转 data URI，带磁盘缓存（缓存目录按项目 id 命名，与桌面端一致）。
     * 失败返回空串 —— 界面会退回 SVG 占位符，不阻塞列表渲染。
     */
    fun fetchIconData(uri: String, cacheKey: String, cacheDir: File, maxBytes: Int = 4 * 1024 * 1024): String {
        if (uri.isEmpty()) return ""
        val cf = File(cacheDir, safeName(cacheKey))
        if (cf.isFile) {
            try { return dataUri(cf.readBytes(), maxBytes) } catch (e: Throwable) { /* 缓存损坏，重新拉 */ }
        }
        val sources = cdnSources(uri)
        for ((u, ms) in sources) {
            try {
                val buf = get(u, ms)
                val du = dataUri(buf, maxBytes)
                if (du.isEmpty()) continue
                try { cacheDir.mkdirs(); cf.writeBytes(buf) } catch (e: Throwable) { /* 缓存写失败不影响 */ }
                return du
            } catch (e: Throwable) { /* 换下一个源 */ }
        }
        return ""
    }

    /** cdn.modrinth.com → MCIM 镜像（对应桌面端 mrBinUrls） */
    private fun cdnSources(url: String): List<Pair<String, Int>> {
        val mirror = try {
            val u = URL(url)
            if (u.host == "cdn.modrinth.com") ModrinthApi.MIRROR + u.path else null
        } catch (e: Throwable) { null }
        return if (mirror == null) listOf(url to 15000)
        else if (ModrinthApi.preferMirror) listOf(mirror to 20000, url to 15000)
        else listOf(url to 15000, mirror to 20000)
    }

    private fun safeName(s: String): String = s.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80)

    /* ==================================================================
     * WebView 里渲染 HTML 用的转义（MOD 简介来自远端，必须消毒）
     * ================================================================== */

    /** 与桌面端 sanitizeHtml 同思路：剥掉可执行/可外链标签与事件属性 */
    fun sanitizeHtml(html: String): String = html
        .replace(Regex("<(script|style|iframe|object|embed|link|meta)\\b[\\s\\S]*?</\\1\\s*>", RegexOption.IGNORE_CASE), "")
        .replace(Regex("<(script|style|iframe|object|embed|link|meta)\\b[^>]*/?>", RegexOption.IGNORE_CASE), "")
        .replace(Regex("\\son[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", RegexOption.IGNORE_CASE), "")

    /* ==================================================================
     * 哈希 / 编码
     * ================================================================== */

    fun sha1(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-1").digest(bytes).joinToString("") { "%02x".format(it) }

    fun sha1File(f: File): String =
        f.inputStream().use { ins ->
            val md = MessageDigest.getInstance("SHA-1")
            val buf = ByteArray(65536)
            while (true) {
                val n = ins.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
            md.digest().joinToString("") { "%02x".format(it) }
        }

    fun enc(s: String): String = try { URLEncoder.encode(s, "UTF-8") } catch (e: Exception) { s }

    /** 转义单引号，供 evaluateJavascript 里包 JSON 字符串用 */
    fun jsQuote(s: String): String = JSONObject.quote(s)

    /** 读 zip 内某个条目的字节（用于读 jar 里的元数据 / 图标） */
    fun zipEntry(file: File, entry: String): ByteArray? = try {
        java.util.zip.ZipFile(file).use { zf ->
            val e = zf.getEntry(entry) ?: return null
            zf.getInputStream(e).use { it.readBytes() }
        }
    } catch (e: Throwable) { null }

    fun log(tag: String, msg: String) = Log.i(tag, msg)

    /* ==================================================================
     * 带状态码的请求（微软 / Xbox / authlib 认证链路专用）
     *
     * 认证接口的报错信息都在**非 2xx 响应体**里（XErr / error_description /
     * errorMessage），普通 get/postJson 一遇 4xx 就只抛 "HTTP 403"，
     * 用户完全不知道哪里出了问题 —— 这一组保留原始 status + body。
     * ================================================================== */

    /** 原始响应：状态码 + 响应体（错误响应也能拿到） */
    class NetResp(val status: Int, val body: String) {
        /** 2xx 才算成功 */
        val ok: Boolean get() = status in 200..299

        /** 尽力解析 JSON；解析失败返回空对象 */
        fun json(): JSONObject = try { JSONObject(body) } catch (e: Throwable) { JSONObject() }
    }

    /** POST 表单（application/x-www-form-urlencoded）—— OAuth 令牌端点 */
    fun postFormResp(url: String, fields: Map<String, String>, timeoutMs: Int = 20000): NetResp {
        val form = fields.entries.joinToString("&") {
            enc(it.key) + "=" + enc(it.value ?: "")
        }
        return postRawResp(url, form, "application/x-www-form-urlencoded", timeoutMs, null)
    }

    /** POST JSON，非 2xx 也不抛（认证链路要读错误响应体） */
    fun postJsonResp(
        url: String,
        body: String,
        timeoutMs: Int = 20000,
        extraHeaders: Map<String, String>? = null
    ): NetResp = postRawResp(url, body, "application/json", timeoutMs, extraHeaders)

    /** GET，非 2xx 也不抛；跟随重定向（登录链路常被 302） */
    fun getResp(url: String, extraHeaders: Map<String, String>? = null, timeoutMs: Int = 20000): NetResp {
        var target = url
        var hops = 0
        while (true) {
            val conn = open(target, "GET", timeoutMs, extraHeaders)
            try {
                val code = conn.responseCode
                if (code in 300..399) {
                    val loc = conn.getHeaderField("Location")
                    if (loc.isNullOrEmpty() || ++hops > 8) return NetResp(code, "")
                    target = URL(URL(target), loc).toString()
                    continue
                }
                return NetResp(code, readBody(conn))
            } catch (e: IOException) {
                // 连不上 / 超时：返回 0 + 原始消息，让调用方生成人话错误
                return NetResp(0, e.message ?: "连接失败")
            } finally {
                conn.disconnect()
            }
        }
    }

    private fun postRawResp(
        url: String,
        body: String,
        contentType: String,
        timeoutMs: Int,
        extraHeaders: Map<String, String>?
    ): NetResp {
        val conn = open(url, "POST", timeoutMs, extraHeaders)
        try {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", contentType)
            conn.setRequestProperty("Accept", "application/json")
            conn.outputStream.use { os -> os.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            return NetResp(code, readBody(conn))
        } catch (e: IOException) {
            return NetResp(0, e.message ?: "连接失败")
        } finally {
            conn.disconnect()
        }
    }

    private fun readBody(conn: HttpURLConnection): String {
        val ins = try { conn.inputStream } catch (e: Throwable) { conn.errorStream ?: return "" }
        return try { ins.use { String(it.readBytes(), Charsets.UTF_8) } } catch (e: Throwable) { "" }
    }
}
