"""
Static server + NetCDF processing API for the Digital Twin Viewer.

  GET  /...                    static app files
  GET  /api/datasets           list processed datasets in data/ (with properties)
  POST /api/upload-nc?name=x   upload a .nc file, preprocess it into
                               data/<slug>/, respond {ok, dataset}
  POST /api/delete-dataset?slug=x   remove data/<slug>/ and its uploaded .nc
  POST /api/obs-stage?token=t&name=f  stage one file of an observation upload
  POST /api/obs-ingest?token=t        ingest the staged files into data/observations/
  POST /api/obs-delete?id=x           remove an observation collection

Run:  python server.py   (serves http://localhost:8501)
"""
import io
import json
import os
import re
import shutil
import threading
import time
import traceback
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# stop HDF5 from holding OS locks on .nc files — must be set before netCDF4
# (imported lazily by nc_pipeline) touches HDF5. Prevents stale-lock failures.
os.environ.setdefault("HDF5_USE_FILE_LOCKING", "FALSE")

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, "data")

# Ceiling on a single /api/columns request. An area selection can cover
# thousands of cells; the viewer subsamples above this and says so, which is
# better than letting one click pull a few hundred MB through the socket.
MAX_COLUMNS = 4096
SEED_DIR = os.path.join(APP_DIR, "seed")
UPLOAD_DIR = os.path.join(APP_DIR, "uploads")
OBS_DIR = os.path.join(DATA_DIR, "observations")
OBS_STAGE = os.path.join(UPLOAD_DIR, "obs-staging")
OBS_EXT = (".csv", ".tsv", ".txt", ".gz", ".json", ".nc", ".nc4")
OBS_MAX_BYTES = int(os.environ.get("OBS_MAX_MB", "2048")) * (1 << 20)
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8501"))
if not 1 <= PORT <= 65535:
    raise ValueError(f"PORT must be between 1 and 65535, got {PORT}")


def seed_datasets():
    """Copy any bundled dataset in seed/ into data/ when it is missing or out of
    date.

    This exists because of how the container is deployed: compose mounts a named
    volume over /app/data, and Docker only seeds a named volume from the image
    when that volume is EMPTY. On any host that has run the app before, the
    volume already holds an older copy of the bundled dataset, so a freshly
    built image's version never appears — the stale copy wins, silently, with a
    healthy container and clean logs. Re-seeding on every start keeps the
    bundled dataset in step with the image.

    meta.json is the staleness test: the pipeline rewrites it (dims, stats,
    flow block) whenever the dataset is regenerated, so an unchanged meta.json
    means an unchanged dataset and the copy is skipped.

    Note this also restores a bundled dataset that was deleted through the UI —
    intended, since it ships with the image rather than being user data.
    """
    if not os.path.isdir(SEED_DIR):
        return                                  # running outside the container
    for name in sorted(os.listdir(SEED_DIR)):
        src = os.path.join(SEED_DIR, name)
        if not os.path.isfile(os.path.join(src, "meta.json")):
            continue
        dst = os.path.join(DATA_DIR, name)
        try:
            with open(os.path.join(src, "meta.json"), "rb") as f:
                want = f.read()
            cur = None
            if os.path.isfile(os.path.join(dst, "meta.json")):
                with open(os.path.join(dst, "meta.json"), "rb") as f:
                    cur = f.read()
            if cur == want:
                continue
            print(f"[seed] {'updating' if cur else 'installing'} bundled dataset "
                  f"'{name}' -> data/{name}")
            tmp = dst + ".seeding"
            shutil.rmtree(tmp, ignore_errors=True)
            shutil.copytree(src, tmp)
            shutil.rmtree(dst, ignore_errors=True)
            os.replace(tmp, dst)
        except Exception as e:
            print(f"[seed] could not install '{name}': {e}")


def slugify(name):
    s = re.sub(r"\.nc$", "", name.lower())
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "dataset"


