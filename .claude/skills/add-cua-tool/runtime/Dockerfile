FROM ghcr.io/trycua/linux@sha256:6feb7823caf090e7578cafb7c751cdb422a9682e58d32826e681b63acfa5678c
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
COPY proxy.py /opt/nanoclaw-gui/proxy.py
COPY 30-nanoclaw.sh /opt/cua/entrypoint.d/30-nanoclaw.sh
COPY chromium-policy.json /etc/chromium/policies/managed/nanoclaw.json
COPY browser.desktop /etc/xdg/autostart/nanoclaw-browser.desktop
ENV HTTP_PROXY=http://127.0.0.1:3128 HTTPS_PROXY=http://127.0.0.1:3128 http_proxy=http://127.0.0.1:3128 https_proxy=http://127.0.0.1:3128 NO_PROXY=localhost,127.0.0.1
