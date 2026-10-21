# Sourced as root by the official desktop entrypoint. Never removes user state.
cp /run/nanoclaw-gui/ca.crt /usr/local/share/ca-certificates/nanoclaw-onecli.crt
update-ca-certificates >/dev/null 2>&1
install -d -m 0700 -o cua -g cua /home/cua/.pki/nssdb
if [ ! -f /home/cua/.pki/nssdb/cert9.db ]; then
    runuser -u cua -- certutil -N -d sql:/home/cua/.pki/nssdb --empty-password
fi
runuser -u cua -- certutil -D -d sql:/home/cua/.pki/nssdb -n NanoClaw-OneCLI >/dev/null 2>&1 || true
runuser -u cua -- certutil -A -d sql:/home/cua/.pki/nssdb -n NanoClaw-OneCLI -t 'C,,' -i /run/nanoclaw-gui/ca.crt
# Root-only upstream config; desktop processes inherit only the local proxy URL.
python3 /opt/nanoclaw-gui/proxy.py &