def replace_with_retry(src, dst, attempts=8, delay=0.4):
    """os.replace(src, dst), retrying past *transient* Windows locks on dst —
    a virus scanner or the search indexer briefly opening the freshly written
    file, or the OS lagging to release the handle from a prior run. Raises the
    last PermissionError if the file is still locked (genuinely held elsewhere)."""
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(delay * (i + 1))


# slugs currently being processed — a second upload of the same name would
# fight over uploads/<slug>.nc and data/<slug>/
PROCESSING = set()
PROCESSING_LOCK = threading.Lock()


class _Window(io.RawIOBase):
    """A read-only view of the first `n` bytes from the current file offset."""

    def __init__(self, f, n):
        self._f, self._left = f, n

    def readable(self):
        return True

    def read(self, size=-1):
        if self._left <= 0:
            return b""
        if size is None or size < 0:
            size = self._left
        b = self._f.read(min(size, self._left))
        self._left -= len(b)
        return b

    def close(self):
        try:
            self._f.close()
        finally:
            super().close()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def drain_body(self, remaining):
        # discard unread request bytes: responding while the browser is still
        # uploading resets the connection and the error surfaces as an opaque
        # "Failed to fetch" instead of our JSON message
        try:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    return
                remaining -= len(chunk)
        except OSError:
            pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_head(self):
        """Add single-range support to the static file server.

        SimpleHTTPRequestHandler always sends the whole file, so a dropped
        connection part-way through a 97 MB variable costs the whole download
        again. Browsers and curl ask for one range when resuming; a multi-range
        request is answered in full, which is allowed and is what they fall
        back to anyway.
        """
        rng = self.headers.get("Range")
        if not rng or self.command != "GET":
            return super().send_head()
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
        if not m or not (m.group(1) or m.group(2)):
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path) or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        if m.group(1):
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else size - 1
        else:                                   # bytes=-N, the last N bytes
            start, end = max(0, size - int(m.group(2))), size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        f = open(path, "rb")
        try:
            f.seek(start)
            self.send_response(206)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Last-Modified", self.date_time_string(os.stat(path).st_mtime))
            self.end_headers()
        except Exception:
            f.close()
            raise
        # copyfile() would stream to EOF; hand it only the requested window
        return _Window(f, end - start + 1)

    def end_headers(self):
        # data files change between sessions; keep the browser honest
        if self.path.startswith("/data/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if urlparse(self.path).path == "/api/datasets":
            out = []
            if os.path.isdir(DATA_DIR):
                for d in sorted(os.listdir(DATA_DIR)):
                    mp = os.path.join(DATA_DIR, d, "meta.json")
                    if os.path.isfile(mp):
                        try:
                            with open(mp) as f:
                                m = json.load(f)
                            ddir = os.path.join(DATA_DIR, d)
                            size = sum(
                                os.path.getsize(os.path.join(ddir, fn))
                                for fn in os.listdir(ddir)
                                if os.path.isfile(os.path.join(ddir, fn)))
                            nc = os.path.join(UPLOAD_DIR, d + ".nc")
                            out.append({
                                "slug": d, "title": m.get("title", d),
                                "nDays": m.get("nDays"),
                                "nx": m.get("nx"), "ny": m.get("ny"),
                                "cellKm": m.get("cellKm"),
                                "extentKm": m.get("extentKm"),
                                "startDate": m.get("startDate"),
                                "stepDays": m.get("stepDays", 1),
                                "satellite": bool(m.get("satellite")),
                                "sizeMB": round(size / 1e6, 1),
                                "processedAt": int(os.path.getmtime(mp)),
                                "hasNc": os.path.isfile(nc),
                                "ncSizeMB": round(os.path.getsize(nc) / 1e6, 1)
                                            if os.path.isfile(nc) else None,
                            })
                        except Exception:
                            pass
            out.sort(key=lambda x: x["processedAt"], reverse=True)
            return self.send_json(out)
        super().do_GET()

    # ------------------------------------------------------- column profiles
    def serve_columns(self, parsed):
        """POST /api/columns  {dataset, file, nFrames, nLayers, cells:[...]}
        -> raw uint16, the requested columns concatenated in the order asked.

        The column store is laid out level-fastest-then-time, so one cell's
        whole history is a single contiguous run of bytes. A vertical profile
        is therefore one seek and one read of ~7 kB, out of a file that may be
        hundreds of megabytes — which is the whole reason the viewer can show
        4-D fields without downloading them.

        This is a POST because a transect can name a few hundred cells, which
        is more than a query string should carry. HTTP Range would serve a
        single run, but not a scattered set of them in one round trip.
        """
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > (1 << 22):
            self.drain_body(length)
            return self.send_json({"ok": False, "error": "bad request body"}, 400)
        try:
            req = json.loads(self.rfile.read(length))
        except Exception:
            return self.send_json({"ok": False, "error": "malformed JSON"}, 400)

        slug = str(req.get("dataset", ""))
        name = str(req.get("file", ""))
        cells = req.get("cells") or []
        # the path is assembled from a dataset slug and a file name, both of
        # which arrive from the network: anything with a separator in it, or
        # that resolves outside DATA_DIR, is refused rather than normalised
        if (not slug or not name or "/" in slug or "\\" in slug or os.pardir in slug
                or "/" in name or "\\" in name or not name.startswith("col_")
                or not name.endswith(".u16.bin")):
            return self.send_json({"ok": False, "error": "bad dataset or file"}, 400)
        path = os.path.join(DATA_DIR, slug, name)
        if os.path.dirname(os.path.abspath(path)) != os.path.abspath(
                os.path.join(DATA_DIR, slug)) or not os.path.isfile(path):
            return self.send_json({"ok": False, "error": "no such column store"}, 404)

        try:
            stride = int(req["nFrames"]) * int(req["nLayers"]) * 2
            cells = [int(c) for c in cells]
        except Exception:
            return self.send_json({"ok": False, "error": "bad shape or cells"}, 400)
        size = os.path.getsize(path)
        if stride <= 0 or stride > size or len(cells) > MAX_COLUMNS:
            return self.send_json(
                {"ok": False, "error": f"at most {MAX_COLUMNS} columns"}, 400)
        ncol = size // stride
        if any(c < 0 or c >= ncol for c in cells):
            return self.send_json({"ok": False, "error": "column out of range"}, 400)

        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(stride * len(cells)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with open(path, "rb") as f:
            # consecutive cells are consecutive in the file, so a run of them
            # (an area's row, a straight transect) collapses into one read
            i = 0
            while i < len(cells):
                j = i + 1
                while j < len(cells) and cells[j] == cells[j - 1] + 1:
                    j += 1
                f.seek(cells[i] * stride)
                self.wfile.write(f.read(stride * (j - i)))
                i = j

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/columns":
            return self.serve_columns(parsed)
        if parsed.path == "/api/delete-dataset":
            return self.delete_dataset(parsed)
        if parsed.path == "/api/obs-stage":
            return self.obs_stage(parsed)
        if parsed.path == "/api/obs-ingest":
            return self.obs_ingest(parsed)
        if parsed.path == "/api/obs-delete":
            return self.obs_delete(parsed)
        if parsed.path != "/api/upload-nc":
            return self.send_json({"ok": False, "error": "unknown endpoint"}, 404)

        name = parse_qs(parsed.query).get("name", ["upload.nc"])[0]
        slug = slugify(os.path.basename(name))
        if slug == "default":
            slug = "default-upload"

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return self.send_json({"ok": False, "error": "empty upload"}, 400)

        with PROCESSING_LOCK:
            busy = slug in PROCESSING
            PROCESSING.add(slug)
        if busy:
            self.drain_body(length)
            return self.send_json(
                {"ok": False, "error": f"'{slug}' is already being processed — "
                 f"wait for it to finish before loading it again"}, 409)

        os.makedirs(UPLOAD_DIR, exist_ok=True)
        nc_path = os.path.join(UPLOAD_DIR, slug + ".nc")
        # unique temp name so the incoming bytes never contend with an existing
        # (possibly locked) copy; moved into place atomically once fully written
        part_path = f"{nc_path}.{os.getpid()}.{threading.get_ident()}.part"
        out_dir = os.path.join(DATA_DIR, slug)
        remaining = length
        try:
            os.makedirs(out_dir, exist_ok=True)
            with open(os.path.join(out_dir, "status.json"), "w") as f:
                json.dump({"stage": "uploading", "pct": 2}, f)
            with open(part_path, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        raise IOError("connection closed during upload")
                    f.write(chunk)
                    remaining -= len(chunk)
            # tolerate a virus scanner / indexer briefly holding the old file
            replace_with_retry(part_path, nc_path)

            from nc_pipeline import process  # heavy imports only when needed
            meta = process(nc_path, out_dir)
            print(f"[server] processed '{name}' -> data/{slug} "
                  f"({meta['nx']}x{meta['ny']}, {meta['nDays']} steps)")
            self.send_json({"ok": True, "dataset": slug, "title": meta["title"]})
        except Exception as e:
            traceback.print_exc()
            msg = str(e)
            if isinstance(e, ImportError):
                msg = (f"the server's Python is missing the package "
                       f"'{getattr(e, 'name', None) or e}' — install the "
                       f"processing dependencies with:  pip install -r requirements.txt")
            elif isinstance(e, PermissionError):
                msg = (f"uploads/{slug}.nc is still locked after several retries — "
                       f"another program (a virus scanner, or the file open in a "
                       f"NetCDF viewer) is holding it. Close it, or restart this "
                       f"server, and try again")
            try:
                os.makedirs(out_dir, exist_ok=True)
                with open(os.path.join(out_dir, "status.json"), "w") as f:
                    json.dump({"stage": "error", "pct": 0, "error": msg}, f)
            except OSError:
                pass
            self.drain_body(remaining)
            self.send_json({"ok": False, "error": msg}, 500)
        finally:
            # never leave the temp upload behind
            try:
                if os.path.exists(part_path):
                    os.remove(part_path)
            except OSError:
                pass
            with PROCESSING_LOCK:
                PROCESSING.discard(slug)

    # ------------------------------------------------------- observations
    # An observation upload is a data file plus, usually, its JSON sidecar.
    # Each file is staged by its own request under a token the browser made
    # up, then one more request ingests the lot -- simpler and sturdier than
    # parsing multipart bodies, which the standard library no longer does.
    @staticmethod
    def _token(parsed):
        t = parse_qs(parsed.query).get("token", [""])[0]
        return t if re.fullmatch(r"[a-z0-9]{6,64}", t) else None

    def obs_stage(self, parsed):
        length = int(self.headers.get("Content-Length", "0"))
        token = self._token(parsed)
        name = os.path.basename(parse_qs(parsed.query).get("name", [""])[0])
        if not token or not name or not name.lower().endswith(OBS_EXT):
            self.drain_body(length)
            return self.send_json({"ok": False, "error": "expected a .csv/.tsv/.txt/.gz data file, "
                                   "a .json sidecar or a .nc file"}, 400)
        if length <= 0 or length > OBS_MAX_BYTES:
            self.drain_body(length)
            return self.send_json({"ok": False, "error": f"file is empty or larger than "
                                   f"{OBS_MAX_BYTES >> 20} MB (set OBS_MAX_MB to raise it)"}, 400)
        d = os.path.join(OBS_STAGE, token)
        os.makedirs(d, exist_ok=True)
        dst = os.path.join(d, re.sub(r"[^A-Za-z0-9._ -]", "_", name))
        remaining = length
        try:
            with open(dst + ".part", "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        raise IOError("connection closed during upload")
                    f.write(chunk)
                    remaining -= len(chunk)
            replace_with_retry(dst + ".part", dst)
            self.send_json({"ok": True})
        except Exception as e:
            self.drain_body(remaining)
            self.send_json({"ok": False, "error": str(e)}, 500)

    def obs_ingest(self, parsed):
        token = self._token(parsed)
        d = os.path.join(OBS_STAGE, token) if token else None
        if not d or not os.path.isdir(d):
            return self.send_json({"ok": False, "error": "nothing staged under that token"}, 400)
        with PROCESSING_LOCK:
            busy = "obs:" + token in PROCESSING
            PROCESSING.add("obs:" + token)
        if busy:
            return self.send_json({"ok": False, "error": "already being ingested"}, 409)
        try:
            files = sorted(f for f in os.listdir(d) if not f.endswith(".part"))
            data = [f for f in files if not f.lower().endswith(".json")]
            side = [f for f in files if f.lower().endswith(".json")]
            if len(data) != 1:
                raise ValueError(f"upload exactly one data file (got {len(data)}: {', '.join(data) or 'none'}); "
                                 f"the sidecar goes with it as a .json")
            stem = data[0].split(".")[0]
            sc = next((f for f in side if f.split(".")[0] == stem), side[0] if len(side) == 1 else None)
            if len(side) > 1 and sc is None:
                raise ValueError("several .json files and none shares the data file's name — keep one sidecar")
            import obs_ingest                     # numpy (and netCDF4 for .nc) only when needed
            doc, files_out = obs_ingest.ingest(os.path.join(d, data[0]),
                                               os.path.join(d, sc) if sc else None, out_root=OBS_DIR)
            print(f"[server] ingested observations '{doc['id']}' ({doc['kind']}, "
                  f"{doc['nStations']} stations, {doc['nRecords']} values)")
            self.send_json({"ok": True, "id": doc["id"], "title": doc["title"], "kind": doc["kind"],
                            "warnings": doc.get("warnings", []),
                            "report": obs_ingest.report(doc, files_out)})
        except Exception as e:
            traceback.print_exc()
            msg = str(e)
            if isinstance(e, ImportError):
                msg = (f"the server's Python is missing '{getattr(e, 'name', None) or e}' — "
                       f"install the processing dependencies: pip install -r requirements.txt")
            self.send_json({"ok": False, "error": msg}, 400 if isinstance(e, ValueError) else 500)
        finally:
            shutil.rmtree(d, ignore_errors=True)
            with PROCESSING_LOCK:
                PROCESSING.discard("obs:" + token)

    def obs_delete(self, parsed):
        cid = parse_qs(parsed.query).get("id", [""])[0]
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,80}", cid) or                 not os.path.isdir(os.path.join(OBS_DIR, cid)):
            return self.send_json({"ok": False, "error": "unknown collection"}, 404)
        try:
            import obs_ingest
            obs_ingest.remove(cid, OBS_DIR)
            print(f"[server] removed observation collection '{cid}'")
            self.send_json({"ok": True})
        except Exception as e:
            traceback.print_exc()
            self.send_json({"ok": False, "error": str(e)}, 500)

    def delete_dataset(self, parsed):
        slug = parse_qs(parsed.query).get("slug", [""])[0]
        # only accept names that are actual dataset directories — no paths
        if not slug or slug != os.path.basename(slug) or \
                not os.path.isdir(os.path.join(DATA_DIR, slug)):
            return self.send_json({"ok": False, "error": "unknown dataset"}, 404)
        if slug == "default":
            return self.send_json(
                {"ok": False, "error": "the default dataset cannot be deleted"}, 400)
        try:
            shutil.rmtree(os.path.join(DATA_DIR, slug))
            nc = os.path.join(UPLOAD_DIR, slug + ".nc")
            if os.path.isfile(nc):
                os.remove(nc)
            print(f"[server] deleted dataset '{slug}'")
            self.send_json({"ok": True})
        except Exception as e:
            traceback.print_exc()
            self.send_json({"ok": False, "error": str(e)}, 500)


if __name__ == "__main__":
    import importlib.util
    import sys
    missing = [m for m in ("numpy", "scipy", "netCDF4", "PIL")
               if importlib.util.find_spec(m) is None]
    if missing:
        print(f"NOTE: loading .nc files is disabled — missing package(s): "
              f"{', '.join(missing)}")
        print("      fix with:  pip install -r requirements.txt   "
              "(the viewer itself still works)")
    os.makedirs(DATA_DIR, exist_ok=True)
    seed_datasets()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}"
    print(f"Digital Twin Viewer running at {url}  (Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    server.serve_forever()
