"""Local HTTP service: manga panel OCR + translation as async jobs.

Binds to 127.0.0.1:8765 only. Endpoints:
  POST /jobs        body = raw PNG bytes -> 202 {"jobId": "..."}
  GET  /jobs/<id>   -> {"status": "running"|"done"|"error", ...}
  GET  /health      -> {"status": "ok"}

POST /jobs returns immediately; the pipeline runs in a background worker
thread and the client polls GET /jobs/<id>. No CORS headers: the
extension's host_permissions bypass the browser check.
"""
import json
import os
import tempfile
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from test_panel import run_pipeline

HOST = "127.0.0.1"
PORT = 8765
JOB_TTL = 600  # keep finished jobs for 10 minutes

DEBUG = os.environ.get("MANGA_DEBUG", "1") not in ("0", "false", "False")
DEBUG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug")

JOBS = {}
JOBS_LOCK = threading.Lock()


def _new_job():
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "status": "running", "created": time.time(), "result": None, "error": None}
    with JOBS_LOCK:
        JOBS[job_id] = job
        _prune_jobs()
    return job


def _prune_jobs():
    """Drop finished jobs older than JOB_TTL. Caller must hold JOBS_LOCK."""
    now = time.time()
    for job_id in list(JOBS.keys()):
        job = JOBS[job_id]
        if job["status"] != "running" and now - job.get("finished", now) > JOB_TTL:
            del JOBS[job_id]


def _finish(job, status, result=None, error=None):
    job["status"] = status
    if result is not None:
        job["result"] = result
    if error is not None:
        job["error"] = error
    job["finished"] = time.time()


def _worker(job, tmp_path):
    started = time.time()
    print(f"job {job['id']}: pipeline started", flush=True)
    try:
        result = run_pipeline(tmp_path)
        _finish(job, "done", result=result)
        print(f"job {job['id']}: done in {time.time() - started:.1f}s; "
              f"{len(result.get('translations', []))} lines", flush=True)
    except BaseException as exc:  # noqa: BLE001 - pipeline raises SystemExit
        traceback.print_exc()
        message = str(exc) or exc.__class__.__name__
        _finish(job, "error", error=message)
        print(f"job {job['id']}: FAILED after {time.time() - started:.1f}s: {exc!r}", flush=True)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"status": "ok"})
            return

        if self.path.startswith("/jobs/"):
            job_id = self.path[len("/jobs/"):]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                payload = None if job is None else dict(job)
            if payload is None:
                self._send_json(404, {"error": "unknown job"})
                return
            payload.pop("id", None)
            self._send_json(200, payload)
            return

        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/jobs":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            self._send_json(400, {"error": "empty body; expected PNG bytes"})
            return
        data = self.rfile.read(length)

        fd, tmp_path = tempfile.mkstemp(suffix=".png", prefix="manga_")
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)

        job = _new_job()
        if DEBUG:
            try:
                os.makedirs(DEBUG_DIR, exist_ok=True)
                debug_path = os.path.join(DEBUG_DIR, f"crop_{job['id']}.png")
                with open(debug_path, "wb") as fh:
                    fh.write(data)
                print(f"debug crop saved: {debug_path}", flush=True)
            except OSError as exc:
                print(f"debug crop save failed: {exc}", flush=True)
        thread = threading.Thread(target=_worker, args=(job, tmp_path), daemon=True)
        thread.start()
        print(f"received {length} bytes; job {job['id']} accepted", flush=True)
        self._send_json(202, {"jobId": job["id"]})

    def log_message(self, fmt, *args):
        # quieter logs
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Listening on http://{HOST}:{PORT} (POST /jobs with PNG bytes, GET /jobs/<id>)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
