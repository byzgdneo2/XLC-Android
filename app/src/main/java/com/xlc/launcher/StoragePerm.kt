package com.xlc.launcher

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import androidx.core.content.ContextCompat

/**
 * 存储权限（游戏目录 / Java 运行时都落在共享存储上，用户才能用文件管理器直接管理）。
 *
 * 分水岭是 API 30：
 *   - Android 11+：走「所有文件访问」MANAGE_EXTERNAL_STORAGE，必须跳系统设置页手动授权，
 *     代码里无法直接弹窗（Google 的隐私策略），所以只能引导用户去开关。
 *   - Android 10 及以下：经典的 READ/WRITE_EXTERNAL_STORAGE 运行时权限，可以直接弹窗。
 *
 * 界面侧无需感知差异，统一看 [has] 的结果即可。
 */
object StoragePerm {

    /** 当前是否已拿到存储权限 */
    fun has(ctx: Context): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Environment.isExternalStorageManager()
    } else {
        ContextCompat.checkSelfPermission(
            ctx, android.Manifest.permission.WRITE_EXTERNAL_STORAGE
        ) == PackageManager.PERMISSION_GRANTED
    }

    /** 人类可读的权限档位，给界面显示 */
    fun level(ctx: Context): String = when {
        has(ctx) -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) "all-files" else "legacy"
        else -> "none"
    }

    /** Android 11+ 需要跳系统设置页授权 */
    fun needsSettingsPage(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

    /** 共享存储根目录（已授权时可用；未授权返回 App 专属外部目录兜底） */
    fun sharedRoot(ctx: Context): java.io.File =
        if (has(ctx)) Environment.getExternalStorageDirectory()
        else ctx.getExternalFilesDir(null) ?: ctx.filesDir
}
