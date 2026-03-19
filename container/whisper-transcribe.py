#!/usr/bin/env python3
"""Stateless audio transcription: file path in (argv[1]), JSON out (stdout)."""
import json
import sys

from faster_whisper import WhisperModel

model = WhisperModel("tiny", device="cpu", compute_type="int8")
segments, info = model.transcribe(sys.argv[1], beam_size=1)
text = " ".join(s.text.strip() for s in segments)
json.dump({"text": text, "language": info.language, "duration": info.duration}, sys.stdout)
