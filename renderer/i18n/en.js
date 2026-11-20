// English: the source. A key is its own English text, so this catalog holds only what a key cannot say by itself:
// the plural forms ({ one, other }, chosen from params.n). Every key here must be a plural in every other catalog.
(typeof I18N !== "undefined" ? I18N : require("../i18n.js")).add("en", {
  "{n} coins": { one: "{n} coin", other: "{n} coins" },
  "{n} transactions": { one: "{n} transaction", other: "{n} transactions" },
  "Split · {n} coins": { one: "Split · {n} coin", other: "Split · {n} coins" },
  "Consolidation · {n} coins": { one: "Consolidation · {n} coin", other: "Consolidation · {n} coins" },
  "Exported {n} transactions ✓": { one: "Exported {n} transaction ✓", other: "Exported {n} transactions ✓" },
  "{n} holds released.": { one: "{n} hold released.", other: "{n} holds released." },
  "● Reachable: {n} incoming peers": { one: "● Reachable: {n} incoming peer", other: "● Reachable: {n} incoming peers" }
});
