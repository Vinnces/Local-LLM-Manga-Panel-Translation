import argparse
import json
import os
import statistics
import sys
from urllib.request import Request, urlopen

from PIL import Image, ImageDraw

from manga_ocr import MangaOcr

MODEL_NAME = "qwen3.8:27b-q4_K_M"
OLLAMA_URL = "http://127.0.0.1:11434/api/chat"


def get_boxes(result):
    """Extract (x0, y0, x1, y1) boxes from a PaddleOCR 3.x TextDetection result.

    Tries several attribute names so it works across minor 3.x versions.
    """
    obj = result
    if isinstance(result, list):
        obj = result[0]

    candidates = (
        "dt_boxes", "boxes", "dt_polys", "polygons", "dt_polys_list",
        "rec_polys", "text_polys",
    )

    polys = None
    for name in candidates:
        if isinstance(obj, dict) and name in obj:
            polys = obj[name]
            break
        if hasattr(obj, name):
            polys = getattr(obj, name)
            break

    if polys is None:
        raise SystemExit(
            "Could not find detected boxes in PaddleOCR result. "
            "Result keys/attrs: "
            f"{sorted(obj.keys()) if isinstance(obj, dict) else dir(obj)}"
        )

    boxes = []
    for poly in polys:
        poly = list(poly)
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        boxes.append((min(xs), min(ys), max(xs), max(ys)))
    return boxes


def _group_indices(boxes):
    """Merge side-by-side, similar-width text columns into groups.

    Returns a list of groups, each a sorted list of raw-box indices (in the
    order of the input ``boxes``). Only columns of similar width are paired, so
    wide stylized text is left out. Slight horizontal overlap between
    neighboring vertical columns is allowed, but a shared vertical overlap is
    still required. Pairs are tried most-similar-width / tightest first. If a
    merge fails the width or vertical-band limits, the existing group is kept
    and the extra box stays standalone.
    """
    if not boxes:
        return []

    n = len(boxes)
    w = [b[2] - b[0] for b in boxes]
    w_med = statistics.median(w) or 1.0
    max_gap = max(8.0, 2.0 * w_med)
    max_width = max(6.0 * w_med, 60.0)
    min_ratio = 0.6

    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            a, b = boxes[i], boxes[j]
            similar_w = min(w[i], w[j])
            if similar_w <= 0:
                continue
            width_ratio = similar_w / max(w[i], w[j])
            if width_ratio < min_ratio:
                continue
            h_gap = max(a[0] - b[2], b[0] - a[2])
            if h_gap < -0.5 * similar_w or h_gap > max_gap:
                continue
            short = min(a[3] - a[1], b[3] - b[1])
            if short <= 0:
                continue
            v_overlap = min(a[3], b[3]) - max(a[1], b[1])
            if v_overlap < 0.5 * short:
                continue
            pairs.append((-width_ratio, h_gap, i, j))
    pairs.sort()

    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def cluster(root):
        return [boxes[i] for i in range(n) if find(i) == root]

    def fits(group):
        if max(b[2] for b in group) - min(b[0] for b in group) > max_width:
            return False
        band = min(b[3] for b in group) - max(b[1] for b in group)
        return band >= 0.3 * min(b[3] - b[1] for b in group)

    for _, _, i, j in pairs:
        ri, rj = find(i), find(j)
        if ri == rj:
            continue
        if not fits(cluster(ri) + cluster(rj)):
            continue
        parent[ri] = rj

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    lists = [sorted(idx) for idx in groups.values()]
    lists.sort(key=lambda idx: (min(boxes[i][1] for i in idx),
                                -max(boxes[i][0] for i in idx)))
    return lists


def group_columns(boxes):
    """Return merged bubble regions as (x0, y0, x1, y1), in reading order."""
    return [
        (
            min(boxes[i][0] for i in idx),
            min(boxes[i][1] for i in idx),
            max(boxes[i][2] for i in idx),
            max(boxes[i][3] for i in idx),
        )
        for idx in _group_indices(boxes)
    ]


def group_members(boxes):
    """Return the raw-box index lists that make up each final group.

    Indices refer to the order of the input ``boxes`` list, so ``i + 1``
    matches the label drawn on the detections preview.
    """
    return _group_indices(boxes)


def reading_order(boxes):
    """Order boxes for Japanese manga: top-to-bottom rows, right-to-left within a row."""
    if not boxes:
        return []
    heights = [b[3] - b[1] for b in boxes]
    tol = 0.5 * statistics.median(heights) if heights else 0

    boxes = sorted(boxes, key=lambda b: b[1])
    rows = []
    for box in boxes:
        cy = (box[1] + box[3]) / 2
        for row in rows:
            anchor = (row[0][1] + row[0][3]) / 2
            if abs(cy - anchor) <= tol:
                row.append(box)
                break
        else:
            rows.append([box])

    ordered = []
    for row in rows:
        row.sort(key=lambda b: b[0], reverse=True)  # right-to-left
        ordered.extend(row)
    return ordered


