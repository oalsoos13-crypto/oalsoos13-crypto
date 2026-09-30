/* Arabic -> English glossary translator (shared by the browser and the server).
   Order: exact string -> multi-word phrases (longest first) -> single words
   (with common prefixes stripped) -> small word-order touch-ups. Anything not
   in the glossary is left as typed. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.ArEn = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var AR = /[؀-ۿ]/;
  var AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
  function latinDigits(s) { return String(s || "").replace(/[٠-٩]/g, function (d) { return String(AR_DIGITS.indexOf(d)); }); }
  // Normalise tatweel, Arabic punctuation and spacing before matching.
  function norm(s) {
    return latinDigits(String(s == null ? "" : s))
      .replace(/ـ/g, "").replace(/[،]/g, ",").replace(/[؛]/g, ";").replace(/[؟]/g, "?")
      .replace(/\s+/g, " ").trim();
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  var PREFIXES = [["وبال", "and with the "], ["ولل", "and for the "], ["وال", "and the "], ["بال", "with the "], ["فال", "then the "], ["كال", "like the "], ["لل", "for the "], ["ال", "the "], ["و", "and "], ["ب", "with "], ["ل", "for "], ["ف", "then "], ["ك", "like "]];
  var MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Ramadan|Eid";
  function make(glossary) {
    glossary = glossary || {};
    var exact = {}, k;
    for (k in glossary.exact || {}) exact[norm(k)] = glossary.exact[k];
    var words = {};
    for (k in glossary.words || {}) words[norm(k)] = glossary.words[k];
    var phraseKeys = Object.keys(glossary.phrases || {}).map(norm).filter(Boolean);
    phraseKeys.sort(function (a, b) { return b.length - a.length; });
    var phrases = {};
    for (k in glossary.phrases || {}) phrases[norm(k)] = glossary.phrases[k];
    var phraseRe = phraseKeys.length ? new RegExp("(^|[^\\u0600-\\u06FF])(" + phraseKeys.map(escRe).join("|") + ")(?![\\u0600-\\u06FF])", "g") : null;
    function word(w) {
      if (words[w] != null) return words[w];
      // strip a trailing punctuation mark glued to the word
      var m = /^([؀-ۿ]+)([,;:.!?)]+)$/.exec(w);
      if (m && words[m[1]] != null) return words[m[1]] + m[2];
      for (var i = 0; i < PREFIXES.length; i++) {
        var p = PREFIXES[i][0];
        if (w.length > p.length + 1 && w.indexOf(p) === 0 && words[w.slice(p.length)] != null) return PREFIXES[i][1] + words[w.slice(p.length)];
      }
      return null;
    }
    function translate(s) {
      s = norm(s);
      if (!s || !AR.test(s)) return s;
      if (exact[s] != null) return exact[s];
      var out = phraseRe ? s.replace(phraseRe, function (_, pre, ph) { return pre + "\u0001" + phrases[ph] + "\u0001"; }) : s;
      out = out.split(/(\s+)/).map(function (tok) {
        if (!AR.test(tok)) return tok;
        // token may carry brackets or slashes: translate the Arabic runs inside
        return tok.replace(/[؀-ۿ]+[,;:.!?)]*/g, function (w) { var t = word(w); return t == null ? w : t; });
      }).join("");
      out = out.replace(/\u0001/g, "");
      // touch-ups
      out = out.replace(new RegExp("\\bfestival (" + MONTHS + ")\\b", "g"), "$1 festival")
        .replace(/\brent (\d+) (stand|pallet)\b/g, function (m, q, w) { return "rent of " + q + " " + w + (q === "1" ? "" : "s"); })
        .replace(/\bqty \(([\d.]+)\)/g, "($1)").replace(/\bqty ([\d.]+)\b/g, "$1 ×")
        .replace(/\b(\d+(?:\.\d+)?) (linear )?(metre|bay|gondola|pallet|stand|piece|shelf|instalment|branch|column|basket|fridge)\b(?!s)/g, function (m, q, lin, w) { return q === "1" ? m : q + " " + (lin || "") + w + "s"; })
        .replace(/\s+([,;:.)])/g, "$1").replace(/\(\s+/g, "(").replace(/\s{2,}/g, " ").trim();
      if (out && /^[a-z]/.test(out)) out = out.charAt(0).toUpperCase() + out.slice(1);
      return out;
    }
    return { translate: translate, norm: norm, hasArabic: function (s) { return AR.test(String(s || "")); } };
  }
  return { make: make, norm: norm, latinDigits: latinDigits };
});
