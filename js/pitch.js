// Pitch accent for vocabulary, from data/pitch.tsv (Kanjium, CC BY-SA 4.0; see data/LICENSE.md).
// Pure parsing and pattern helpers, no DOM, so they run in node tests too. The app fetches the
// file the first time a word needs it.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Pitch = api;
})(typeof self !== "undefined" ? self : this, function () {
  // One line per word: "word<TAB>reading<TAB>drops". The reading is empty when the word is
  // written in kana. Drops: "2", "0,2", or with part-of-speech labels, "(副)1,(形動)0".
  // Returns Map("word<TAB>reading" -> [drop, ...]).
  function parse(text) {
    const map = new Map();
    for (const line of text.split("\n")) {
      const [word, reading, drops] = line.split("\t");
      if (!word || drops == null) continue;
      const nums = [...new Set((drops.match(/\d+/g) || []).map(Number))];
      if (nums.length) map.set(`${word}\t${reading || word}`, nums);
    }
    return map;
  }

  const lookup = (map, word, reading) => (map && map.get(`${word}\t${reading || word}`)) || [];

  // Small kana join the mora before them: きょう is two morae, きょ and う.
  const SMALL = "ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ";
  function morae(kana) {
    const out = [];
    for (const ch of kana) {
      if (SMALL.includes(ch) && out.length) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }

  // High (true) or low for each mora, and for a particle after the word.
  // 0: low then high, the particle stays high. 1: high then low. n: low, high up to mora n, then low.
  function pattern(count, drop) {
    const d = Math.min(drop, count);
    const high = [];
    for (let i = 1; i <= count; i++) high.push(d === 0 ? i > 1 : d === 1 ? i === 1 : i > 1 && i <= d);
    return { high, particle: d === 0 };
  }

  function kind(count, drop) {
    if (drop === 0) return "heiban";
    if (drop === 1) return "atamadaka";
    return drop >= count ? "odaka" : "nakadaka";
  }

  return { parse, lookup, morae, pattern, kind };
});
