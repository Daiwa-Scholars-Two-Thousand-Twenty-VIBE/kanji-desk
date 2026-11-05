# Data licence

`pitch.tsv` and `keisei.json` come from the Kanjium database by Uros O.
(https://github.com/mifunetoshiro/kanjium), commit `9ebca45`, built by `tools/build_data.py`.

The pitch accent notation, verb particle data, phonetics, homonyms and other additions or
modifications to EDICT, KANJIDIC or KRADFILE were provided by Uros O. through his free database.

Both files are licensed under the Creative Commons Attribution-ShareAlike 4.0 International
licence: https://creativecommons.org/licenses/by-sa/4.0/

- `pitch.tsv` is Kanjium's `accents.txt` unchanged: word, reading (empty for words written in
  kana), and the mora after which the pitch drops (0 = no drop).
- `keisei.json` is reshaped from Kanjium's `phonetics.txt` and `kanjidict.txt`: for each kanji
  its phonetic (sound) component and kind, and for each component its readings in hiragana.
  Components Kanjium draws as private-use images are left out.

Kanjium itself draws on EDICT and KANJIDIC by the Electronic Dictionary Research and
Development Group, used under the group's licence (https://www.edrdg.org/edrdg/licence.html).
