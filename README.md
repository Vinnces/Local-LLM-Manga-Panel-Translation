# Manga Panel Translate

A Chrome extension and local Python service for translating Japanese manga into English using a local LLM. The extension finds the main manga image on the current page and sends the full image to the local service, including parts outside the visible browser window. English labels appear beside the Japanese text, and a numbered list shows both languages for review.

The service uses PaddleOCR to locate text, Manga OCR to read the Japanese, and Ollama to translate it locally. [PaddleOCR](https://www.paddleocr.ai/) · [Manga OCR](https://github.com/kha-white/manga-ocr) · [Ollama](https://ollama.com/)

## Setup on Windows

Install 64-bit Python 3.12, Ollama for Windows, and Google Chrome. Download or clone this repository and open PowerShell in the folder containing `service.py`. [Python downloads](https://www.python.org/downloads/windows/) · [Ollama for Windows](https://ollama.com/download/windows)

### 1. Install the Python dependencies

Create a virtual environment using Python 3.12 and install the CPU build of PaddlePaddle along with the OCR packages.

```powershell
py -3.12 -m venv .venv312
.\.venv312\Scripts\python.exe -m pip install --upgrade pip
.\.venv312\Scripts\python.exe -m pip install paddlepaddle==3.2.0
.\.venv312\Scripts\python.exe -m pip install "paddleocr>=3,<4" manga-ocr Pillow requests
```

If PowerShell doesn't recognize `py`, run `python --version`. If it reports Python 3.12, use `python -m venv .venv312` for the first command. You can also run the Python 3.12 executable by its full path.

### 2. Download the translation model

Open Ollama, then download the local LLM model that you want to use. For example I used Qwen3.8:27b-q4_K_M [Ollama model page](https://ollama.com/library/qwen3.8%3A27b-q4_K_M)

```powershell
ollama pull qwen3.8:27b-q4_K_M
```

Keep Ollama running while using the translator. Its local API is at `http://127.0.0.1:11434`.

### 3. Start the Python service

```powershell
.\.venv312\Scripts\python.exe .\service.py
```

Keep this PowerShell window open. The service listens at `http://127.0.0.1:8765`. To check that it responds, run this in another PowerShell window.

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

### 4. Load the extension

1. In Chrome, open `chrome://extensions`.
2. Turn on **Developer mode** and click **Load unpacked**.
3. Select the `extension` folder that contains `manifest.json`.
4. Pin **Manga Panel Translate** from Chrome's Extensions menu for easy access.

## Translate a manga page

1. Open a manga page and let its image finish loading.
2. Click the extension icon and select **Translate page**. If Chrome asks for access to the image host, use **Allow & translate** and approve the request. The image host may differ from the website address.
3. Review the inline English labels and the numbered English and Japanese list. Use **A−** and **A+** in the list header to change the inline font size. Use **−** to minimize the list, **+** to restore it, or drag the resize handle at the bottom to adjust its size.
4. After moving to the next manga page, click **Translate page** again.

## Translate a saved image

With Ollama running, use the CLI to process an image from disk. Replace `your-panel.png` with a file you have locally.

```powershell
.\.venv312\Scripts\python.exe .\test_panel.py .\your-panel.png
```

The script prints the detected Japanese and English translations and saves previews of the detected and grouped text regions.

## Development

I built this project with help from OpenCode and local LLM Qwen 3.8 27B. I tested the extension in Chrome and refined the translation workflow based on what I saw on manga pages.