def draw_preview(src, boxes, out_path):
    img = Image.open(src).convert("RGB")
    draw = ImageDraw.Draw(img)
    for i, (x0, y0, x1, y1) in enumerate(boxes, start=1):
        x0, y0, x1, y1 = map(int, (x0, y0, x1, y1))
        draw.rectangle([x0, y0, x1, y1], outline="red", width=3)
        badge = 14
        by = max(0, y0 - badge)
        draw.rectangle([x0, by, x0 + badge, by + badge], fill="white")
        draw.text((x0 + 2, by + 1), str(i), fill="red")
    img.save(out_path)
    return out_path


TRANSLATE_SYSTEM_PROMPT = (
    "You translate Japanese manga speech bubbles into natural, idiomatic English.\n"
    "The user message is a numbered list of lines, each possibly garbled by OCR. "
    "For every line, decide and report:\n"
    "1. 'en': a fluent English translation. For questions, keep it a question. "
    "Never invent, add, or remove meaning or compliments; translate only what is there. "
    "Keep any '♡'/'♥' symbol at the end of the line. "
    "When the dialogue makes it clear who is doing the action, preserve that "
    "actor in the English (e.g. address the listener directly with 'you').\n"
    "2. 'question': true if the line is an interrogative, INCLUDING colloquial "
    "questions that have no explicit か or ？. For example "
    "なに...してんのよ / なに...してるの is a question where なに here means "
    "'why' or 'what for' (as in 'Why are you doing...?'), so it is a question "
    "even without a question mark.\n"
    "3. 'garbled': true if the line is OCR noise - broken/mojibake, random or "
    "mixed-in Latin letters, or too little real Japanese to translate. If garbled, "
    "you MUST set 'en' to "" (empty string) and must NOT invent a translation.\n"
    "Respond with ONLY a JSON object of the form\n"
    '{"translations": {"1": {"en": "Oh, Sensei... ♡", "question": false, "garbled": false},'
    ' "2": {"en": "Huh? Why are you all excited?", "question": true, "garbled": false}}}.\n'
    "Keys must be the exact line numbers as strings, all present, each an object "
    "with exactly the keys 'en', 'question', 'garbled'."
)


def _normalize_entry(raw):
    if isinstance(raw, dict):
        en = raw.get("en", "")
        if not isinstance(en, str):
            en = str(en)
        return {
            "en": en,
            "question": bool(raw.get("question", False)),
            "garbled": bool(raw.get("garbled", False)),
        }
    if isinstance(raw, str):
        return {"en": raw, "question": False, "garbled": False}
    return {"en": "", "question": False, "garbled": True}


