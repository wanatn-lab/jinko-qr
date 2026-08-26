package com.jinko.printbridge;

import java.util.List;

/** Immutable checkout snapshot created by the admin API before a table is cleared. */
final class Receipt {
  final String id;
  final String shopName;
  final String phone;
  final String table;
  final String createdAt;
  final int paperWidthDots;
  final List<Item> items;
  final double total;

  Receipt(String id, String shopName, String phone, String table, String createdAt,
      int paperWidthDots, List<Item> items, double total) {
    this.id = id;
    this.shopName = shopName;
    this.phone = phone;
    this.table = table;
    this.createdAt = createdAt;
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

