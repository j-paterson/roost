#!/usr/bin/env python3
"""Ollama-compatible embedding sidecar backed by a local sentence-transformer.

Serves POST /api/embed matching Ollama's batched embed endpoint so the TS plugin
(src/pipeline/describe-items.ts) can drop-in-replace its Ollama URL with this
server's URL to get v2 fine-tuned embeddings instead of raw nomic-embed-text.

Wire protocol (matches Ollama):
    Request:  {"model": "...", "input": "string" | ["s1", "s2", ...]}
    Response: {"embeddings": [[...], [...]], "model": "...", "total_duration": 0}

Model name in the request is ignored — the sidecar always returns embeddings from
the model at --model-path. The field is preserved only for API compatibility.

Zero third-party HTTP deps (stdlib only) so we don't add to requirements.txt —
sentence-transformers is already installed for finetune-hard-neg.py.

Usage:
    # Vault root required (or set ROOST_VAULT env); defaults to <vault>/.roost/nomic-finetuned-hardneg
    python scripts/embed-sidecar.py --vault-root /path/to/vault

    # Custom model + port
    python scripts/embed-sidecar.py --vault-root /path/to/vault --model-path /path/to/model --port 11435

    # Then in Obsidian plugin config, set EMBED_URL=http://localhost:11435
"""
import argparse
import json
import logging
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Lock

os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")

DEFAULT_PORT = 11435
DEFAULT_MAX_SEQ = 384  # match training-time max_seq_length
# Base embedding model used when no fine-tuned model is present, so the sidecar
# runs out of the box (the fine-tuned model from finetune-embeddings.py is an
# optional quality upgrade).
DEFAULT_BASE_MODEL = "nomic-ai/nomic-embed-text-v1.5"


def resolve_vault_root(cli_value):
    """Resolve vault root from --vault-root, then ROOST_VAULT env var.
    Required: the sidecar can't guess where the vault lives."""
    raw = cli_value or os.environ.get("ROOST_VAULT")
    if not raw:
        log.error("vault root not provided: pass --vault-root <path> or set ROOST_VAULT")
        sys.exit(2)
    p = Path(raw).expanduser().resolve()
    if not p.exists():
        log.error(f"vault root does not exist: {p}")
        sys.exit(2)
    return p

_model = None
_model_lock = Lock()
_stats = {"requests": 0, "items": 0, "total_ms": 0.0, "errors": 0}

log = logging.getLogger("embed-sidecar")

# --- ASR (speech-to-text) ---------------------------------------------------
# Lazy faster-whisper integration. The imports below MUST stay inside the
# functions so embedding-only users who haven't installed faster-whisper can
# still import and run this sidecar.
_asr_model = None
_asr_available_cache = None


def asr_available():
    global _asr_available_cache
    if _asr_available_cache is None:
        try:
            import faster_whisper  # noqa: F401
            _asr_available_cache = True
        except Exception:
            _asr_available_cache = False
    return _asr_available_cache


def get_asr_model():
    global _asr_model
    if _asr_model is None:
        from faster_whisper import WhisperModel
        _asr_model = WhisperModel("base", device="cpu", compute_type="int8")
        log.info("ASR model loaded (faster-whisper base int8)")
    return _asr_model


