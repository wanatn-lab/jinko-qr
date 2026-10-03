# จิ๊นโค — ระบบสั่งอาหารผ่าน QR (เวอร์ชัน Vercel)

พอร์ตมาจากเวอร์ชัน Netlify เดิม (thriving-semolina-4ba5a2) ให้รันบน **Vercel** แทน
โค้ดหน้าเว็บ (`admin.html`, `order.html`, `style.css`) เหมือนเดิมทุกตัวอักษร ไม่ได้แก้อะไร
ที่เปลี่ยนคือฝั่ง backend (`api/*.js`) และที่เก็บข้อมูล — จาก Netlify Blobs เป็น **Upstash Redis**
(เพิ่มเข้าโปรเจกต์ผ่านแท็บ Storage ของ Vercel ได้ฟรีในระดับเริ่มต้น)

## ทำไมต้องย้าย

QR ที่แปะโต๊ะเดิมชี้ไปที่ `https://thriving-semolina-4ba5a2.netlify.app/order?table=N` — เมื่อสแกนแล้ว
เปิดไม่ขึ้น/error แปลว่าเว็บปลายทางนั้นมีปัญหา ย้ายมาที่ Vercel จะได้โดเมนใหม่ (เช่น
`https://ชื่อโปรเจกต์.vercel.app`) **ซึ่งแปลว่า QR เดิมที่ปริ้นแปะโต๊ะไว้ใช้ต่อไม่ได้ ต้องพิมพ์ QR ใหม่ทุกโต๊ะ**
(เข้าหน้า `/admin` → แท็บ "QR โต๊ะ" → กดพิมพ์ ได้ QR ชุดใหม่ที่ชี้มาโดเมน Vercel ทันที)

## โครงสร้างไฟล์

```
vercel-site/
├── vercel.json              rewrite /admin → /admin.html, /order → /order.html
├── package.json             dependency เดียวคือ @upstash/redis
├── admin.html                หน้าแอดมิน (เหมือนเดิมทุกตัวอักษร)
├── order.html                หน้าสั่งอาหารลูกค้า (เหมือนเดิมทุกตัวอักษร)
├── style.css                 สไตล์ (เหมือนเดิมทุกตัวอักษร)
├── print-agent.zip           ตัวเชื่อมเครื่องพิมพ์ (เหมือนเดิม)
└── api/
    ├── _redis.js              ตัวเชื่อม Upstash Redis ใช้ร่วมกันทุก endpoint
    ├── menu.js                GET/POST /api/menu
    ├── settings.js            GET/POST /api/settings
    ├── orders.js              GET/POST /api/orders
    └── printer-status.js      GET/POST /api/printer-status
```

## ขั้นตอน Deploy ครั้งแรก

### 1. ติดตั้ง Vercel CLI (ถ้ายังไม่มี)
```bash
npm install -g vercel
```

### 2. สร้าง/เชื่อมโปรเจกต์
```bash
cd vercel-site
npm install
vercel login          # ล็อกอินบัญชีที่มีทีม nutt4
vercel link            # เลือก scope "nutt4" แล้วตั้งชื่อโปรเจกต์ใหม่ (เช่น jinko-order)
```

### 3. เพิ่ม Storage (Upstash Redis) — ทำครั้งเดียว
1. เข้า **vercel.com/nutt4** → เลือกโปรเจกต์ที่เพิ่งสร้าง → แท็บ **Storage**
2. กด **Create Database** (หรือ Browse Marketplace) → เลือก **Upstash — Redis** (ฟรีในระดับเริ่มต้น พอสำหรับร้านขนาดนี้สบายๆ)
3. ตั้งชื่อฐานข้อมูล แล้วกด **Connect** ให้ผูกกับโปรเจกต์นี้
4. Vercel จะเติม environment variable ให้อัตโนมัติ (`KV_REST_API_URL` / `KV_REST_API_TOKEN` หรือ
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — โค้ดในนี้รองรับทั้งสองชื่อ)

### 4. Deploy
```bash
vercel --prod
```
เสร็จแล้วจะได้ลิงก์ เช่น `https://jinko-order.vercel.app` — หน้าแอดมินอยู่ที่ `/admin`
หน้าลูกค้าอยู่ที่ `/order?table=1`

### 5. พิมพ์ QR โต๊ะใหม่
เข้า `/admin` → แท็บ **QR โต๊ะ** → กดพิมพ์ ได้ QR ชุดใหม่ชี้มาโดเมน Vercel ทันที (แทนที่ QR เดิมทุกใบ)

### 6. อัปเดตตัวเชื่อมเครื่องพิมพ์ (print-agent)
ถ้าเคยตั้งค่า `apiBase` ของ print-agent ให้ชี้ไปที่โดเมน Netlify เดิม ต้องแก้ให้ชี้มาโดเมน Vercel ใหม่แทน
(ไฟล์ตั้งค่าของ print-agent — ดูรายละเอียดใน README ที่แนบมาในซิป `print-agent.zip`)

## Deploy ครั้งต่อๆ ไป (หลังแก้โค้ด)
```bash
vercel --prod
```
ข้อมูลจริง (เมนู/ออเดอร์/ตั้งค่าร้าน) อยู่ใน Upstash Redis แยกจากไฟล์เว็บ — deploy โค้ดทับใหม่กี่ครั้ง
ข้อมูลเดิมก็ยังอยู่ครบ

## API ทั้งหมด

| Endpoint | Method | ทำอะไร |
|---|---|---|
| `/api/menu` | GET / POST | ดึง/บันทึกรายการเมนูทั้งหมด |
| `/api/settings` | GET / POST | ดึง/บันทึกชื่อร้าน จำนวนโต๊ะ ขนาดกระดาษ เครื่องพิมพ์ |
| `/api/orders` | GET / POST | ดึงออเดอร์ย้อนหลัง 24 ชม. / สั่งใหม่ / ปิดออเดอร์ |
| `/api/printer-status` | GET / POST | สถานะเชื่อมต่อเครื่องพิมพ์ล่าสุดจาก print-agent |
| `/api/print-jobs` | GET / POST | คิวใบเสร็จ iMin: Bridge claim → พิมพ์ → ยืนยันงาน |

---
พอร์ตจาก Netlify มา Vercel โดย Claude (Cowork) — สิงหาคม 2569
