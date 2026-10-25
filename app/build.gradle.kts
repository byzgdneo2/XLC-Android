plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.xlc.launcher"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.xlc.launcher"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-spike1"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            // Spike 阶段先用 debug 签名，保证产物能直接装上真机
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    // assets 里的 Web UI 已是成品，不要被 aapt 压缩，避免 WebView 读取异常
    androidResources {
        noCompress += listOf("html", "js", "css")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // WebViewAssetLoader：以 https 源承载 assets，避开 file:// 的 CSP/CORS 坑
    implementation("androidx.webkit:webkit:1.12.1")
    // 纯 Java 的 xz 解压：安卓自带只有 tar+gzip，没有 xz，而移动版 JRE 都是 .tar.xz
    implementation("org.tukaani:xz:1.10")
}
