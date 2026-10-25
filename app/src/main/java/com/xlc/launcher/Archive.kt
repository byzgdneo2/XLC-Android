package com.xlc.launcher

import android.util.Log
import org.tukaani.xz.XZInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

/**
 * 归档解压：.tar.xz / .tar.gz / .zip
 *
 * 为什么需要自己写：
 *   Android 只自带 tar + gzip（toybox），**没有 xz**，而安卓版 JRE 都是以 .tar.xz 发布的。
 *   所以 xz 解压走 org.tukaani:xz（纯 Java），tar 解析自己实现 —— tar 格式很简单
 *   （512 字节头 + 数据块），没必要为此再引一个 Apache Commons Compress。
 *
 * 安全：解压前对每个条目做路径校验，杜绝 ".." 目录穿越与绝对路径写入。
 */
object Archive {

    private const val TAG = "XLC-Archive"

    /** 解压 .tar.xz 到 destDir，返回写出的文件数 */
    fun extractTarXz(archive: File, destDir: File, onProgress: ((Int) -> Unit)? = null): Int {
        val counting = CountingInput(archive.inputStream().buffered(65536), archive.length(), onProgress)
        var files = 0
        XZInputStream(counting).use { xz ->
            files = readTar(xz, destDir)
        }
        return files
    }

    /** 解压 .tar.gz（设备自带 gzip 能处理，但走同一套 tar 解析更省事） */
    fun extractTarGz(archive: File, destDir: File, onProgress: ((Int) -> Unit)? = null): Int {
        val counting = CountingInput(archive.inputStream().buffered(65536), archive.length(), onProgress)
        var files = 0
        java.util.zip.GZIPInputStream(counting).use { gz ->
            files = readTar(gz, destDir)
        }
        return files
    }

    /** 解压普通 zip（资源包 / mrpack 等） */
    fun extractZip(archive: File, destDir: File): Int {
        var n = 0
        java.util.zip.ZipInputStream(archive.inputStream().buffered(65536)).use { zin ->
            while (true) {
                val e = zin.nextEntry ?: break
                val clean = safeRel(e.name) ?: continue
                val out = File(destDir, clean)
                if (e.isDirectory) {
                    out.mkdirs()
                } else {
                    out.parentFile?.mkdirs()
                    FileOutputStream(out).use { fo -> zin.copyTo(fo, 65536) }
                    n++
                }
            }
        }
        return n
    }

    /* ==================================================================
     * 带进度的流包装：按「已读压缩字节 / 文件总长度」估算百分比
     * ================================================================== */
    private class CountingInput(
        private val inner: InputStream,
        private val total: Long,
        private val onProgress: ((Int) -> Unit)?
    ) : InputStream() {
        private var read = 0L
        private var lastPct = -1

        private fun tick() {
            val cb = onProgress ?: return
            if (total <= 0) return
            val pct = ((read * 100) / total).toInt().coerceIn(0, 100)
            if (pct != lastPct) {
                lastPct = pct
                cb(pct)
            }
        }

        override fun read(): Int {
            val b = inner.read()
            if (b >= 0) { read++; tick() }
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = inner.read(b, off, len)
            if (n > 0) { read += n; tick() }
            return n
        }

        override fun available(): Int = inner.available()
        override fun close() = inner.close()
    }

    /* ==================================================================
     * tar 解析
     * ================================================================== */

    private fun readTar(input: InputStream, destDir: File): Int {
        destDir.mkdirs()
        val header = ByteArray(512)
        val links = mutableListOf<Triple<File, String, Char>>()   // 链接延后处理
        var longName: String? = null
        var count = 0

        while (true) {
            if (!readFully(input, header, 512)) break
            if (header.all { it == 0.toByte() }) break           // 两个全零块 = 归档结束

            var name = readStr(header, 0, 100)
            val mode = readOctal(header, 100, 8)
            val size = readOctal(header, 124, 12)
            val type = header[156].toInt().toChar()
            val linkName = readStr(header, 157, 100)
            val prefix = readStr(header, 345, 155)

            // GNU 长文件名：本条内容就是下一条的真实名字
            if (type == 'L') {
                val buf = ByteArray(size.toInt().coerceAtLeast(0))
                readFully(input, buf, buf.size)
                longName = String(buf, Charsets.UTF_8).trimEnd('\u0000', '\n', '\r')
                skipPadding(input, size)
                continue
            }
            if (longName != null) {
                name = longName
                longName = null
            } else if (prefix.isNotEmpty()) {
                name = "$prefix/$name"
            }

            val clean = safeRel(name)
            if (clean == null) {                                  // 非法路径：只跳过数据，不落盘
                skipExact(input, size)
                continue
            }
            val target = File(destDir, clean)

            when (type) {
                '5' -> {                                          // 目录
                    target.mkdirs()
                    skipExact(input, size)
                }
                '2', '1' -> {                                     // 符号链接 / 硬链接
                    links.add(Triple(target, linkName, type))
                    skipExact(input, size)
                }
                '0', '\u0000', '7' -> {                           // 普通文件
                    target.parentFile?.mkdirs()
                    FileOutputStream(target).use { out -> copyExact(input, out, size) }
                    skipPadding(input, size)
                    target.setReadable(true, false)
                    if ((mode and 0b001_000_000L) != 0L) target.setExecutable(true, false)
                    count++
                }
                else -> skipExact(input, size)                    // 'x'/'g' pax 头等一律跳过
            }
        }

        resolveLinks(links)
        return count
    }

