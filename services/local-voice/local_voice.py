#!/usr/bin/env python3
"""Local microphone sidecar for NanoClaw's local-voice channel."""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import queue
import signal
import socket
import subprocess
import threading
import time
import uuid
import wave
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pvporcupine
import webrtcvad
from pvrecorder import PvRecorder


PROTOCOL_VERSION = 1
SAMPLE_RATE = 16_000
VAD_FRAME_MS = 20
VAD_FRAME_SAMPLES = SAMPLE_RATE * VAD_FRAME_MS // 1000
MAX_MESSAGE_BYTES = 4 * 1024 * 1024


@dataclass(frozen=True)
class Config:
    socket_path: Path
    keyword_path: Path
    device_id: str
    input_device_index: int
    sensitivity: float
    vad_mode: int
    silence_ms: int
    speech_start_timeout_ms: int
    max_recording_ms: int
    response_timeout_seconds: int
    access_key: str


class HostConnection:
    def __init__(self, socket_path: Path, device_id: str) -> None:
        self.socket_path = socket_path
        self.device_id = device_id
        self.messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self._socket: socket.socket | None = None
        self._send_lock = threading.Lock()
        self._connected = threading.Event()

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(str(self.socket_path))
        self._socket = sock
        self._connected.set()
        threading.Thread(target=self._read_loop, daemon=True, name="local-voice-ipc").start()
        self.send({"type": "hello", "protocol": PROTOCOL_VERSION, "deviceId": self.device_id})

        ready = self.next_message(timeout=10)
        if ready.get("type") != "ready" or ready.get("protocol") != PROTOCOL_VERSION:
            self.close()
            raise RuntimeError(f"Unexpected host handshake: {ready.get('type')}")

    def close(self) -> None:
        self._connected.clear()
        sock, self._socket = self._socket, None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()

    def send(self, payload: dict[str, Any]) -> None:
        encoded = (json.dumps(payload, separators=(",", ":")) + "\n").encode()
        if len(encoded) > MAX_MESSAGE_BYTES:
            raise ValueError("IPC message exceeds maximum size")
        with self._send_lock:
            if self._socket is None:
                raise ConnectionError("NanoClaw local-voice socket is disconnected")
            self._socket.sendall(encoded)

    def next_message(self, timeout: float) -> dict[str, Any]:
        message = self.messages.get(timeout=timeout)
        if message.get("type") == "disconnected":
            raise ConnectionError("NanoClaw local-voice socket disconnected")
        return message

    def poll_message(self) -> dict[str, Any] | None:
        try:
            return self.next_message(timeout=0)
        except queue.Empty:
            return None

    def _read_loop(self) -> None:
        buffer = bytearray()
        try:
            while self._connected.is_set() and self._socket is not None:
                chunk = self._socket.recv(64 * 1024)
                if not chunk:
                    break
                buffer.extend(chunk)
                if len(buffer) > MAX_MESSAGE_BYTES:
                    raise ValueError("IPC message exceeds maximum size")
                while b"\n" in buffer:
                    line, _, remainder = buffer.partition(b"\n")
                    buffer = bytearray(remainder)
                    if not line.strip():
                        continue
                    message = json.loads(line)
                    if isinstance(message, dict):
                        self.messages.put(message)
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        finally:
            self._connected.clear()
            self.messages.put({"type": "disconnected"})


class LocalVoice:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.stop_event = threading.Event()
        self.porcupine = pvporcupine.create(
            access_key=config.access_key,
            keyword_paths=[str(config.keyword_path)],
            sensitivities=[config.sensitivity],
        )
        self.recorder = PvRecorder(
            device_index=config.input_device_index,
            frame_length=self.porcupine.frame_length,
        )
        self.vad = webrtcvad.Vad(config.vad_mode)

    def close(self) -> None:
        try:
            self.recorder.stop()
        except (OSError, RuntimeError):
            pass
        self.recorder.delete()
        self.porcupine.delete()

    def run(self) -> None:
        retry_seconds = 1
        while not self.stop_event.is_set():
            connection = HostConnection(self.config.socket_path, self.config.device_id)
            try:
                connection.connect()
                retry_seconds = 1
                print("local-voice: connected and listening", flush=True)
                self._run_connected(connection)
            except (ConnectionError, FileNotFoundError, OSError, queue.Empty, RuntimeError) as error:
                if not self.stop_event.is_set():
                    print(f"local-voice: reconnecting after {type(error).__name__}", flush=True)
            finally:
                connection.close()
                try:
                    self.recorder.stop()
                except (OSError, RuntimeError):
                    pass

            if not self.stop_event.wait(retry_seconds):
                retry_seconds = min(retry_seconds * 2, 30)

    def _run_connected(self, connection: HostConnection) -> None:
        self.recorder.start()
        while not self.stop_event.is_set() and connection.connected:
            pending = connection.poll_message()
            if pending is not None:
                if pending.get("type") == "speak":
                    self.recorder.stop()
                    self._play_message(connection, pending)
                    if connection.connected and not self.stop_event.is_set():
                        self.recorder.start()
                continue

            pcm = self.recorder.read()
            if self.porcupine.process(pcm) < 0:
                continue

            print("local-voice: wake word detected", flush=True)
            command_pcm = self._record_command(connection)
            self.recorder.stop()
            if not command_pcm:
                self.recorder.start()
                continue

            turn_id = uuid.uuid4().hex
            wav = pcm_to_wav(command_pcm)
            connection.send(
                {
                    "type": "audio",
                    "id": turn_id,
                    "wavBase64": base64.b64encode(wav).decode("ascii"),
                }
            )
            self._wait_for_reply(connection, turn_id)
            if connection.connected and not self.stop_event.is_set():
                self.recorder.start()

    def _record_command(self, connection: HostConnection) -> list[int]:
        samples: list[int] = []
        vad_buffer = bytearray()
        speech_seen = False
        silence_ms = 0
        started_at = time.monotonic()

        while not self.stop_event.is_set() and connection.connected:
            pcm = self.recorder.read()
            samples.extend(pcm)
            vad_buffer.extend(array("h", pcm).tobytes())

            while len(vad_buffer) >= VAD_FRAME_SAMPLES * 2:
                frame = bytes(vad_buffer[: VAD_FRAME_SAMPLES * 2])
                del vad_buffer[: VAD_FRAME_SAMPLES * 2]
                is_speech = self.vad.is_speech(frame, SAMPLE_RATE)
                if is_speech:
                    speech_seen = True
                    silence_ms = 0
                elif speech_seen:
                    silence_ms += VAD_FRAME_MS

            elapsed_ms = int((time.monotonic() - started_at) * 1000)
            if speech_seen and silence_ms >= self.config.silence_ms:
                return samples
            if not speech_seen and elapsed_ms >= self.config.speech_start_timeout_ms:
                return []
            if elapsed_ms >= self.config.max_recording_ms:
                return samples if speech_seen else []
        return []

    def _wait_for_reply(self, connection: HostConnection, turn_id: str) -> None:
        deadline = time.monotonic() + self.config.response_timeout_seconds
        while not self.stop_event.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                print("local-voice: response timed out", flush=True)
                return
            try:
                message = connection.next_message(timeout=min(remaining, 0.25))
            except queue.Empty:
                continue
            message_type = message.get("type")

            if message_type == "error" and message.get("id") == turn_id:
                print("local-voice: speech request failed", flush=True)
                return
            if message_type != "speak":
                continue

            self._play_message(connection, message)
            return

    def _play_message(self, connection: HostConnection, message: dict[str, Any]) -> None:
        delivery_id = message.get("id")
        encoded = message.get("wavBase64")
        if not isinstance(delivery_id, str) or not isinstance(encoded, str):
            return
        try:
            audio = base64.b64decode(encoded, validate=True)
            play_wav(audio)
            connection.send({"type": "ack", "id": delivery_id})
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            connection.send(
                {
                    "type": "error",
                    "id": delivery_id,
                    "message": f"Playback failed: {type(error).__name__}",
                }
            )


