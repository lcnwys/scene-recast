"""Thin adapter for the original Auto Ducking core; no copied user media/config."""
import json
import sys
from pathlib import Path
from core import Segment, group_words, merge_segments, padded_segments, render_video

operation, metadata_path, settings_json = sys.argv[1:4]
data = json.loads(Path(metadata_path).read_text())
settings = json.loads(settings_json)
duration = data.get("duration", data.get("media", {}).get("duration", 0))
words = data.get("speechWords", [])
raw = [Segment(w["start"], w["end"]) for w in words if w.get("type") == "word"]
if settings.get("manual_segments") is not None:
    segments = merge_segments([Segment(s["start"], s["end"]) for s in settings["manual_segments"]])
elif words:
    segments = group_words(words, settings["gap"], duration)
else:
    raw = [Segment(s.get("speechStart", s["start"]), s.get("speechEnd", s["end"])) for s in data.get("segments", [])]
    segments = merge_segments(raw, settings["gap"])
if operation == "timeline":
    print(json.dumps({"duration": duration, "raw": [s.as_dict() for s in raw], "segments": [s.as_dict() for s in segments], "windows": [s.as_dict() for s in padded_segments(segments, duration, settings["pre"], settings["post"])]}))
elif operation == "render":
    video, music, output = map(Path, sys.argv[4:7])
    params = {key: settings[key] for key in ("reduction_db", "normal_music_db", "pre", "post", "attack", "release")}
    print(json.dumps(render_video(video, music, output, segments, **params)))
else:
    raise ValueError("Unknown operation")
