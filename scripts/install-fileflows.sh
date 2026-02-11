#!/bin/bash
set -e

INSTALL_DIR="/opt/vobsub2srt"
BIN_DIR="/usr/local/bin"
REPO="regix1/VobSub2SRT"

handle_error() {
    echo "Error: Installation failed"
    exit 1
}
trap 'handle_error' ERR

if [ "$1" == "--uninstall" ]; then
    echo "Uninstalling VobSub2SRT..."
    rm -f "$BIN_DIR/vobsub2srt"
    rm -f /app/FlowRunner/vobsub2srt
    rm -rf "$INSTALL_DIR"
    echo "VobSub2SRT successfully uninstalled."
    exit 0
fi

if ! command -v mkvextract &>/dev/null; then
    echo "Warning: MKVToolNix not found. You may need it to extract VobSub from MKV files."
fi

install_from_release() {
    echo "Downloading latest release from GitHub..."
    local download_url
    download_url=$(wget -qO- "https://api.github.com/repos/$REPO/releases/latest" \
        | grep -o '"browser_download_url": *"[^"]*linux-x86_64[^"]*"' \
        | head -1 \
        | cut -d'"' -f4)

    if [ -n "$download_url" ]; then
        mkdir -p "$INSTALL_DIR"
        wget -qO- "$download_url" | tar xzf - -C "$INSTALL_DIR"
        chmod +x "$INSTALL_DIR/vobsub2srt"
        return 0
    fi
    return 1
}

install_from_source() {
    echo "No release found, building from source..."
    local build_dir="/tmp/VobSub2SRT"

    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y git cmake make pkg-config g++ \
        libtiff5-dev libtesseract-dev tesseract-ocr-eng

    rm -rf "$build_dir"
    git clone "https://github.com/$REPO.git" "$build_dir"
    cd "$build_dir"

    ./configure
    make -j$(nproc)

    mkdir -p "$INSTALL_DIR"
    cp "$build_dir/build/bin/vobsub2srt" "$INSTALL_DIR/"
    chmod +x "$INSTALL_DIR/vobsub2srt"
    strip "$INSTALL_DIR/vobsub2srt"

    rm -rf "$build_dir"
}

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y wget ca-certificates tesseract-ocr-eng

install_from_release || install_from_source

ln -sf "$INSTALL_DIR/vobsub2srt" "$BIN_DIR/vobsub2srt"

if [ -d "/app/FlowRunner" ]; then
    ln -sf "$INSTALL_DIR/vobsub2srt" /app/FlowRunner/vobsub2srt
    echo "Created symlink in /app/FlowRunner/"
fi

if [ -f "$INSTALL_DIR/vobsub2srt" ]; then
    echo ""
    echo "==================== Installation Complete ===================="
    echo "VobSub2SRT successfully installed"
    echo "Location: $INSTALL_DIR/vobsub2srt"
    echo ""
    exit 0
else
    echo "Error: Failed to verify installation"
    exit 1
fi