def pcm_to_wav(samples: list[int]) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(array("h", samples).tobytes())
    return output.getvalue()


def play_wav(audio: bytes) -> None:
    if len(audio) > 2 * 1024 * 1024:
        raise ValueError("TTS audio exceeds maximum size")
    subprocess.run(
        ["aplay", "--quiet"],
        input=audio,
        check=True,
        timeout=180,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="NanoClaw local wake-word sidecar")
    parser.add_argument("--socket", default=os.environ.get("LOCAL_VOICE_SOCKET_PATH", "data/local-voice.sock"))
    parser.add_argument("--keyword", default=os.environ.get("LOCAL_VOICE_KEYWORD_PATH"))
    parser.add_argument("--device-id", default=os.environ.get("LOCAL_VOICE_DEVICE_ID", "local"))
    parser.add_argument("--input-device-index", type=int, default=-1)
    parser.add_argument("--sensitivity", type=float, default=0.65)
    parser.add_argument("--vad-mode", type=int, choices=range(4), default=2)
    parser.add_argument("--silence-ms", type=int, default=900)
    parser.add_argument("--speech-start-timeout-ms", type=int, default=3_000)
    parser.add_argument("--max-recording-ms", type=int, default=20_000)
    parser.add_argument("--response-timeout-seconds", type=int, default=120)
    parser.add_argument("--list-devices", action="store_true")
    return parser.parse_args()


def build_config(args: argparse.Namespace) -> Config:
    access_key = os.environ.get("PICOVOICE_ACCESS_KEY", "")
    credentials_directory = os.environ.get("CREDENTIALS_DIRECTORY")
    if not access_key and credentials_directory:
        credential_path = Path(credentials_directory) / "picovoice_access_key"
        try:
            access_key = credential_path.read_text(encoding="utf-8").strip()
        except OSError:
            pass
    if not access_key:
        raise SystemExit("PICOVOICE_ACCESS_KEY or the systemd picovoice_access_key credential is required")
    if not args.keyword:
        raise SystemExit("--keyword or LOCAL_VOICE_KEYWORD_PATH is required")
    keyword_path = Path(args.keyword).expanduser().resolve()
    if not keyword_path.is_file():
        raise SystemExit(f"Wake-word model not found: {keyword_path}")
    if not 0 <= args.sensitivity <= 1:
        raise SystemExit("--sensitivity must be between 0 and 1")
    if not args.device_id or len(args.device_id) > 64:
        raise SystemExit("--device-id must be between 1 and 64 characters")

    return Config(
        socket_path=Path(args.socket).expanduser().resolve(),
        keyword_path=keyword_path,
        device_id=args.device_id,
        input_device_index=args.input_device_index,
        sensitivity=args.sensitivity,
        vad_mode=args.vad_mode,
        silence_ms=max(100, args.silence_ms),
        speech_start_timeout_ms=max(500, args.speech_start_timeout_ms),
        max_recording_ms=max(1_000, args.max_recording_ms),
        response_timeout_seconds=max(10, args.response_timeout_seconds),
        access_key=access_key,
    )


def main() -> None:
    args = parse_args()
    if args.list_devices:
        for index, name in enumerate(PvRecorder.get_available_devices()):
            print(f"{index}: {name}")
        return

    voice = LocalVoice(build_config(args))

    def stop(_signum: int, _frame: Any) -> None:
        voice.stop_event.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        voice.run()
    finally:
        voice.close()


if __name__ == "__main__":
    main()
