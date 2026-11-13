#!/usr/bin/env bash
# A stand-in for the Cloud SDK CLI in test/cloudbuild.test.ts: it records each call's arguments in
# $FAKE_GCLOUD_LOG (each followed by a unit separator, then a record separator), and keeps the
# storage commands the release uses working on a local directory, $FAKE_GCS. Other calls are only
# recorded.
set -euo pipefail
printf '%s\037' "$@" >> "$FAKE_GCLOUD_LOG"
printf '\036' >> "$FAKE_GCLOUD_LOG"

# gs://<bucket>/<name> is $FAKE_GCS/<bucket>/<name>; a local path is itself.
local_path() {
  case "$1" in
    gs://*) printf '%s' "$FAKE_GCS/${1#gs://}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# The stand-in for a CRC32C hash: the file's cksum, which changes with its bytes as CRC32C does.
checksum() { cksum < "$1" | cut -d' ' -f1; }

case "$1 $2" in
  "storage cp")
    shift 2
    NO_CLOBBER=
    FILES=()
    for ARG in "$@"; do
      case "$ARG" in
        --no-clobber) NO_CLOBBER=1 ;;
        --*) ;;
        *) FILES+=("$ARG") ;;
      esac
    done
    DEST="${FILES[-1]}"
    for SRC in "${FILES[@]:0:${#FILES[@]}-1}"; do
      TARGET="$(local_path "$DEST")"
      case "$DEST" in */) TARGET="$TARGET$(basename "$SRC")" ;; esac
      if [ -n "$NO_CLOBBER" ] && [ -e "$TARGET" ]; then
        echo "Skipping existing destination item (no-clobber): $DEST" >&2
        continue
      fi
      mkdir -p "$(dirname "$TARGET")"
      cp "$(local_path "$SRC")" "$TARGET"
    done
    ;;
  "storage hash")
    checksum "$3"
    ;;
  "storage objects")
    [ "$3" = describe ] || { echo "fake: storage objects $3 is not faked" >&2; exit 2; }
    TARGET="$(local_path "$4")"
    [ -e "$TARGET" ] || { echo "ERROR: $4 not found: 404." >&2; exit 1; }
    checksum "$TARGET"
    ;;
esac