def _call_ollama(system, user):
    payload = {
        "model": MODEL_NAME,
        "stream": False,
        "think": False,
        "format": "json",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    request = Request(
        OLLAMA_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=180) as response:
        result = json.load(response)
    content = result["message"]["content"]
    try:
        return json.loads(content)
    except (ValueError, TypeError):
        return {"raw": content}


def translate(lines):
    """Translate a list of Japanese lines, preserving per-line question/garbled flags.

    Returns one ``{"en", "question", "garbled"}`` dict per input line, in order.
    """
    numbered = "\n".join(f"{i}. {text}" for i, text in enumerate(lines, start=1))
    data = _call_ollama(TRANSLATE_SYSTEM_PROMPT, numbered)
    translations = data.get("translations")
    if not isinstance(translations, dict):
        raise SystemExit(
            f"Error: Ollama response missing 'translations' object: "
            f"{json.dumps(data, ensure_ascii=False)}"
        )

    expected = {str(i) for i in range(1, len(lines) + 1)}
    got = set(translations.keys())
    missing = expected - got
    extra = got - expected
    if missing or extra:
        raise SystemExit(
            "Error: Ollama translation IDs do not match the bubble IDs.\n"
            f"  Missing: {sorted(missing) if missing else 'none'}\n"
            f"  Extra:   {sorted(extra) if extra else 'none'}\n"
            "  Refusing to assign translations."
        )
    return [_normalize_entry(translations[str(i)]) for i in range(1, len(lines) + 1)]


def translate_line(line):
    """Translate a single Japanese line with the shared question/garbled prompt."""
    return translate([line])[0]


def ocr_regions(src, boxes):
    """OCR each region box (in order) and return the list of recognized strings."""
    from manga_ocr import MangaOcr

    ocr = MangaOcr(force_cpu=True)
    img = Image.open(src).convert("RGB")
    texts = []
    for x0, y0, x1, y1 in boxes:
        crop = img.crop((int(x0), int(y0), int(x1), int(y1)))
        texts.append(ocr(crop).strip())
    return texts


def prepare_lines(texts):
    """Drop empty recognized lines; return ``{"id", "ja"}`` rows in order (1-based)."""
    return [
        {"id": i, "ja": text}
        for i, text in enumerate(texts, start=1)
        if text.strip()
    ]


def run_pipeline(image_path):
    """Detect, group, order, OCR, and translate one panel image.

    Returns ``{"translations": [{"id", "ja", "box", "en", "question", "garbled"}, ...]}``
    with 1-based reading-order IDs and the region box [x0, y0, x1, y1] in image pixels.
    """
    from paddleocr import TextDetection

    detector = TextDetection(model_name="PP-OCRv5_server_det", device="cpu")
    raw = detector.predict(image_path)
    boxes = get_boxes(raw)
    if not boxes:
        raise SystemExit("Error: no text regions detected.")

    bubbles = group_columns(boxes)
    ordered = reading_order(bubbles)
    texts = ocr_regions(image_path, ordered)

    pairs = [(box, text) for box, text in zip(ordered, texts) if text.strip()]
    if not pairs:
        raise SystemExit("Error: no Japanese text recognized in any region.")

    translations = translate([text for _, text in pairs])
    result = []
    for (box, text), tr in zip(pairs, translations):
        result.append(
            {
                "id": len(result) + 1,
                "ja": text,
                "en": tr["en"],
                "question": tr["question"],
                "garbled": tr["garbled"],
                "box": [int(round(v)) for v in box],
            }
        )
    return {"translations": result}


def main():
    parser = argparse.ArgumentParser(description="Detect, group, OCR, and translate a manga panel.")
    parser.add_argument("image", help="path to the panel image")
    parser.add_argument(
        "--debug-groups",
        action="store_true",
        help="print each raw box's coordinates and the raw-box IDs in each final group",
    )
    args = parser.parse_args()
    src = args.image
    if not os.path.exists(src):
        raise SystemExit(f"Error: image file not found: {src}")

    from paddleocr import TextDetection
    detector = TextDetection(model_name="PP-OCRv5_server_det", device="cpu")
    raw = detector.predict(src)
    boxes = get_boxes(raw)
    if not boxes:
        raise SystemExit("Error: no text regions detected.")
    print(f"Detected {len(boxes)} text region(s).")

    det_path = os.path.splitext(src)[0] + "_detections.png"
    draw_preview(src, boxes, det_path)
    print(f"Raw detections preview: {det_path}")

    groups = group_members(boxes)
    bubbles = group_columns(boxes)
    print(f"Grouped into {len(bubbles)} bubble region(s).")

    if args.debug_groups:
        print("\n--- Raw boxes ---")
        for i, (x0, y0, x1, y1) in enumerate(boxes, start=1):
            print(f"  {i}: x0={x0:.0f} y0={y0:.0f} x1={x1:.0f} y1={y1:.0f} "
                  f"w={x1 - x0:.0f} h={y1 - y0:.0f}")
        print("\n--- Final groups (raw box IDs) ---")
        for g in groups:
            print(f"  {[i + 1 for i in g]}")

    ordered = reading_order(bubbles)
    grouped_path = os.path.splitext(src)[0] + "_grouped.png"
    draw_preview(src, ordered, grouped_path)
    print(f"Grouped preview: {grouped_path}")

    texts = ocr_regions(src, ordered)
    rows = prepare_lines(texts)
    if not rows:
        raise SystemExit("Error: no Japanese text recognized in any region.")

    lines = [row["ja"] for row in rows]

    print("\n--- Detected lines (numbered, in reading order) ---")
    for i, line in enumerate(lines, start=1):
        print(f"{i}. {line}")
    print()

    translations = translate(lines)

    def show(results):
        print("\n--- Translations ---")
        for i, (line, tr) in enumerate(zip(lines, results), start=1):
            flags = []
            if tr.get("question"):
                flags.append("question")
            if tr.get("garbled"):
                flags.append("GARBLED")
            flag = f"  [{', '.join(flags)}]" if flags else ""
            print(f"{i}. {line}\n   -> {tr.get('en', '')!s}{flag}")

    show(translations)

    print("\nCorrections: enter lines as 'N: corrected Japanese', one per line. "
          "Leave blank and press Enter to skip.")
    corrections = {}
    while True:
        entry = input("> ").strip()
        if not entry:
            break
        if ":" not in entry:
            print("  Expected format: N: text")
            continue
        num, text = entry.split(":", 1)
        try:
            n = int(num.strip())
        except ValueError:
            print("  N must be a number.")
            continue
        if n < 1 or n > len(lines):
            print(f"  N must be between 1 and {len(lines)}.")
            continue
        corrections[str(n)] = text.strip()

    if corrections:
        lines = [corrections.get(str(i), line) for i, line in enumerate(lines, start=1)]
        print("Resending corrected lines to Ollama...")
        show(translate(lines))


if __name__ == "__main__":
    main()
