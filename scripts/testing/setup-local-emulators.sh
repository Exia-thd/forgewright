#!/bin/bash
set -e

echo "=== Cài đặt cấu hình thiết bị Android ảo cục bộ ==="

# 1. Kiểm tra Android SDK / Command line tools
if [ -z "$ANDROID_HOME" ]; then
    echo "LỖI: Chưa cấu hình biến môi trường \$ANDROID_HOME."
    exit 1
fi

SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"

# 2. Tải System Image (Android 33 - API 33)
echo "Đang tải hệ điều hành Android 33..."
"$SDKMANAGER" "system-images;android-33;google_apis;x86_64"

# 3. Tạo thiết bị ảo
echo "Đang tạo AVD tên 'ForgewrightTestDevice'..."
echo "no" | "$AVDMANAGER" create avd -n ForgewrightTestDevice -k "system-images;android-33;google_apis;x86_64" --force

# 4. Tạo script khởi chạy background
LAUNCHER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/run-local-emulator.mjs"
mkdir -p scripts
printf '#!/bin/bash\nLAUNCHER=%q\n' "$LAUNCHER" > scripts/start-emulator.sh
cat << 'EOF' >> scripts/start-emulator.sh
#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$PROJECT_ROOT"
echo "Khởi chạy máy ảo có admission và cleanup; Ctrl-C để đóng..." >&2
exec node "$LAUNCHER"
EOF

chmod +x scripts/start-emulator.sh
echo "=== THÀNH CÔNG: Chạy 'bash scripts/start-emulator.sh' để khởi động máy ảo ==="
