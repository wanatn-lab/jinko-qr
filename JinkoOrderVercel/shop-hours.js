// Shop opening hours for automatic refreshing.
// Pages that poll the server (table status, counter print, admin panels) only ask for
// fresh data while the shop is open. Outside these hours the pages still load once when
// opened, but stop the repeating requests so they don't use up the database quota.
// Hours are Bangkok time: open 11:00 (inclusive) to 21:00 (exclusive).
(function () {
  var OPEN_HOUR = 11;
  var CLOSE_HOUR = 21;
  var TIME_ZONE = "Asia/Bangkok";

  function bangkokHour(date) {
    var parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      hour: "2-digit",
      hour12: false,
    }).format(date);
    return Number(parts) % 24;
  }

  window.isShopOpen = function (date) {
    var hour = bangkokHour(date || new Date());
    return hour >= OPEN_HOUR && hour < CLOSE_HOUR;
  };
})();
