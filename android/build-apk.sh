#!/usr/bin/env bash
set -euo pipefail

# 手搓CPE — 手动 APK 构建（不依赖 aapt）
#
# 环境变量：
#   ANDROID_JAR    android.jar（必须，例如 $ANDROID_HOME/platforms/android-33/android.jar）
#   PREFIX         Termux/系统前缀（默认 /data/data/com.termux/files/usr）
#   D8_JAR         d8.jar（默认 $PREFIX/share/java/d8.jar）
#   APKSIGNER_JAR  apksigner.jar（默认 $PREFIX/share/java/apksigner.jar）
#   APK_ROOT       可选，构建根目录（默认脚本所在目录）

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
ANDROID_JAR="${ANDROID_JAR:-}"
if [ -z "$ANDROID_JAR" ] || [ ! -f "$ANDROID_JAR" ]; then
  echo "缺少 android.jar：请设置 ANDROID_JAR，例如" >&2
  echo "  export ANDROID_JAR=$ANDROID_HOME/platforms/android-33/android.jar" >&2
  exit 1
fi
D8_JAR="${D8_JAR:-$PREFIX/share/java/d8.jar}"
APKSIGNER_JAR="${APKSIGNER_JAR:-$PREFIX/share/java/apksigner.jar}"

for tool in java javac jar keytool node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "找不到 $tool，请先安装并加入 PATH" >&2; exit 1; }
done
[ -f "$D8_JAR" ] || { echo "找不到 d8.jar：$D8_JAR" >&2; exit 1; }
[ -f "$APKSIGNER_JAR" ] || { echo "找不到 apksigner.jar：$APKSIGNER_JAR" >&2; exit 1; }

mkdir -p app/assets app/build/classes app/build/dex
cp -f ../web/public/* app/assets/
node make-icon.mjs app

javac -source 8 -target 8 -bootclasspath "$ANDROID_JAR" \
  -d app/build/classes app/src/com/dsh/cpepanel/MainActivity.java
jar cf app/build/classes.jar -C app/build/classes .
java -cp "$D8_JAR" com.android.tools.r8.D8 --release --min-api 24 --lib "$ANDROID_JAR" \
  --output app/build/dex app/build/classes.jar
node make-apk.mjs

if [ ! -f app/build/cpe.keystore ]; then
  keytool -genkeypair -keystore app/build/cpe.keystore -alias cpe \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass cpepilot -keypass cpepilot -dname "CN=ShouCou CPE"
fi

rm -f app/build/app-signed.apk
java -jar "$APKSIGNER_JAR" sign \
  --ks app/build/cpe.keystore --ks-pass pass:cpepilot --key-pass pass:cpepilot \
  --out app/build/app-signed.apk app/build/unsigned.apk

echo
echo "APK: $HERE/app/build/app-signed.apk"