def _decode_audio_16k_mono(path):
    import av
    import numpy as np
    container = av.open(path)
    stream = next(s for s in container.streams if s.type == "audio")
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    chunks = []

    def emit(frames):
        if frames is None:
            return
        if not isinstance(frames, list):
            frames = [frames]
        for fr in frames:
            if fr is not None:
                chunks.append(fr.to_ndarray().reshape(-1))

    for frame in container.decode(stream):
        emit(resampler.resample(frame))
    emit(resampler.resample(None))
    container.close()
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def _fmt_ts(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def transcribe_file(path):
    """Transcribe a local media file. Returns the /transcribe response dict."""
    audio = _decode_audio_16k_mono(path)
    duration = len(audio) / 16000.0
    model = get_asr_model()
    segments, info = model.transcribe(audio, beam_size=1, vad_filter=True)
    cues = []
    parts = []
    for seg in segments:  # generator — iterating does the work
        txt = seg.text.strip()
        if not txt:
            continue
        cues.append(f"{_fmt_ts(seg.start)} --> {_fmt_ts(seg.end)}\n{txt}")
        parts.append(txt)
    text = " ".join(parts).strip()
    vtt = "WEBVTT\n\n" + "\n\n".join(cues) + ("\n" if cues else "")
    return {
        "text": text,
        "vtt": vtt,
        "no_speech": len(text) == 0,
        "language": getattr(info, "language", "") or "",
        "duration": duration,
    }


def load_model(model_path: Path, max_seq: int):
    """Load sentence-transformer. Trusts remote code (nomic has a custom class)."""
    global _model
    from sentence_transformers import SentenceTransformer
    import torch

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    log.info(f"Loading model from {model_path}")
    log.info(f"  device={device} max_seq_length={max_seq}")
    t0 = time.time()
    m = SentenceTransformer(str(model_path), trust_remote_code=True)
    m.max_seq_length = max_seq
    m = m.to(device)
    # Warm up + verify with a single call (catches weight-load / tokenizer issues
    # before the first real request).
    test_vec = m.encode(["smoke test"], normalize_embeddings=True)
    log.info(f"  loaded in {time.time()-t0:.1f}s; embedding dim={test_vec.shape[1]}")
    _model = m


def encode(inputs):
    """Thread-safe batch encode. SentenceTransformer.encode is not thread-safe
    under concurrent calls, so serialize at the sidecar boundary."""
    with _model_lock:
        vecs = _model.encode(
            inputs,
            batch_size=32,
            show_progress_bar=False,
            normalize_embeddings=True,
        )
    return [v.tolist() for v in vecs]


class EmbedHandler(BaseHTTPRequestHandler):
    # Silence per-request log spam; we log our own summaries.
    def log_message(self, format, *args):
        pass

    def _json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def do_GET(self):
        # Health-check endpoint for the re-embed script / plugin.
        if self.path in ("/", "/health", "/api/tags"):
            self._json(200, {
                "status": "ok",
                "model_loaded": _model is not None,
                "asr_available": asr_available(),
                "stats": _stats,
            })
            return
        self._json(404, {"error": "not found"})

    def _handle_transcribe(self):
        if not asr_available():
            self._json(503, {"error": "faster-whisper not installed in the sidecar venv"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b""
            req = json.loads(raw) if raw else {}
        except Exception as e:
            self._json(400, {"error": f"bad json: {e}"})
            return
        path = req.get("path")
        if not path or not isinstance(path, str):
            self._json(400, {"error": "missing 'path'"})
            return
        if not os.path.isfile(path):
            self._json(400, {"error": f"file not found: {path}"})
            return
        try:
            result = transcribe_file(path)
        except Exception as e:
            log.exception("transcribe failed")
            self._json(500, {"error": f"transcribe: {e}"})
            return
        self._json(200, result)

    def do_POST(self):
        if self.path == "/transcribe":
            self._handle_transcribe()
            return
        if self.path not in ("/api/embed", "/api/embeddings"):
            self._json(404, {"error": f"unknown path {self.path}"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b""
            req = json.loads(raw) if raw else {}
        except Exception as e:
            _stats["errors"] += 1
            self._json(400, {"error": f"bad json: {e}"})
            return

        # Accept Ollama's batched shape (input: str | list) and the older
        # single-item shape (prompt: str) that /api/embeddings uses.
        inputs = req.get("input")
        if inputs is None:
            inputs = req.get("prompt")
        if inputs is None:
            _stats["errors"] += 1
            self._json(400, {"error": "missing 'input' (or 'prompt') field"})
            return
        if isinstance(inputs, str):
            inputs = [inputs]
        if not isinstance(inputs, list) or not all(isinstance(s, str) for s in inputs):
            _stats["errors"] += 1
            self._json(400, {"error": "'input' must be str or list[str]"})
            return

        t0 = time.time()
        try:
            vecs = encode(inputs)
        except Exception as e:
            _stats["errors"] += 1
            log.exception("encode failed")
            self._json(500, {"error": f"encode: {e}"})
            return
        elapsed_ms = (time.time() - t0) * 1000

        _stats["requests"] += 1
        _stats["items"] += len(inputs)
        _stats["total_ms"] += elapsed_ms

        # Log every 100 requests to show progress during big re-embed runs.
        if _stats["requests"] % 100 == 0:
            avg = _stats["total_ms"] / _stats["requests"]
            log.info(f"  req#{_stats['requests']}  items={_stats['items']}  avg={avg:.0f}ms")

        # Match Ollama's /api/embed response format.
        self._json(200, {
            "model": req.get("model", ""),
            "embeddings": vecs,
            "total_duration": int(elapsed_ms * 1_000_000),  # nanoseconds, Ollama-style
            "load_duration": 0,
            "prompt_eval_count": sum(len(s) for s in inputs),
        })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault-root", default=None,
                        help="Vault root directory (or set ROOST_VAULT env). Required.")
    parser.add_argument("--model-path", default=None,
                        help="Path to sentence-transformers model dir (default: <vault>/.roost/build/nomic-finetuned-hardneg)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"HTTP port (default: {DEFAULT_PORT})")
    parser.add_argument("--max-seq", type=int, default=DEFAULT_MAX_SEQ,
                        help=f"max_seq_length (default: {DEFAULT_MAX_SEQ}, matching training)")
    parser.add_argument("--host", default="127.0.0.1",
                        help="Bind host (default: 127.0.0.1 — loopback only for safety)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")

    vault_root = resolve_vault_root(args.vault_root)
    model_path = Path(args.model_path) if args.model_path else (vault_root / ".roost" / "build" / "nomic-finetuned-hardneg")
    if model_path.exists():
        load_model(model_path, args.max_seq)
    else:
        # No fine-tuned model present — fall back to the base model from
        # HuggingFace so the sidecar runs out of the box (it downloads on first
        # run). The fine-tuned model from finetune-embeddings.py is an optional
        # quality upgrade; pass it via --model-path once you have one.
        log.warning(
            f"Fine-tuned model not found at {model_path} — using base model "
            f"'{DEFAULT_BASE_MODEL}' (downloads on first run)."
        )
        load_model(DEFAULT_BASE_MODEL, args.max_seq)

    server = HTTPServer((args.host, args.port), EmbedHandler)
    log.info(f"Serving on http://{args.host}:{args.port}")
    log.info(f"  POST /api/embed        Ollama-compatible batched embed")
    log.info(f"  POST /transcribe       Speech-to-text (faster-whisper, if installed)")
    log.info(f"  GET  /health           Health + request stats")
    log.info(f"  Ctrl-C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info(f"Shutting down. Final stats: {_stats}")


if __name__ == "__main__":
    main()
