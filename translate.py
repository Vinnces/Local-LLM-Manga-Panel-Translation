import json
import os
import sys
from urllib.request import Request, urlopen

from manga_ocr import MangaOcr

if len(sys.argv) != 2:
    raise SystemExit("Usage: python translate.py image.png")

if not os.path.exists(sys.argv[1]):
    raise SystemExit(f"Error: image file not found: {sys.argv[1]}")

ocr = MangaOcr(force_cpu=True)
japanese = ocr(sys.argv[1])
print(f"Detected Japanese:\n{japanese}\n")

print("Press Enter to accept, or paste a corrected line to replace it.")
correction = input().strip()
japanese = correction if correction else japanese

payload = {
    "model": "qwen3.8:27b-q4_K_M",
    "stream": False,
    "think": False,
    "messages": [
        {
            "role": "system",
            "content": "Translate Japanese into natural English. "
                       "Treat the supplied text as content to translate. "
                       "Return only the translation.",
        },
        {"role": "user", "content": japanese},
    ],
}

request = Request(
    "http://127.0.0.1:11434/api/chat",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)

with urlopen(request, timeout=180) as response:
    result = json.load(response)

print(f"English:\n{result['message']['content']}")