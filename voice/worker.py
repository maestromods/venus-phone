"""Local speech worker. JSON lines on stdio; no socket, API keys or cloud inference."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(ROOT / "models"))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("TQDM_DISABLE", "1")
os.environ.setdefault("NUMBA_CACHE_DIR", str(ROOT / "cache" / "numba"))
WIRE = sys.stdout
sys.stdout = sys.stderr  # third-party model progress must not corrupt the protocol
output_lock = threading.Lock()
model_lock = threading.Lock()
cancelled = set()
cancel_lock = threading.Lock()
tts = None
asr = None
default_conditionals = None
device = ""

def emit(message):
    with output_lock:
        WIRE.write(json.dumps(message, ensure_ascii=True) + "\n")
        WIRE.flush()

def voices():
    result = [{"id": "default", "name": "Chatterbox default voice"}]
    folder = ROOT / "voices"
    folder.mkdir(exist_ok=True)
    for file in sorted(folder.glob("*.json")):
        try:
            record = json.loads(file.read_text(encoding="utf-8"))
            if (folder / (file.stem + ".wav")).exists():
                result.append({"id": file.stem, "name": str(record["name"])[:80]})
        except (ValueError, KeyError):
            pass
    return result

def load():
    global tts, asr, default_conditionals, device
    if tts is None:
        import torch
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        torch.set_num_threads(6)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading Chatterbox Turbo on {device}.", file=sys.stderr)
        tts = ChatterboxTurboTTS.from_pretrained(device=device)
        default_conditionals = tts.conds
        if default_conditionals is None:
            raise RuntimeError("This model needs a voice reference. Add a 6-30 second WAV in the voice panel.")
    if asr is None:
        from faster_whisper import WhisperModel
        # CPU int8 leaves the 8 GB GPU available for expressive speech and the game.
        asr = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=6,
                           download_root=str(ROOT / "models" / "whisper"))
    return {"device": device, "voices": voices()}

def decode_audio(encoded):
    import soundfile as sf
    raw = base64.b64decode(encoded, validate=True)
    if not 44 <= len(raw) <= 4_000_000:
        raise ValueError("Audio is empty or too large.")
    data, sr = sf.read(io.BytesIO(raw), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    if len(data) / sr > 35:
        raise ValueError("Audio is limited to 35 seconds per turn.")
    return data, sr

def operation(method, params):
    if method == "voices":
        return {"voices": voices()}
    if method == "load":
        return load()
    if method == "add_voice":
        import soundfile as sf
        data, sr = decode_audio(params["audio"])
        if not 6 <= len(data) / sr <= 30:
            raise ValueError("Use a clear WAV reference between 6 and 30 seconds.")
        voice_id = str(uuid.uuid4())
        folder = ROOT / "voices"
        folder.mkdir(exist_ok=True)
        name = str(params.get("name", "Custom voice"))[:80]
        sf.write(str(folder / f"{voice_id}.wav"), data, sr, subtype="PCM_16")
        (folder / f"{voice_id}.json").write_text(json.dumps({"name": name}), encoding="utf-8")
        return {"id": voice_id, "voices": voices()}
    if tts is None or asr is None:
        raise ValueError("Load the models first.")
    if method == "speak":
        import numpy as np
        import soundfile as sf
        import torch
        text = str(params.get("text", "")).strip()
        if not text or len(text) > 550:
            raise ValueError("Voice text must be 1-550 characters.")
        voice = str(params.get("voice", "default"))
        if voice == "default":
            tts.conds = default_conditionals
        elif re.fullmatch(r"[a-f0-9-]{36}", voice):
            sample = ROOT / "voices" / f"{voice}.wav"
            if not sample.exists():
                raise ValueError("Voice reference not found.")
            tts.prepare_conditionals(str(sample))
        else:
            raise ValueError("Unknown voice.")
        start = time.monotonic()
        with torch.inference_mode():
            wav = tts.generate(text)
        audio = wav.squeeze().cpu().numpy()
        if not np.isfinite(audio).all():
            raise ValueError("Speech generation failed. Try again.")
        buf = io.BytesIO()
        sf.write(buf, audio, tts.sr, format="WAV", subtype="PCM_16")
        return {"audio": base64.b64encode(buf.getvalue()).decode("ascii"), "seconds": len(audio) / tts.sr,
                "generationSeconds": round(time.monotonic() - start, 2), "device": device}
    if method == "transcribe":
        import numpy as np
        import librosa
        audio, sr = decode_audio(params["audio"])
        if np.max(np.abs(audio), initial=0) < 0.005:
            return {"text": ""}
        if sr != 16000:
            audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
        segments, _ = asr.transcribe(audio, language="en", beam_size=1, vad_filter=True,
                                    condition_on_previous_text=False, no_speech_threshold=0.6)
        return {"text": " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()}
    raise ValueError("Unknown voice operation.")

def run(job):
    job_id = job["id"]
    try:
        with model_lock:
            with cancel_lock:
                skip = job_id in cancelled
            if skip:
                return
            result = operation(job["method"], job.get("params", {}))
        with cancel_lock:
            skip = job_id in cancelled
        if not skip:
            emit({"id": job_id, "result": result})
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        emit({"id": job_id, "error": f"Local voice: {exc}"})
    finally:
        with cancel_lock:
            cancelled.discard(job_id)

if __name__ == "__main__":
    # PyTorch's Windows DLL initialization must finish on the main thread before
    # stdin waits for another command. Models themselves still load on demand.
    print("Initializing local speech libraries…", file=sys.stderr, flush=True)
    import torch
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    from faster_whisper import WhisperModel
    print("Local speech libraries initialized.", file=sys.stderr, flush=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        for line in sys.stdin:
            try:
                job = json.loads(line)
                if job.get("method") == "cancel":
                    with cancel_lock:
                        cancelled.add(job["params"]["id"])
                else:
                    pool.submit(run, job)
            except (ValueError, KeyError):
                print("Invalid worker command", file=sys.stderr)
