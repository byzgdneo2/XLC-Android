/*
 * XLC Android —— 仓库配置
 *
 * 注意：本机 maven.google.com 被本地代理拦截（502），
 * 因此 Google Maven 必须走其真实后端 dl.google.com/dl/android/maven2/。
 * 阿里云镜像作为兜底，实测两者内容一致。
 */
pluginManagement {
    repositories {
        maven { url = uri("https://dl.google.com/dl/android/maven2/") }
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    /* 不要设置 FAIL_ON_PROJECT_REPOS：本机 ~/.gradle/init.gradle 里有全局镜像配置
       （阿里云 public/central/google/gradle-plugin + 腾讯 nexus），
       一旦限制为「只认 settings 里的仓库」，init script 注入仓库时会直接构建失败。 */
    repositories {
        maven { url = uri("https://dl.google.com/dl/android/maven2/") }
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        mavenCentral()
    }
}

rootProject.name = "XLC-Android"
include(":app")
