package com.jinko.printbridge;

import java.util.List;

final class Ticket {
  final String shopName;
  final String station;
  final String table;
  final String createdAt;
  final String note;
  final int paperWidthDots;
  final List<Item> items;

  Ticket(String shopName, String station, String table, String createdAt, String note,
      int paperWidthDots, List<Item> items) {
    this.shopName = shopName;
    this.station = station;
    this.table = table;
    this.createdAt = createdAt;
    this.note = note;
    this.paperWidthDots = paperWidthDots;
    this.items = items;
  }

  static final class Item {
    final String name;
    final int qty;

    Item(String name, int qty) {
      this.name = name;
      this.qty = qty;
    }
  }
}

