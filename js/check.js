// Answer checking. Pure functions, no DOM, so they run in node tests too.
//
// Follows the rules WaniKani's own checker is known to use:
// - Meanings: your synonyms, the subject's accepted meanings and its whitelist all count.
//   A blacklisted meaning is wrong even when it is close to a right one. Small typos pass
//   ("close"), with more slack for longer words.
// - Readings: kana only. For kanji, a real reading that is not the one being taught
//   (say the kun'yomi when the lesson taught the on'yomi) is "other": the box shakes and
//   nothing is counted, like on the site.
// - The wrong language for the box is "invalid": shake, nothing counted, and a "Not quite"
//   note says what was typed. In the meaning box that is Japanese, or the item's reading in
//   romaji. In the reading box it is the item's meaning in English (small typos too), which the
//   kana box turns into kana as you type, or letters that cannot become kana.
(function (root, factory) {
  const W = typeof module === "object" && module.exports ? require("../vendor/wanakana.min.js") : root.wanakana;
  const api = factory(W);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Check = api;
})(typeof self !== "undefined" ? self : this, function (W) {
  // Subjects that are only asked for their meaning.
  const MEANING_ONLY = new Set(["radical", "kana_vocabulary"]);
  const questionsFor = (subject) => (MEANING_ONLY.has(subject.object) ? ["meaning"] : ["meaning", "reading"]);

  function normalizeMeaning(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/-/g, " ")
      .replace(/[.'/]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Kana typed or converted from romaji, as hiragana with no spaces. A trailing "n" becomes ん.
  function normalizeReading(s) {
    return W.toHiragana(String(s || "").replace(/\s+/g, "").trim());
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // How many typos an accepted answer of this length forgives.
  function tolerance(len) {
    if (len <= 3) return 0;
    if (len <= 5) return 1;
    if (len <= 7) return 2;
    return 2 + Math.floor(len / 7);
  }

  const hasJapanese = (s) => /[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(s);

  // Every meaning that counts as right, primary first.
  function acceptedMeanings(subject, synonyms) {
    const d = subject.data;
    const out = [];
    for (const m of d.meanings || []) if (m.accepted_answer) out.push(m.meaning);
    for (const a of d.auxiliary_meanings || []) if (a.type === "whitelist") out.push(a.meaning);
    for (const s of synonyms || []) out.push(s);
    return out;
  }

  const NOT_MEANING = "Not quite: that is the reading. We want the meaning.";
  const NOT_READING = "Not quite: that is the meaning in English. We want the reading.";

  // Is this one of the item's readings, typed in kana or in romaji?
  function isItsReading(subject, raw) {
    const given = normalizeReading(raw.toLowerCase());
    return W.isKana(given) && (subject.data.readings || []).some((r) => normalizeReading(r.reading) === given);
  }

  // Is this the item's meaning, turned into kana the way the reading box turns it as you type?
  // ("population" arrives as ぽぷらちおん, "tree" as tれえ.) Small typos count, as for meanings.
  function isItsMeaning(subject, given, synonyms) {
    return acceptedMeanings(subject, synonyms).some((m) => {
      const k = normalizeReading(normalizeMeaning(m));
      return k && levenshtein(k, given) <= tolerance(k.length);
    });
  }

  // -> { result: "exact" | "close" | "wrong" | "invalid", matched?, message? }
  function checkMeaning(subject, answer, synonyms) {
    const raw = String(answer || "").trim();
    if (!raw) return { result: "invalid", message: "Type an answer first." };
    if (hasJapanese(raw)) return { result: "invalid", message: isItsReading(subject, raw) ? NOT_MEANING : "Not quite: that is Japanese. We want the meaning, in English." };
    const given = normalizeMeaning(raw);
    if (!given) return { result: "invalid", message: "Type an answer first." };
    const accepted = acceptedMeanings(subject, synonyms);
    for (const m of accepted) if (normalizeMeaning(m) === given) return { result: "exact", matched: m };
    // After the exact check, so a meaning that is also a reading in romaji ("sake") still counts.
    if (isItsReading(subject, raw)) return { result: "invalid", message: NOT_MEANING };
    for (const a of subject.data.auxiliary_meanings || []) {
      if (a.type === "blacklist" && normalizeMeaning(a.meaning) === given) return { result: "wrong" };
    }
    let best = null;
    for (const m of accepted) {
      const norm = normalizeMeaning(m);
      const dist = levenshtein(norm, given);
      if (dist <= tolerance(norm.length) && (!best || dist < best.dist)) best = { m, dist };
    }
    if (best) return { result: "close", matched: best.m, message: `A bit off. The answer is “${best.m}”.` };
    return { result: "wrong" };
  }

  const READING_NAME = { onyomi: "on'yomi", kunyomi: "kun'yomi", nanori: "nanori" };

  // -> { result: "exact" | "wrong" | "invalid" | "other", matched?, message? }
  function checkReading(subject, answer, synonyms) {
    const raw = String(answer || "").trim();
    if (!raw) return { result: "invalid", message: "Type an answer first." };
    const given = normalizeReading(raw);
    const kana = W.isKana(given);
    const readings = subject.data.readings || [];
    if (kana) {
      for (const r of readings) {
        if (r.accepted_answer && normalizeReading(r.reading) === given) return { result: "exact", matched: r.reading };
      }
      if (subject.object === "kanji") {
        for (const r of readings) {
          if (!r.accepted_answer && normalizeReading(r.reading) === given) {
            const want = readings.find((x) => x.primary) || readings.find((x) => x.accepted_answer);
            const name = want && READING_NAME[want.type];
            return { result: "other", message: name ? `That is a reading, but we want the ${name}.` : "That is a reading, but not the one we want." };
          }
        }
      }
    }
    // After the readings, so a reading that spells an English meaning in romaji (さけ, "sake") still counts.
    if (isItsMeaning(subject, given, synonyms)) return { result: "invalid", message: NOT_READING };
    if (!kana) return { result: "invalid", message: /[a-z]/i.test(given) ? "Not quite: that looks like English. We want the reading, in kana." : "Type the reading in kana." };
    return { result: "wrong" };
  }

  // "exact" and "close" count as right. "invalid" and "other" do not count either way.
  const counts = (r) => r === "exact" || r === "close" || r === "wrong";
  const isRight = (r) => r === "exact" || r === "close";

  function check(subject, kind, answer, synonyms) {
    return kind === "reading" ? checkReading(subject, answer, synonyms) : checkMeaning(subject, answer, synonyms);
  }

  return {
    questionsFor, normalizeMeaning, normalizeReading, levenshtein, tolerance,
    acceptedMeanings, checkMeaning, checkReading, check, counts, isRight,
  };
});
