#!/usr/bin/env python3
"""Builds data/pitch.tsv and data/keisei.json from the Kanjium database.

Kanjium (https://github.com/mifunetoshiro/kanjium) is CC BY-SA 4.0. The pitch accent
notation and the phonetic components are Uros O.'s additions to it. Both output files stay
under CC BY-SA 4.0; see data/LICENSE.md.

    python3 -I tools/build_data.py          # run from the repo root

Pinned to one commit so a rebuild gives the same files.
"""
import json
import os
import sys
import urllib.request

COMMIT = "9ebca4589565c696e7c39e089e2e928ad65f678c"
BASE = f"https://raw.githubusercontent.com/mifunetoshiro/kanjium/{COMMIT}/data/source_files/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

KANJIDICT_COLS = ("kanji radical radvar phonetic idc type reg_on reg_kun onyomi kunyomi nanori strokes grade "
                  "jlpt kanken frequency meaning compact_meaning rtk1_3_old rtk1_3_new ko2001 ko2301 wrp_jkf wanikani").split()
KANJI_TYPE = {"Phono-semantic compound": "ps", "Compound ideograph": "ci", "Pictograph": "pi", "Ideograph": "id"}
PHONETIC_TYPE = {"Single-reading phonetic": "s", "Mixed-reading phonetic": "m"}


def fetch(name):
    with urllib.request.urlopen(BASE + name) as r:
        return r.read().decode("utf-8")


def hira(text):
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in text)


def private(ch):
    return any(0xE000 <= ord(c) <= 0xF8FF for c in ch)


def main():
    os.makedirs(OUT, exist_ok=True)

    # Pitch: word, reading (empty when the word is kana), downstep positions. Kept as it is.
    accents = fetch("raw/accents.txt")
    with open(os.path.join(OUT, "pitch.tsv"), "w", encoding="utf-8", newline="\n") as f:
        f.write(accents if accents.endswith("\n") else accents + "\n")

    # Sound parts: per kanji its phonetic component and kind; per component its readings.
    phon = {}
    for line in fetch("phonetics.txt").splitlines():
        p, readings, _count, kind = line.split("\t")
        if private(p):
            continue
        phon[p] = [hira(readings).split("、"), PHONETIC_TYPE.get(kind, "")]
    kanji = {}
    for line in fetch("kanjidict.txt").splitlines():
        row = dict(zip(KANJIDICT_COLS, line.split("\t")))
        p = row["phonetic"]
        if p and p in phon:
            kanji[row["kanji"]] = [p, KANJI_TYPE.get(row["type"], "")]
    data = {"source": f"kanjium@{COMMIT[:7]}, CC BY-SA 4.0", "phonetics": phon, "kanji": kanji}
    with open(os.path.join(OUT, "keisei.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"pitch.tsv: {accents.count(chr(10))} words · keisei.json: {len(kanji)} kanji, {len(phon)} sound parts", file=sys.stderr)


if __name__ == "__main__":
    main()
