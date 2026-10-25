package com.xlc.launcher

import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.io.File
import java.util.zip.GZIPInputStream

/**
 * 极简 NBT 读取器（只够读 level.dat 里存档那点元数据）。
 *
 * 为什么不用现成库：安卓端为了一个存档名称引入完整 NBT 依赖不划算，
 * 这里只做「按类型跳过 → 把 Compound 解成 Map」这一件事，约 100 行。
 *
 * 返回结构：tag 类型 → Byte/Short/Int/Long/Float/Double/ByteArray/String/List<Any?>/Map<String,Any?>/IntArray/LongArray
 */
object Nbt {

    fun readLevelDat(path: File): Map<String, Any?>? = try {
        DataInputStream(GZIPInputStream(ByteArrayInputStream(path.readBytes()))).use { ins ->
            val type = ins.readByte().toInt()
            if (type != TAG_COMPOUND) null
            else {
                skipName(ins)
                readCompound(ins)
            }
        }
    } catch (e: Throwable) {
        null
    }

    /* ==================================================================
     * 解析
     * ================================================================== */

    private fun readTag(ins: DataInputStream, type: Int): Any? = when (type) {
        TAG_BYTE -> ins.readByte()
        TAG_SHORT -> ins.readShort()
        TAG_INT -> ins.readInt()
        TAG_LONG -> ins.readLong()
        TAG_FLOAT -> ins.readFloat()
        TAG_DOUBLE -> ins.readDouble()
        TAG_BYTE_ARRAY -> ByteArray(ins.readInt().coerceIn(0, 1 shl 24)).also { ins.readFully(it) }
        TAG_STRING -> ins.readUTF()
        TAG_LIST -> {
            val elemType = ins.readByte().toInt()
            val n = ins.readInt().coerceIn(0, 1 shl 20)
            val out = ArrayList<Any?>(n)
            repeat(n) { out.add(readTag(ins, elemType)) }
            out
        }
        TAG_COMPOUND -> readCompound(ins)
        TAG_INT_ARRAY -> IntArray(ins.readInt().coerceIn(0, 1 shl 22)).also { arr -> for (i in arr.indices) arr[i] = ins.readInt() }
        TAG_LONG_ARRAY -> LongArray(ins.readInt().coerceIn(0, 1 shl 22)).also { arr -> for (i in arr.indices) arr[i] = ins.readLong() }
        else -> null
    }

    private fun readCompound(ins: DataInputStream): Map<String, Any?> {
        val map = LinkedHashMap<String, Any?>()
        while (true) {
            val type = ins.readByte().toInt()
            if (type == TAG_END) break
            val name = ins.readUTF()
            map[name] = readTag(ins, type)
        }
        return map
    }

    private fun skipName(ins: DataInputStream) {
        val len = ins.readShort().toInt()
        if (len > 0) ins.skipBytes(len)
    }

    /* ==================================================================
     * 取值助手
     * ================================================================== */

    @Suppress("UNCHECKED_CAST")
    fun compound(v: Any?): Map<String, Any?>? = v as? Map<String, Any?>

    fun asLong(v: Any?): Long? = when (v) {
        is Byte -> v.toLong()
        is Short -> v.toLong()
        is Int -> v.toLong()
        is Long -> v
        is Float -> v.toLong()
        is Double -> v.toLong()
        else -> null
    }

    /** 1.16+ 的种子藏在 WorldGenSettings.seed（IntArray），老版本是 RandomSeed（Long） */
    fun seedOf(data: Map<String, Any?>): Long? {
        compound(data["WorldGenSettings"])?.let { wgs ->
            (wgs["seed"] as? IntArray)?.let { arr ->
                if (arr.size >= 2) ((arr[0].toLong() shl 32) or (arr[1].toLong() and 0xFFFFFFFFL)) else arr.firstOrNull()?.toLong()
            }?.let { return it }
        }
        return asLong(data["RandomSeed"])
    }

    const val TAG_END = 0
    const val TAG_BYTE = 1
    const val TAG_SHORT = 2
    const val TAG_INT = 3
    const val TAG_LONG = 4
    const val TAG_FLOAT = 5
    const val TAG_DOUBLE = 6
    const val TAG_BYTE_ARRAY = 7
    const val TAG_STRING = 8
    const val TAG_LIST = 9
    const val TAG_COMPOUND = 10
    const val TAG_INT_ARRAY = 11
    const val TAG_LONG_ARRAY = 12
}
