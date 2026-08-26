# Jinko iMin Print Bridge

แอป Android companion สำหรับ iMin D4-504 (Android 7.1.2) ที่รับออเดอร์จากระบบ Jinko แล้วแยกพิมพ์ดังนี้

| รายการ | ปลายทาง | วิธีพิมพ์ |
| --- | --- | --- |
| หมวด `เครื่องดื่ม` | เครื่องพิมพ์ในตัว D4 | iMin Printer SDK 1.3.1 ผ่าน USB |
| รายการอื่นทั้งหมด | เครื่องพิมพ์ครัว | raw ESC/POS bitmap ผ่าน TCP/LAN (ตัวอย่าง `192.0.2.10:9100`) |

แอปเรียก endpoint เดิมของระบบโดยตรง:

- `GET https://your-project.vercel.app/api/orders`
- `GET https://your-project.vercel.app/api/settings`

จึงไม่ต้องติดตั้ง `iMinPrinterPlugin` และไม่พึ่ง WebSocket `ws://127.0.0.1:8081` ที่ทำให้หน้าเว็บ `counter-print` ขึ้นว่าไม่พบเครื่องพิมพ์

## สิ่งที่แอปทำ

- Poll ออเดอร์ทุก 2–30 วินาที (ค่าเริ่มต้น 4 วินาที) และแยกใบสั่งจากออเดอร์เดียวกันเป็นใบ `น้ำ` กับ `ครัว`
- เก็บประวัติแยกตาม `route:orderId` ในเครื่อง เพื่อไม่พิมพ์ซ้ำเมื่อเปิดแอปใหม่ หรือเมื่ออีกปลายทางหนึ่งพิมพ์ไม่สำเร็จ
- ติดตั้งครั้งแรกจะปล่อยผ่านรายการค้างเดิมโดยค่าเริ่มต้น เพื่อไม่ให้พิมพ์บิลเก่าทั้งหมดทันที สามารถปิดตัวเลือกนี้ก่อนซิงก์ครั้งแรกได้
- Rasterize ภาษาไทยเป็น bitmap ก่อนสั่งพิมพ์ทั้งสองเส้นทาง จึงไม่ขึ้นกับ ESC/POS code page ของเครื่องครัว
- มีปุ่มตรวจสถานะและทดสอบพิมพ์สำหรับเครื่องในตัว/เครื่องครัว รวมถึงปุ่มล้างประวัติเพื่อสั่งพิมพ์คิวปัจจุบันใหม่โดยตั้งใจ

## Build APK

ต้องใช้ Android Studio พร้อม Android SDK 33 และ JDK 11 (หรือ JDK ที่ Android Studio ของคุณเลือกให้) และ Node.js 16 ขึ้นไป

```bash
cd JinkoIminPrintBridgeDriveUpdate
npm install
npm run setup:imin
npm run android:release
```

คำสั่ง `setup:imin` ดาวน์โหลด iMin SDK 1.3.1 ทางการ แล้วดึงเฉพาะ JAR และ native libraries ที่ต้องใช้มาไว้ใต้ `android/app` (ไฟล์เหล่านี้ถูก ignore ไม่ถูก commit ลง git) การดาวน์โหลดชุด SDK เต็มมีขนาดประมาณ 235 MB ครั้งแรก

APK ที่ build แล้วอยู่ที่:

```text
android/app/build/outputs/apk/release/app-release.apk
```

ติดตั้งลง iMin ผ่าน ADB หรือคัดลอก APK ไปเปิดบนเครื่องก็ได้ เมื่อเข้าแอปครั้งแรก ให้ตรวจสอบ/ตั้งค่า:

1. ตั้ง `IP เครื่องพิมพ์ครัว` เป็น IP ของเครื่องพิมพ์ในร้าน (ตัวอย่าง `192.0.2.10`) และพอร์ต `9100`
2. เครื่อง iMin และเครื่องพิมพ์ครัวอยู่ใน LAN/VLAN เดียวกัน และเครื่องพิมพ์ครัวเปิดบริการ RAW/ESC-POS ที่ TCP 9100
3. กด `ทดสอบพิมพ์น้ำ` ก่อน — ต้องขึ้นสถานะ “พร้อมพิมพ์” และออกใบภาษาไทย
4. กด `ทดสอบพิมพ์ครัว` — ถ้าต่อไม่ได้ แอปจะแสดงเหตุผลจาก network เช่น timeout/refused
5. ตรวจหมวด `เครื่องดื่ม` ให้ตรงกับชื่อหมวดในเมนูจริง แล้วกดบันทึก

## ข้อสังเกตสำคัญ

- แอปนี้ทำหน้าที่เชื่อมต่ออุปกรณ์เท่านั้น ให้กำหนด URL ของ backend ที่ต้องการในหน้าตั้งค่าของแอป
- การเชื่อมต่อ TCP สำเร็จหมายถึง Android ส่ง job ถึงพอร์ต 9100 ได้; เครื่องพิมพ์ thermal รุ่นนั้นต้องรองรับ ESC/POS raster (เป็นมาตรฐานที่พบทั่วไป) หากเป็นรุ่นเฉพาะทาง ให้บอกยี่ห้อ/รุ่นเพื่อปรับ protocol
- เก็บ history ได้ 500 route ล่าสุด; ถ้าต้องการสั่งพิมพ์ซ้ำ ใช้ปุ่ม “ล้างประวัติ” อย่างระวัง เพราะออเดอร์ที่ยัง `status != done` จะถูกพิมพ์ใหม่

## โครงสร้างที่สำคัญ

- `App.tsx` — หน้าจอ, polling และ routing ของ order
- `android/app/src/main/java/com/jinko/printbridge/IminPrinterModule.java` — React Native native module, iMin SDK และ TCP socket
- `android/app/src/main/java/com/jinko/printbridge/TicketRenderer.java` — สร้าง bitmap ใบสั่งภาษาไทย
- `android/app/src/main/java/com/jinko/printbridge/EscPos.java` — แปลง bitmap เป็น ESC/POS raster สำหรับเครื่องครัว
- `scripts/setup-imin-sdk.sh` — provision iMin SDK 1.x จากแพ็กเกจทางการ
