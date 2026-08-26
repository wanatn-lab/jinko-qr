#!/bin/bash
# Run this file once (double-click it) to:
#  1. Add a desktop shortcut for one-click manual start
#  2. Make the print system launch automatically every time you log into this Mac
# You do not need to run this file again after that.

cd "$(dirname "$0")"
DIR="$(pwd)"
LAUNCHER="$DIR/start-print-agent.command"

echo "======================================================"
echo " กำลังตั้งค่าระบบพิมพ์ครัว..."
echo "======================================================"
echo "โฟลเดอร์ที่ใช้งาน: $DIR"
echo ""

if [ ! -f "$LAUNCHER" ]; then
  echo "[ผิดพลาด] ไม่พบไฟล์ start-print-agent.command ในโฟลเดอร์เดียวกัน"
  echo "กรุณาแตกไฟล์ zip ทั้งหมดไว้ในโฟลเดอร์เดียวกัน แล้วลองใหม่"
  echo ""
  read -p "กด Enter เพื่อปิดหน้าต่างนี้..." _dummy
  exit 1
fi

echo "[1/4] พบไฟล์ start-print-agent.command แล้ว ✓"
chmod +x "$LAUNCHER"

DESKTOP_LINK="$HOME/Desktop/kitchen-print-agent.command"
echo "[2/4] กำลังสร้างไอคอนบน Desktop..."
cat > "$DESKTOP_LINK" << WRAPPER_EOF
#!/bin/bash
cd "$DIR"
exec "$LAUNCHER"
WRAPPER_EOF
chmod +x "$DESKTOP_LINK"
xattr -d com.apple.quarantine "$DESKTOP_LINK" 2>/dev/null
echo "      สร้างไอคอนเสร็จแล้ว: $DESKTOP_LINK ✓"

echo "[3/4] กำลังตั้งค่าให้เปิดอัตโนมัติตอนเข้าเครื่อง..."
echo "      (macOS อาจขอสิทธิ์ 'Terminal wants access to control System Events' -- กด Allow/OK)"
osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$LAUNCHER\", hidden:false, name:\"kitchen-print-agent\"}" 2>&1
echo "      ตั้งค่า Login Item เสร็จแล้ว ✓"

echo "[4/4] เสร็จสิ้น!"
echo ""
echo "======================================================"
echo " ตั้งค่าเรียบร้อยแล้ว!"
echo " - เปิดใช้งานด้วยไอคอน kitchen-print-agent บน Desktop"
echo " - หรือระบบจะเปิดให้เองอัตโนมัติทุกครั้งที่เข้าเครื่อง"
echo "======================================================"
echo ""
read -p "กด Enter เพื่อปิดหน้าต่างนี้..." _dummy