    /** 建链接；不支持符号链接的环境（API 24/25）退化为复制目标内容 */
    private fun resolveLinks(links: List<Triple<File, String, Char>>) {
        for ((link, target, type) in links) {
            link.parentFile?.mkdirs()
            if (link.exists()) continue
            val src = if (target.startsWith("/")) File(target) else File(link.parentFile, target)
            if (type == '2') {
                if (shellLn(target, link)) continue
            }
            try {
                if (src.isFile) src.copyTo(link, overwrite = true)
                else if (src.isDirectory) src.mkdirs()
            } catch (e: Throwable) {
                Log.w(TAG, "链接处理失败 ${link.name}: ${e.message}")
            }
        }
    }

    private fun shellLn(target: String, link: File): Boolean = try {
        val p = ProcessBuilder("/system/bin/ln", "-sf", target, link.absolutePath)
            .redirectErrorStream(true).start()
        p.waitFor()
        // 注意：不用 java.nio.file（API 26+ 才有），靠 ln 的退出码判断即可
        p.exitValue() == 0 && link.exists()
    } catch (e: Throwable) {
        false
    }

    /* ==================================================================
     * 基础读取工具
     * ================================================================== */

    /** 归一化相对路径；含 ".." 或落到根目录外时返回 null（拒绝写入） */
    private fun safeRel(name: String): String? {
        var n = name.replace('\\', '/').trim()
        while (n.startsWith("./")) n = n.substring(2)
        n = n.trimStart('/')
        if (n.isEmpty()) return null
        val parts = n.split('/').filter { it.isNotEmpty() && it != "." }
        if (parts.any { it == ".." }) return null
        return parts.joinToString("/")
    }

    private fun readStr(b: ByteArray, off: Int, len: Int): String {
        var end = off
        val max = (off + len).coerceAtMost(b.size)
        while (end < max && b[end] != 0.toByte()) end++
        return String(b, off, end - off, Charsets.UTF_8).trim()
    }

    private fun readOctal(b: ByteArray, off: Int, len: Int): Long {
        val s = readStr(b, off, len).trim().trimEnd('\u0000')
        if (s.isEmpty()) return 0
        return try {
            // 兼容 GNU base-256 编码（高位为 1 时是二进制大数，JRE 包里不会出现，但兜一下）
            if (s[0].code and 0x80 != 0) {
                var v = 0L
                for (i in s.indices) v = (v shl 8) or (s[i].code and 0xFF).toLong()
                v
            } else s.toLong(8)
        } catch (e: Throwable) { 0L }
    }

    private fun readFully(input: InputStream, buf: ByteArray, len: Int): Boolean {
        var off = 0
        while (off < len) {
            val n = input.read(buf, off, len - off)
            if (n < 0) return false
            off += n
        }
        return true
    }

    private fun copyExact(input: InputStream, out: java.io.OutputStream, size: Long) {
        val buf = ByteArray(65536)
        var left = size
        while (left > 0) {
            val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (n < 0) break
            out.write(buf, 0, n)
            left -= n
        }
    }

    private fun skipExact(input: InputStream, size: Long) {
        skipBytes(input, size)
        skipPadding(input, size)
    }

    private fun skipPadding(input: InputStream, size: Long) {
        val pad = ((512 - (size % 512)) % 512).toInt()
        if (pad > 0) skipBytes(input, pad.toLong())
    }

    private fun skipBytes(input: InputStream, n: Long) {
        var left = n
        val buf = ByteArray(8192)
        while (left > 0) {
            val r = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (r < 0) return
            left -= r
        }
    }
}
