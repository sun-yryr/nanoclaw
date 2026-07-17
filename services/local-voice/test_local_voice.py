from __future__ import annotations

import importlib.util
import io
import os
import sys
import tempfile
import threading
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("local_voice.py")


class RecorderStub:
    @staticmethod
    def get_available_devices() -> list[str]:
        return []


sys.modules.setdefault("pvporcupine", types.SimpleNamespace(create=lambda **_kwargs: None))
sys.modules.setdefault("webrtcvad", types.SimpleNamespace(Vad=lambda _mode: None))
sys.modules.setdefault("pvrecorder", types.SimpleNamespace(PvRecorder=RecorderStub))
spec = importlib.util.spec_from_file_location("local_voice", MODULE_PATH)
assert spec and spec.loader
local_voice = importlib.util.module_from_spec(spec)
sys.modules["local_voice"] = local_voice
spec.loader.exec_module(local_voice)


class FakeRecorder:
    def __init__(self, frames: list[list[int]]) -> None:
        self.frames = iter(frames)

    def read(self) -> list[int]:
        return next(self.frames)


class FakeVad:
    def __init__(self, decisions: list[bool]) -> None:
        self.decisions = iter(decisions)

    def is_speech(self, _frame: bytes, _sample_rate: int) -> bool:
        return next(self.decisions)


class LocalVoiceTests(unittest.TestCase):
    def test_pcm_to_wav_stays_in_memory_and_has_expected_format(self) -> None:
        encoded = local_voice.pcm_to_wav([0, 100, -100] * 100)
        with wave.open(io.BytesIO(encoded), "rb") as wav:
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getsampwidth(), 2)
            self.assertEqual(wav.getframerate(), 16_000)
            self.assertEqual(wav.getnframes(), 300)

    def test_build_config_uses_environment_credential(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            keyword = Path(directory) / "hey-nanoclaw.ppn"
            keyword.write_bytes(b"test model")
            args = types.SimpleNamespace(
                socket=str(Path(directory) / "voice.sock"),
                keyword=str(keyword),
                device_id="desk",
                input_device_index=-1,
                sensitivity=0.65,
                vad_mode=2,
                silence_ms=900,
                speech_start_timeout_ms=3_000,
                max_recording_ms=20_000,
                response_timeout_seconds=120,
            )
            with patch.dict(os.environ, {"PICOVOICE_ACCESS_KEY": "test-only"}, clear=True):
                config = local_voice.build_config(args)
            self.assertEqual(config.device_id, "desk")
            self.assertEqual(config.access_key, "test-only")
            self.assertEqual(config.keyword_path, keyword)

    def test_recording_stops_after_speech_and_trailing_silence(self) -> None:
        config = local_voice.Config(
            socket_path=Path("/tmp/unused.sock"),
            keyword_path=Path("/tmp/unused.ppn"),
            device_id="local",
            input_device_index=-1,
            sensitivity=0.65,
            vad_mode=2,
            silence_ms=40,
            speech_start_timeout_ms=1_000,
            max_recording_ms=2_000,
            response_timeout_seconds=120,
            access_key="test-only",
        )
        voice = object.__new__(local_voice.LocalVoice)
        voice.config = config
        voice.stop_event = threading.Event()
        voice.recorder = FakeRecorder([[1] * 512, [0] * 512])
        voice.vad = FakeVad([True, False, False])
        connection = types.SimpleNamespace(connected=True)

        samples = voice._record_command(connection)

        self.assertEqual(len(samples), 1024)


if __name__ == "__main__":
    unittest.main()
