import { redis } from "./_redis.js";

// Defaults match the original receipt and kitchen print layouts. Existing
// stored settings still take priority over these values.
const SEED_SETTINGS = {
  tableCount: 20,
  shopName: "จิ๊นโค",
  paperWidthMm: 80,
  printers: [],
  receipt: {
    logoUrl: "",
    shopPhone: "085-529-8799",
    shopAddress: "",
    taxId: "",
    title: "ใบเสร็จรับเงิน",
    thanksText: "ขอบคุณที่แวะมาจ้า โอกาสหน้าเชิญใหม่นะ",
    apologyText: "ผิดพลาดยังไงต้องขออภัย พวกเรามือใหม่ครับ",
    showBillNo: true,
    showTime: true,
    showTable: true,
    showQr: false,
    qrUrl: "",
  },
  kitchen: {
    fontSize: "md",
    showPrice: false,
    showNote: true,
    showTime: true,
    groupByCategory: true,
  },
};

export default async function handler(req, res) {
  if (req.method === "GET") {
    let settings = await redis.get("settings");
    if (!settings) {
      settings = SEED_SETTINGS;
      await redis.set("settings", settings);
    }
    return res.status(200).json({ ...SEED_SETTINGS, ...settings });
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const current = (await redis.get("settings")) || SEED_SETTINGS;
    const merged = { ...current, ...body };
    await redis.set("settings", merged);
    return res.status(200).json({ ok: true, settings: merged });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method not allowed");
}
