#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEYWORD_SOURCE="${1:-}"

if [[ -z "$KEYWORD_SOURCE" || ! -f "$KEYWORD_SOURCE" ]]; then
  echo "Usage: $0 /path/to/hey-nanoclaw_en_linux.ppn" >&2
  exit 2
fi

if ! command -v systemctl >/dev/null || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "A systemd user session is required." >&2
  exit 1
fi
if ! command -v systemd-creds >/dev/null; then
  echo "systemd-creds is required for encrypted Picovoice credential storage." >&2
  exit 1
fi
if ! command -v aplay >/dev/null; then
  echo "aplay is required. Install the alsa-utils package first." >&2
  exit 1
fi

source "$ROOT/setup/lib/install-slug.sh"
HOST_UNIT="$(systemd_unit)"
VOICE_UNIT="${HOST_UNIT}-local-voice"
STATE_DIR="$ROOT/data/local-voice"
MODEL_DIR="$STATE_DIR/models"
VENV_DIR="$STATE_DIR/venv"
MODEL_PATH="$MODEL_DIR/hey-nanoclaw.ppn"
SOCKET_PATH="$ROOT/data/local-voice.sock"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/${VOICE_UNIT}.service"
CREDENTIAL_DIR="$HOME/.config/credstore.encrypted"
CREDENTIAL_PATH="$CREDENTIAL_DIR/${VOICE_UNIT}-picovoice"

mkdir -p "$MODEL_DIR" "$UNIT_DIR" "$CREDENTIAL_DIR"
chmod 700 "$STATE_DIR" "$MODEL_DIR" "$CREDENTIAL_DIR"
cp "$KEYWORD_SOURCE" "$MODEL_PATH"
chmod 600 "$MODEL_PATH"

if [[ ! -f "$CREDENTIAL_PATH" ]]; then
  echo "Create the encrypted Picovoice credential, then rerun this installer:" >&2
  echo "  systemd-creds encrypt --name=picovoice_access_key - '$CREDENTIAL_PATH'" >&2
  exit 3
fi

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check \
  --requirement "$ROOT/services/local-voice/requirements.txt"

cat >"$STATE_DIR/config.json" <<JSON
{
  "enabled": true,
  "socketPath": "$SOCKET_PATH",
  "sttModel": "gpt-4o-mini-transcribe",
  "ttsModel": "gpt-4o-mini-tts",
  "ttsVoice": "alloy",
  "requestTimeoutMs": 60000,
  "deliveryTimeoutMs": 120000
}
JSON
chmod 600 "$STATE_DIR/config.json"

cat >"$UNIT_PATH" <<UNIT
[Unit]
Description=NanoClaw local wake-word voice
Requires=${HOST_UNIT}.service
After=${HOST_UNIT}.service sound.target
PartOf=${HOST_UNIT}.service

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$VENV_DIR/bin/python $ROOT/services/local-voice/local_voice.py --socket $SOCKET_PATH --keyword $MODEL_PATH
LoadCredentialEncrypted=picovoice_access_key:$CREDENTIAL_PATH
Restart=on-failure
RestartSec=2
TimeoutStopSec=10
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now "$VOICE_UNIT"
systemctl --user restart "$HOST_UNIT"
echo "Installed and started ${VOICE_UNIT}.service"
