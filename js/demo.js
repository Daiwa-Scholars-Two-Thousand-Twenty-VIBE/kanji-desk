// A tiny made-up data set in the shape the WaniKani API returns. It powers the demo
// (try the app without a token; nothing is ever sent) and the tests.
// All mnemonics and sentences here are original, written for this demo.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Demo = api;
})(typeof self !== "undefined" ? self : this, function () {
  const M = (meaning, primary = false) => ({ meaning, primary, accepted_answer: true });
  const R = (reading, type, primary, accepted) => ({ reading, type, primary, accepted_answer: accepted });
  const VR = (reading, primary = true) => ({ reading, primary, accepted_answer: true });

  function subject(id, object, level, position, data) {
    return {
      id,
      object,
      data_updated_at: "2026-01-01T00:00:00.000000Z",
      data: Object.assign(
        {
          level,
          lesson_position: position,
          slug: data.characters || "",
          hidden_at: null,
          auxiliary_meanings: [],
          amalgamation_subject_ids: [],
          component_subject_ids: [],
          meaning_hint: null,
          reading_hint: null,
          spaced_repetition_system_id: 1,
        },
        data,
      ),
    };
  }

  const SUBJECTS = [
    subject(1, "radical", 1, 0, { characters: "一", meanings: [M("Ground", true)], amalgamation_subject_ids: [12, 14], character_images: [],
      meaning_mnemonic: "One flat line, like the <radical>ground</radical> you stand on." }),
    subject(2, "radical", 1, 1, { characters: "口", meanings: [M("Mouth", true)], amalgamation_subject_ids: [10], character_images: [],
      meaning_mnemonic: "A square hole that opens and shuts: a <radical>mouth</radical>." }),
    subject(3, "radical", 1, 2, { characters: "日", meanings: [M("Sun", true)], amalgamation_subject_ids: [11, 12, 17], character_images: [],
      meaning_mnemonic: "A window with one bar across it, and the <radical>sun</radical> shining through." }),
    subject(4, "radical", 1, 3, { characters: "木", meanings: [M("Tree", true)], amalgamation_subject_ids: [14, 15], character_images: [],
      meaning_mnemonic: "A trunk, two branches and roots: a <radical>tree</radical>." }),
    subject(5, "radical", 1, 4, { characters: "人", meanings: [M("Person", true)], amalgamation_subject_ids: [13], character_images: [],
      meaning_mnemonic: "Two legs walking: a <radical>person</radical>." }),
    subject(6, "radical", 3, 4, { characters: "青", meanings: [M("Blue", true)], amalgamation_subject_ids: [16, 17], character_images: [],
      meaning_mnemonic: "New leaves over a full moon, and the whole night sky turns <radical>blue</radical>." }),

    subject(10, "kanji", 1, 5, { characters: "口", meanings: [M("Mouth", true)], component_subject_ids: [2], amalgamation_subject_ids: [20],
      visually_similar_subject_ids: [11, 12],
      readings: [R("こう", "onyomi", true, true), R("く", "onyomi", false, true), R("くち", "kunyomi", false, false)],
      meaning_mnemonic: "The <radical>mouth</radical> radical on its own is the <kanji>mouth</kanji> kanji.",
      reading_mnemonic: "Your <kanji>mouth</kanji> makes a <reading>こう</reading> sound when you cough.",
      reading_hint: "Picture a cough every time you see this box." }),
    subject(11, "kanji", 1, 6, { characters: "日", meanings: [M("Sun", true), M("Day")], component_subject_ids: [3], amalgamation_subject_ids: [21],
      visually_similar_subject_ids: [10, 12],
      readings: [R("にち", "onyomi", true, true), R("じつ", "onyomi", false, true), R("ひ", "kunyomi", false, false), R("か", "kunyomi", false, false)],
      meaning_mnemonic: "The <radical>sun</radical> rises once a <kanji>day</kanji>, so this kanji is both <kanji>sun</kanji> and <kanji>day</kanji>.",
      reading_mnemonic: "Every <kanji>day</kanji> the sun grins: <reading>にち</reading>!" }),
    subject(12, "kanji", 2, 0, { characters: "目", meanings: [M("Eye", true)], component_subject_ids: [3, 1], amalgamation_subject_ids: [23],
      visually_similar_subject_ids: [11],
      readings: [R("もく", "onyomi", true, true), R("め", "kunyomi", false, false)],
      meaning_mnemonic: "A <radical>sun</radical> stacked on the <radical>ground</radical> looks like a tall <kanji>eye</kanji>.",
      reading_mnemonic: "Your <kanji>eye</kanji> waters when you stare at a <reading>もく</reading>-ing bird." }),
    subject(13, "kanji", 2, 1, { characters: "人", meanings: [M("Person", true)], component_subject_ids: [5], amalgamation_subject_ids: [20, 22],
      auxiliary_meanings: [{ meaning: "People", type: "whitelist" }, { meaning: "Man", type: "blacklist" }],
      visually_similar_subject_ids: [],
      readings: [R("じん", "onyomi", true, true), R("にん", "onyomi", false, true), R("ひと", "kunyomi", false, false)],
      meaning_mnemonic: "The <radical>person</radical> radical and the <kanji>person</kanji> kanji are the same shape.",
      reading_mnemonic: "A <kanji>person</kanji> drinks <reading>じん</reading> (gin)." }),
    subject(14, "kanji", 2, 2, { characters: "本", meanings: [M("Book", true), M("Origin")], component_subject_ids: [4, 1], amalgamation_subject_ids: [21],
      visually_similar_subject_ids: [15],
      readings: [R("ほん", "onyomi", true, true), R("もと", "kunyomi", false, false)],
      meaning_mnemonic: "A <radical>tree</radical> with a mark at its <radical>ground</radical> line is where paper, and every <kanji>book</kanji>, comes from.",
      reading_mnemonic: "A <kanji>book</kanji> is a <reading>ほん</reading>, the word you already know." }),
    subject(15, "kanji", 2, 3, { characters: "木", meanings: [M("Tree", true), M("Wood")], component_subject_ids: [4], amalgamation_subject_ids: [23],
      visually_similar_subject_ids: [14],
      readings: [R("き", "kunyomi", true, true), R("もく", "onyomi", false, false)],
      meaning_mnemonic: "The <radical>tree</radical> radical is the <kanji>tree</kanji> kanji.",
      reading_mnemonic: "A <kanji>tree</kanji> is a key (<reading>き</reading>) to shade." }),
    subject(16, "kanji", 3, 5, { characters: "青", meanings: [M("Blue", true)], component_subject_ids: [6], amalgamation_subject_ids: [],
      visually_similar_subject_ids: [],
      readings: [R("せい", "onyomi", true, true), R("しょう", "onyomi", false, false), R("あお", "kunyomi", false, false)],
      meaning_mnemonic: "The <radical>blue</radical> radical is the <kanji>blue</kanji> kanji.",
      reading_mnemonic: "A <kanji>blue</kanji> sail (<reading>せい</reading>l) on a calm sea." }),
    subject(17, "kanji", 3, 6, { characters: "晴", meanings: [M("Clear Up", true), M("Sunny")], component_subject_ids: [3, 6], amalgamation_subject_ids: [],
      visually_similar_subject_ids: [],
      readings: [R("せい", "onyomi", true, true), R("は", "kunyomi", false, false)],
      meaning_mnemonic: "The <radical>sun</radical> comes out and the sky goes <radical>blue</radical>: the weather has <kanji>cleared up</kanji>.",
      reading_mnemonic: "When it <kanji>clears up</kanji>, every boat sets <reading>せい</reading>l." }),

    subject(20, "vocabulary", 2, 4, { characters: "人口", meanings: [M("Population", true)], component_subject_ids: [13, 10],
      readings: [VR("じんこう")], parts_of_speech: ["noun"],
      meaning_mnemonic: "How many <kanji>person</kanji> <kanji>mouth</kanji>s a place must feed: its <vocabulary>population</vocabulary>.",
      reading_mnemonic: "Both kanji use their on'yomi: <reading>じん</reading> + <reading>こう</reading>.",
      context_sentences: [
        { ja: "この町の人口は少しずつ増えている。", en: "This town's population is slowly growing." },
        { ja: "東京は人口が多い。", en: "Tokyo has a large population." },
      ],
      pronunciation_audios: [] }),
    subject(21, "vocabulary", 3, 0, { characters: "日本", meanings: [M("Japan", true)], component_subject_ids: [11, 14],
      readings: [VR("にほん"), VR("にっぽん", false)], parts_of_speech: ["proper noun"],
      meaning_mnemonic: "The <kanji>origin</kanji> of the <kanji>sun</kanji>: <vocabulary>Japan</vocabulary>.",
      reading_mnemonic: "You already know this one: <reading>にほん</reading>.",
      context_sentences: [{ ja: "日本の夏は暑い。", en: "Summer in Japan is hot." }],
      pronunciation_audios: [] }),
    subject(22, "vocabulary", 3, 1, { characters: "一人", meanings: [M("One Person", true), M("Alone")], component_subject_ids: [13],
      readings: [VR("ひとり")], parts_of_speech: ["noun", "adverb"],
      meaning_mnemonic: "One <kanji>person</kanji>: <vocabulary>one person</vocabulary>, or someone <vocabulary>alone</vocabulary>.",
      reading_mnemonic: "This reading is a one-off. Learn <reading>ひとり</reading> as it is.",
      context_sentences: [{ ja: "昨日は一人で映画を見た。", en: "I watched a film alone yesterday." }],
      pronunciation_audios: [] }),
    subject(23, "vocabulary", 3, 2, { characters: "木目", meanings: [M("Wood Grain", true)], component_subject_ids: [15, 12],
      readings: [VR("もくめ")], parts_of_speech: ["noun"],
      meaning_mnemonic: "The <kanji>eye</kanji>s in a <kanji>tree</kanji>: its <vocabulary>wood grain</vocabulary>.",
      reading_mnemonic: "<reading>もく</reading> + <reading>め</reading>.",
      context_sentences: [{ ja: "このテーブルは木目がきれいだ。", en: "This table has beautiful wood grain." }],
      pronunciation_audios: [] }),

    subject(30, "kana_vocabulary", 3, 3, { characters: "ゆっくり", meanings: [M("Slowly", true)],
      parts_of_speech: ["adverb"],
      meaning_mnemonic: "Say it slowly and it even sounds slow: <vocabulary>ゆっくり</vocabulary>.",
      context_sentences: [{ ja: "もう少しゆっくり話してください。", en: "Please speak a little more slowly." }],
      pronunciation_audios: [] }),
  ];

  // Builds the full data set with times relative to `now` (ms).
  function build(now) {
    const iso = (ms) => new Date(ms).toISOString();
    const HOUR = 3600e3;
    // [subject id, srs stage, available in hours (null = lesson)]
    const plan = [
      [1, 6, -30], [2, 5, -2], [3, 7, -100], [4, 5, -1], [5, 4, 3],
      [10, 3, -5], [11, 2, -1], [12, 2, -20], [13, 4, -3], [15, 1, -1],
      [20, 1, -2], [22, 3, 7], [23, 1, 26],
      [14, 0, null], [21, 0, null], [30, 0, null],
    ];
    const assignments = plan.map(([sid, stage, hours]) => {
      const s = SUBJECTS.find((x) => x.id === sid);
      const lesson = hours === null;
      return {
        id: 1000 + sid,
        object: "assignment",
        data_updated_at: iso(now - HOUR),
        data: {
          created_at: iso(now - 90 * 24 * HOUR),
          subject_id: sid,
          subject_type: s.object,
          srs_stage: stage,
          unlocked_at: iso(now - 10 * 24 * HOUR),
          started_at: lesson ? null : iso(now - 9 * 24 * HOUR),
          passed_at: stage >= 5 ? iso(now - 5 * 24 * HOUR) : null,
          burned_at: null,
          available_at: lesson ? null : iso(now + hours * HOUR),
          resurrected_at: null,
          hidden: false,
        },
      };
    });
    const user = {
      object: "user",
      data: {
        username: "demo",
        level: 3,
        subscription: { active: true, type: "recurring", max_level_granted: 60 },
        preferences: { lessons_batch_size: 3, reviews_autoplay_audio: false, lessons_autoplay_audio: false },
      },
    };
    const study_materials = [
      { id: 7013, object: "study_material", data: { subject_id: 13, subject_type: "kanji", meaning_synonyms: ["human"], meaning_note: "Looks like legs walking.", reading_note: null, hidden: false } },
    ];
    const stat = (id, sid, type, mc, mi, ms, rc, ri, rs) => ({
      id, object: "review_statistic",
      data: { subject_id: sid, subject_type: type, meaning_correct: mc, meaning_incorrect: mi, meaning_current_streak: ms, meaning_max_streak: ms,
        reading_correct: rc, reading_incorrect: ri, reading_current_streak: rs, reading_max_streak: rs,
        percentage_correct: Math.round((100 * (mc + rc)) / Math.max(1, mc + mi + rc + ri)), hidden: false },
    });
    const review_statistics = [
      stat(5012, 12, "kanji", 6, 5, 1, 4, 6, 1),
      stat(5011, 11, "kanji", 5, 1, 3, 5, 0, 4),
      stat(5020, 20, "vocabulary", 2, 0, 2, 1, 3, 1),
    ];
    const DAY = 24 * HOUR;
    // Levels 1 and 2 passed, level 3 under way.
    const level_progressions = [[1, 30, 21], [2, 21, 12], [3, 12, null]].map(([level, from, to]) => ({
      id: 9000 + level,
      object: "level_progression",
      data: {
        level,
        created_at: iso(now - from * DAY),
        unlocked_at: iso(now - from * DAY),
        started_at: iso(now - from * DAY + 2 * HOUR),
        passed_at: to === null ? null : iso(now - to * DAY),
        completed_at: null,
        abandoned_at: null,
      },
    }));
    return { user, subjects: SUBJECTS, assignments, study_materials, review_statistics, level_progressions };
  }

  return { SUBJECTS, build };
});
