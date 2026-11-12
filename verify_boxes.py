"""Verify the panel translation pipeline on specific reading-order IDs.

Usage:
    python verify_boxes.py panel.png 15,17

Checks for each requested ID:
  - #15: Japanese contains 先生, English non-empty, question false, garbled false
  - #17: Japanese contains 興奮, English asks why/what got the listener worked up
         (a bare '?' is not enough), question true, garbled false

Also tests the garbled-detection path on a synthetic noise line.
Prints PASS/FAIL per check and exits non-zero if anything fails.
"""
import argparse
import sys

from test_panel import run_pipeline, translate_line


def check(label, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    line = f"[{status}] {label}"
    if detail:
        line += f" -- {detail}"
    print(line)
    return ok


def box17_en_ok(en):
    """Box 17 must ask WHY/WHAT got the listener worked up, not just end in '?'.

    Requires a question word (why/what) AND a 'worked up' phrase, applied to the
    listener. A lone question mark is insufficient.
    """
    text = en.lower()
    has_wh = "why" in text or "what" in text
    worked_up = any(
        phrase in text
        for phrase in ("excited", "worked up", "worked-up", "going on", "hyped", "stoked", "pumped")
    )
    return has_wh and worked_up


def verify_id(rows, expected_id, ja_needle, en_checker, expect_question):
    row = next((r for r in rows if r["id"] == expected_id), None)
    if row is None:
        return check(f"#{expected_id} present", False, "id not found in output")

    en = row["en"]
    ok = True
    ok &= check(
        f"#{expected_id} JA contains '{ja_needle}'",
        ja_needle in row["ja"],
        f"ja={row['ja']!r}",
    )
    ok &= check(
        f"#{expected_id} EN non-empty",
        bool(en.strip()),
        f"en={en!r}",
    )
    if en_checker is not None:
        ok &= check(
            f"#{expected_id} EN passes semantic check",
            en_checker(en),
            f"en={en!r}",
        )
    ok &= check(
        f"#{expected_id} question flag == {expect_question}",
        row["question"] is expect_question,
        f"question={row['question']}",
    )
    ok &= check(
        f"#{expected_id} garbled flag == False",
        row["garbled"] is False,
        f"garbled={row['garbled']}",
    )
    return ok


def main():
    parser = argparse.ArgumentParser(description="Verify panel translation IDs.")
    parser.add_argument("image", help="path to the panel image", nargs="?", default="panel.png")
    parser.add_argument(
        "ids",
        help="comma-separated reading-order IDs (default: 15,17)",
        nargs="?",
        default="15,17",
    )
    args = parser.parse_args()

    ids = [int(t) for t in args.ids.split(",") if t.strip()]
    print(f"Running pipeline on {args.image} ...")
    result = run_pipeline(args.image)
    rows = result["translations"]
    print(f"Detected {len(rows)} lines.")

    all_ok = True
    for row in rows:
        print(f"  #{row['id']:>3}  qa={row['question']} garbled={row['garbled']}  "
              f"ja={row['ja']!r}  en={row['en']!r}")

    print()
    checks = {
        15: ("先生", None, False),
        17: ("興奮", box17_en_ok, True),
    }
    for expected_id in ids:
        spec = checks.get(expected_id)
        if spec is None:
            print(f"(no assertions defined for #{expected_id}; skipping checks)")
            continue
        ja_needle, en_checker, expect_question = spec
        if not verify_id(rows, expected_id, ja_needle, en_checker, expect_question):
            all_ok = False

    print()
    print("Garbled-detection test ...")
    garbled_line = "a8f3 7kx qwe! 3m z9"
    entry = translate_line(garbled_line)
    ok = check(
        "garbled line flagged garbled=True",
        entry["garbled"] is True,
        f"got={entry}",
    )
    ok &= check(
        "garbled line has empty EN",
        entry["en"] == "",
        f"en={entry['en']!r}",
    )
    all_ok &= ok

    print()
    if all_ok:
        print("ALL CHECKS PASSED")
    else:
        print("SOME CHECKS FAILED")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
