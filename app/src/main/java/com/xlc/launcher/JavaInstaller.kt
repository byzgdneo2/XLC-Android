package com.xlc.launcher

import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 安卓端 Java 运行时（JRE）的安装与管理。
 *
 * 与桌面端的差异：
 *   桌面端 java:download 下的是 Windows x64 的 JDK，安卓端必须是 **按 ABI 编译的移动版 OpenJDK**
 *   （PojavLauncher 那一套）。所以这里维护一份「版本 × ABI → 下载源」表，按设备首选 ABI 挑。
 *
 * 为什么必须先有存储权限：
 *   游戏目录放在共享存储上（用户才能用文件管理器直接丢 mod / 存档），
 *   而 JRE 自身必须落在应用私有目录 —— 共享存储是 noexec，二进制在那里跑不起来。
 *   所以「装 Java」这一步先要权限，再往私有目录里落地。
 *
 * 目录布局：
 *   <files>/java/jre17-<abi>/bin/java           可执行入口
 *   <files>/java/jre17-<abi>/xlc-java.json      安装标记（版本 / 架构 / 来源）
 */
class JavaInstaller(
    private val ctx: Context,
    private val activityRef: () -> MainActivity?,
    private val emit: (String, JSONObject) -> Unit
) {

    private val javaRoot = File(ctx.filesDir, "java").apply { mkdirs() }
    private val dlDir = File(ctx.filesDir, "java-dl").apply { mkdirs() }

    /** 一个下载源：某个 Java 大版本 + 某个 ABI 的压缩包 */
    private data class Source(val major: Int, val abi: String, val canonical: String, val mirrorable: Boolean = true)

    /* ==================================================================
     * 下载源表
     *
     * 说明：
     *   PojavLauncher 官方的 android-openjdk-build-multiarch 已归档、releases 被删除，
     *   这里改用两个仍在提供服务的公开源（都是 PojavLauncher 系的移动版 OpenJDK）。
     *
     * 网络现实（实测）：
     *   raw.githubusercontent.com 与 objects.githubusercontent.com 在本机直连不可达（无响应），
     *   github.com 自身能通但只返回 302 跳到对象存储 → 等于下不动。
     *   所以真正能用的是 GitHub 加速镜像（支持 Range，实测 100~265 KB/s）。
     *   下面的 GitHubMirrors 就是给这些地址统一加镜像前缀，直连放在最后兜底。
     * ================================================================== */
    private val gitHubMirrors = listOf(
        "https://gh-proxy.com/",
        "https://ghproxy.net/",
        "https://ghfast.top/",
        ""                                   // 空串 = 直连兜底（网络通的地方直接下更快）
    )

    private val sources: List<Source> = listOf(
        Source(
            17, "arm64-v8a",
            "https://raw.githubusercontent.com/GramZenn/PojavJREs/main/jre17-arm64-20231116-release.tar.xz"
        ),
        Source(
            21, "arm64-v8a",
            "https://raw.githubusercontent.com/GramZenn/PojavJREs/main/jre21-arm64-20230913-release.tar.xz"
        ),
        // 备用：另一个仓库的 jre17 构建，尺寸更大但同样可用
        Source(
            17, "arm64-v8a",
            "https://github.com/itsaky/openjdk-17-android/releases/download/01-01-2022/jre17-arm64.tar.xz"
        )
    )

    /** 把一个 GitHub 地址展开成「镜像优先、直连兜底」的候选列表 */
    private fun candidates(canonical: String): List<String> =
        gitHubMirrors.map { it + canonical }.distinct()

    private val supportedMajors = listOf(17, 21)

    /* ==================================================================
     * 已安装列表（java:detect）
     * ================================================================== */

    fun detect(): JSONArray {
        val out = JSONArray()
        val dirs = javaRoot.listFiles { f -> f.isDirectory && f.name.startsWith("jre") } ?: return out
        for (d in dirs.sortedByDescending { it.name }) {
            val bin = File(d, "bin/java")
            if (!bin.isFile) continue
            val meta = readMeta(d) ?: JSONObject()
            out.put(
                JSONObject()
                    .put("major", meta.optInt("major", majorOf(d.name)))
                    .put("path", bin.absolutePath)
                    .put("javaw", bin.absolutePath)
                    .put("home", d.absolutePath)
                    .put("arch", meta.optString("arch", ""))
                    .put("version", meta.optString("version", ""))
                    .put("foreignArch", meta.optBoolean("foreignArch", false))
                    .put("source", meta.optString("source", ""))
                    .put("mobile", true)
            )
        }
        return out
    }

    /* ==================================================================
     * 安装（java:download）
     * ================================================================== */

    fun download(major: Int): JSONObject {
        // ① 存储权限是前置条件
        if (!StoragePerm.has(ctx)) {
            status("正在申请存储权限…", true)
            if (!requestStorageBlocking()) {
                status("就绪", false)
                return err("未授予存储权限，无法安装 Java —— 请允许「所有文件访问」后重试")
            }
        }

        val src = pickSource(major)
            ?: return err(missingSourceHint(major))
        val abi = nativeAbi()

        val dest = File(javaRoot, "jre$major-${src.abi}")
        val tmp = File(javaRoot, ".tmp-jre$major")
        val pkg = File(dlDir, "jre$major-${src.abi}.tar.xz")

        return try {
            status("下载 Java $major（${abiLabel(src.abi)}，约 ${sizeHint(major)}）…", true)
            emit(
                "java:progress",
                JSONObject().put("stage", "download").put("percent", 0)
                    .put("text", "连接下载源…").put("major", major)
            )

            // ② 下载（已存在且大小合理则复用，支持断点式重试）
            if (!(pkg.isFile && pkg.length() > 8L * 1024 * 1024 && pkg.lastModified() > 0)) {
                downloadPackage(src, pkg, major)
            } else {
                Log.i(TAG, "复用已下载的包: ${pkg.absolutePath} (${pkg.length()} bytes)")
            }

            // ③ 解压到临时目录后整体替换（避免半截状态被 detect 看到）
            status("解压 Java $major…", true)
            emit(
                "java:progress",
                JSONObject().put("stage", "extract").put("percent", 0)
                    .put("text", "解压中…").put("major", major)
            )
            if (tmp.exists()) tmp.deleteRecursively()
            tmp.mkdirs()
            val n = Archive.extractTarXz(pkg, tmp) { pct ->
                emit(
                    "java:progress",
                    JSONObject().put("stage", "extract").put("percent", pct)
                        .put("text", "解压中… $pct%").put("major", major)
                )
                if (pct % 10 == 0) status("解压 Java $major… $pct%", true)
            }
            Log.i(TAG, "解压完成，写入 $n 个文件 -> ${tmp.absolutePath}")

            val binJava = File(tmp, "bin/java")
            if (!binJava.isFile) {
                tmp.deleteRecursively()
                return err("压缩包结构异常：未找到 bin/java（来源可能已损坏）")
            }

            // ④ 可执行权限（tar 的 mode 有时不带 exec 位，统一补一遍）
            makeExecutable(File(tmp, "bin"))
            makeExecutable(File(tmp, "lib"))

            // ⑤ 落位 + 写标记
            if (dest.exists()) dest.deleteRecursively()
            if (!tmp.renameTo(dest)) {
                tmp.copyRecursively(dest, overwrite = true)
                tmp.deleteRecursively()
            }

            val version = readReleaseVersion(File(dest, "release"))
            val foreign = src.abi != abi
            writeMeta(
                dest, JSONObject()
                    .put("major", major)
                    .put("arch", src.abi)
                    .put("version", version)
                    .put("foreignArch", foreign)
                    .put("source", src.canonical)
                    .put("installedAt", System.currentTimeMillis())
            )

            status("就绪", false)
            emit(
                "app:toast",
                JSONObject().put("msg", "Java $major 安装完成${if (foreign) "（${abiLabel(src.abi)}，非本机原生架构）" else ""}")
                    .put("type", if (foreign) "warn" else "info")
            )
            JSONObject().put("ok", true)
                .put("javaw", File(dest, "bin/java").absolutePath)
                .put("major", major)
                .put("arch", src.abi)
                .put("version", version)
        } catch (e: Exception) {
            Log.e(TAG, "安装 Java $major 失败", e)
            status("就绪", false)
            if (tmp.exists()) tmp.deleteRecursively()
            err(e.message ?: "安装失败")
        }
    }

    /* ==================================================================
     * 运行验证（java:test）
     * ================================================================== */

    fun test(major: Int): JSONObject {
        val found = findInstalled(major) ?: return err("未找到已安装的 Java $major")
        val home = found.first
        val exe = File(home, "bin/java")
        return try {
            val pb = ProcessBuilder(exe.absolutePath, "-version")
                .directory(home)
            pb.environment().apply {
                put("JAVA_HOME", home.absolutePath)
                put("PATH", "${File(home, "bin").absolutePath}:" + (get("PATH") ?: "/system/bin"))
                put(
                    "LD_LIBRARY_PATH",
                    listOf("lib", "lib/server", "lib/jli", "bin").joinToString(":") {
                        File(home, it).absolutePath
                    }
                )
            }
            val p = pb.start()
            val text = p.inputStream.bufferedReader().use { it.readText() }
            val done = p.waitFor(25, TimeUnit.SECONDS)
            if (!done) p.destroy()
            val ok = done && p.exitValue() == 0
            JSONObject().put("ok", ok).put("exit", if (done) p.exitValue() else -1)
                .put("output", text.trim())
        } catch (e: Throwable) {
            Log.w(TAG, "java -version 执行失败", e)
            val m = e.message.orEmpty()
            // 安卓 10+ 的 W^X：应用私有目录里的二进制不允许被 execve，
            // SELinux 会直接回 execute_no_trans denied（error=13）。
            // 这不是文件权限位的问题（755 已经打上了），是平台策略。
            if (m.contains("Permission denied") || m.contains("error=13")) {
                err(
                    "系统禁止从应用目录直接执行二进制（Android 10+ 的 W^X 策略）。" +
                        "运行时已正确下载并落盘，但启动方式需要改为「随安装包内置 + 进程内加载」" +
                        "（PojavLauncher 路线）：把 JRE 的 .so 放进 APK 的 jniLibs，再用 dlopen 拉起 libjvm。" +
                        "当前设备 ${nativeAbi()}；已装运行时位于 ${home.name}。（详见项目备忘）"
                )
            } else {
                err("无法执行: $m")
            }
        }
    }

    /* ==================================================================
     * 卸载（java:remove）
     * ================================================================== */

    fun remove(major: Int): JSONObject {
        val found = findInstalled(major) ?: return err("未找到已安装的 Java $major")
        return try {
            val ok = found.first.deleteRecursively()
            if (ok) JSONObject().put("ok", true) else err("删除失败（文件被占用？）")
        } catch (e: Throwable) {
            err(e.message ?: "删除失败")
        }
    }

    /** 已装版本概览：给界面显示「可下载 / 已安装」 */
    fun overview(): JSONObject {
        val installed = JSONArray()
        for (m in supportedMajors) {
            if (findInstalled(m) != null) installed.put(m)
        }
        val avail = JSONArray()
        for (m in supportedMajors) {
            if (pickSource(m) != null) avail.put(m)
        }
        return JSONObject()
            .put("ok", true)
            .put("installed", installed)
            .put("downloadable", avail)
            .put("supported", JSONArray(supportedMajors))
            .put("abi", nativeAbi())
            .put("abis", JSONArray(Build.SUPPORTED_ABIS.toList()))
    }

    /* ==================================================================
     * 内部工具
     * ================================================================== */

    /**
     * 按设备 ABI 优先级挑源：先找本机原生架构，再退到任意可用架构。
     * （模拟器带 ARM 转译时 SUPPORTED_ABIS 里同时有 x86_64 与 arm64-v8a，
     *   但没有 x86_64 的 JRE 构建，于是会退到 arm64 —— 此时结果里会标 foreignArch。）
     */
    private fun pickSource(major: Int): Source? {
        for (abi in Build.SUPPORTED_ABIS) {
            sources.firstOrNull { it.major == major && it.abi == abi }?.let { return it }
        }
        return sources.firstOrNull { it.major == major }
    }

    private fun missingSourceHint(major: Int): String =
        if (major !in supportedMajors)
            "移动端目前只提供 Java ${supportedMajors.joinToString(" / ")} 的运行时；Java $major 暂无可下载的构建"
        else "没有匹配 ${nativeAbi()} 的 Java $major 构建，请稍后再试或手动安装"

    /** 设备真正的主 ABI（判断下载到的包是不是本机原生架构用） */
    private fun nativeAbi(): String = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"

    private fun abiLabel(abi: String): String = when (abi) {
        "arm64-v8a" -> "arm64"
        "armeabi-v7a" -> "arm32"
        else -> abi
    }

    private fun sizeHint(major: Int): String = when (major) {
        17 -> "22 MB"
        21 -> "26 MB"
        else -> "约 25 MB"
    }

    private fun downloadPackage(src: Source, pkg: File, major: Int) {
        val errs = mutableListOf<String>()
        for (url in candidates(src.canonical)) {
            val host = try { java.net.URL(url).host } catch (e: Throwable) { url.take(30) }
            try {
                status("从 $host 下载 Java $major…", true)
                Net.download(url, pkg, null, 120000) { pct, got, total ->
                    if (pct >= 0) {
                        emit(
                            "java:progress",
                            JSONObject().put("stage", "download").put("percent", pct)
                                .put("text", "下载 Java $major $pct%").put("major", major)
                        )
                        if (pct % 5 == 0) status("下载 Java $major… $pct%", true)
                    } else {
                        emit(
                            "java:progress",
                            JSONObject().put("stage", "download").put("percent", 50)
                                .put("text", "下载 Java $major ${got / 1048576} MB").put("major", major)
                        )
                    }
                }
                if (pkg.length() < 5L * 1024 * 1024) throw IOException("下载内容过小（${pkg.length()} 字节）")
                return
            } catch (e: Exception) {
                Log.w(TAG, "下载源失败 $url: ${e.message}")
                errs.add("$host: ${e.message}")
                if (pkg.exists()) pkg.delete()
            }
        }
        throw IOException("所有下载源均失败（${errs.joinToString("；")}）")
    }

    private fun findInstalled(major: Int): Pair<File, JSONObject>? {
        val dirs = javaRoot.listFiles { f -> f.isDirectory && f.name.startsWith("jre$major-") } ?: return null
        for (d in dirs) {
            if (File(d, "bin/java").isFile) return d to (readMeta(d) ?: JSONObject())
        }
        return null
    }

    private fun majorOf(dirName: String): Int =
        Regex("jre(\\d+)").find(dirName)?.groupValues?.get(1)?.toIntOrNull() ?: 0

    private fun metaFile(dir: File) = File(dir, "xlc-java.json")

    private fun readMeta(dir: File): JSONObject? = try {
        val f = metaFile(dir)
        if (f.isFile) JSONObject(f.readText(Charsets.UTF_8)) else null
    } catch (e: Throwable) { null }

    private fun writeMeta(dir: File, meta: JSONObject) {
        try {
            metaFile(dir).writeText(meta.toString(2), Charsets.UTF_8)
        } catch (e: Throwable) {
            Log.w(TAG, "写安装标记失败: ${e.message}")
        }
    }

    /** 从 release 文件里读 JAVA_VERSION，例如 17.0.9 */
    private fun readReleaseVersion(f: File): String = try {
        if (!f.isFile) "" else {
            val txt = f.readText(Charsets.UTF_8)
            Regex("JAVA_VERSION=\"?([^\"\n\r]+)\"?").find(txt)?.groupValues?.get(1)?.trim().orEmpty()
        }
    } catch (e: Throwable) { "" }

    /** 递归补可执行位（安卓上 File.setExecutable 对应用私有目录有效） */
    private fun makeExecutable(dir: File) {
        if (!dir.isDirectory) return
        val stack = ArrayDeque<File>()
        stack.addLast(dir)
        var n = 0
        while (stack.isNotEmpty()) {
            val d = stack.removeLast()
            val kids = d.listFiles() ?: continue
            for (k in kids) {
                if (k.isDirectory) stack.addLast(k)
                else if (k.setExecutable(true, false)) n++
            }
        }
        Log.i(TAG, "已赋可执行权限: ${dir.name} ($n 个文件)")
    }

    /** 在 UI 线程拉起存储权限申请，并阻塞等待结果（下载线程需同步等） */
    private fun requestStorageBlocking(): Boolean {
        val act = activityRef() ?: return StoragePerm.has(ctx)
        val latch = CountDownLatch(1)
        var granted = false
        act.runOnUiThread {
            act.requestStorage { ok ->
                granted = ok
                latch.countDown()
            }
        }
        // 用户可能要在系统设置里翻找，给足时间
        val done = try { latch.await(180, TimeUnit.SECONDS) } catch (e: InterruptedException) { false }
        return done && granted
    }

    private fun status(text: String, busy: Boolean) {
        emit("app:status", JSONObject().put("text", text).put("busy", busy))
    }

    private fun err(msg: String) = JSONObject().put("ok", false).put("error", msg)

    companion object {
        private const val TAG = "XLC-Java"
    }
}
