# Android 构建说明

> 本仓库为**代发**，原作者是酷安「大砖头没救了」，由 [bingshuang2014](https://github.com/bingshuang2014) 发布；
> 仓库地址 <https://github.com/bingshuang2014/cep-master>，项目说明与源码安全审查见[仓库根目录 README](../README.md)。

这套 APK 不依赖 aapt（aapt 在部分 ARM 环境缺 libc++ 符号）。构建流程：

1. `javac` 编译 `MainActivity.java`
2. `d8` 转 classes.dex
3. `make-apk.mjs` 手写：
   - 二进制 `AndroidManifest.xml`（AXML）
   - `resources.arsc`（单个 mipmap 图标，4 字节对齐）
   - APK zip（全部 store，`resources.arsc` 对齐）
4. `apksigner` 签名（v2/v3）

## 环境

- JDK（javac / jar / keytool）
- Node.js 22+（`make-apk.mjs` / `make-icon.mjs` 用到 Node v22.2.0 / v20.15.0 才加入的 `zlib.crc32()`，低版本会报 `zlib.crc32 is not a function`；仅跑网页版不受此限制）
- `android.jar`（Android SDK platform）
- `d8.jar`、`apksigner.jar`（Android build-tools 或 Termux 包）

```sh
export ANDROID_JAR=$ANDROID_HOME/platforms/android-33/android.jar
export D8_JAR=/path/to/d8.jar
export APKSIGNER_JAR=/path/to/apksigner.jar
./build-apk.sh
```

Termux 示例：

```sh
export ANDROID_JAR=/data/local/tmp/platform33/android-13/android.jar
export D8_JAR=/data/data/com.termux/files/usr/share/java/d8.jar
export APKSIGNER_JAR=/data/data/com.termux/files/usr/share/java/apksigner.jar
./build-apk.sh
```

## 改包名 / 名称

- `make-apk.mjs` 里的 `manifest` 树（package、label、icon、versionName）
- `app/src/com/dsh/cpepanel/MainActivity.java` 的 package
- `AndroidManifest.xml`（文本参考）
- 资源包名在 `make-apk.mjs` 的 `buildResources()` 里（默认 `com.dsh.cpepanel`）

图标由 `make-icon.mjs` 生成到 `app/res/mipmap/ic_launcher.png`，改颜色 / 形状直接改脚本后重跑。

## 签名

首次构建自动生成 `app/build/cpe.keystore`（alias cpe，密码 cpepilot）。
正式发布请换成自己的 keystore，并注意：换签名后覆盖安装需要先卸载旧版。

## 注意

- WebView 需要允许明文 HTTP（targetSdk 27）才能加载 `192.168.66.1:9527`；
  如果提高 targetSdk，需要加 networkSecurityConfig。
- 每个 ubus 请求用 `Network.openConnection` 绑定 WiFi，避免手机默认走移动数据。
- 5G 通信壳是 iframe，必须允许 mixed content。
- 当前源码构建出的版本号是 **1.6.1**（`versionCode=3`）：仓库源码已修复 sms-send 命令注入，
  已发布的 v1.6.0 成品仍是旧代码。需要短信发送功能请用本脚本自行构建，
  详见[根目录 README「关于 1.6.1 与短信发送功能」](../README.md)。
