package com.jinko.printbridge;

import java.util.List;

/** Immutable checkout snapshot created by the admin API before a table is cleared. */
final class Receipt {
  final String id;
  final String shopName;
  final String phone;
  final String table;
  final String createdAt;
  final String billNo;
  final String title;
  final String shopAddress;
  final String taxId;
  final String thanksText;
  final String apologyText;
  final boolean showBillNo;
  final boolean showTime;
  final boolean showTable;
  final boolean showQr;
  final String qrUrl;
  final String logoUrl;
  final int paperWidthDots;
  final List<Item> items;
  final double total;

  Receipt(String id, String shopName, String phone, String table, String createdAt,
      String billNo, String title, String shopAddress, String taxId, String thanksText,
      String apologyText, boolean showBillNo, boolean showTime, boolean showTable, boolean showQr,
      String qrUrl, String logoUrl,
      int paperWidthDots, List<Item> items, double total) {
    this.id = id;
    this.shopName = shopName;
    this.phone = phone;
    this.table = table;
    this.createdAt = createdAt;
    this.billNo = billNo;
    this.title = title;
    this.shopAddress = shopAddress;
    this.taxId = taxId;
    this.thanksText = thanksText;
    this.apologyText = apologyText;
    this.showBillNo = showBillNo;
    this.showTime = showTime;
    this.showTable = showTable;
    this.showQr = showQr;
    this.qrUrl = qrUrl;
    this.logoUrl = logoUrl;
    this.paperWidthDots = paperWidthDots;
    this.items = items;
    this.total = total;
  }

  static final class Item {
    final String name;
    final int qty;
    final double lineTotal;

    Item(String name, int qty, double lineTotal) {
      this.name = name;
      this.qty = qty;
      this.lineTotal = lineTotal;
    }
  }
}
