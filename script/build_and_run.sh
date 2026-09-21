#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-start}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

# Keep the existing Expo modes while starting the services used by /listen.
case "$MODE" in
  start|run|--ios|ios|--android|android|--web|web|--dev-client|dev-client)
    if [[ "${MURMUR_SERVICES_STARTED:-}" != "1" ]]; then
      exec node --env-file-if-exists=.env.local scripts/run-listening.mjs "$MODE"
    fi
    ;;
esac

show_usage() {
  cat <<'USAGE'
usage: ./script/build_and_run.sh [mode]

Modes:
  start, run        Start PostgreSQL, the listening services, and Expo Go
  --ios, ios        Start Expo and open iOS
  --android, android
                    Start Expo and open Android
  --web, web        Start Expo for web
  --dev-client, dev-client
                    Start Expo in development-client mode
  --tunnel, tunnel  Start Expo only; remote voice requires a configured WSS gateway
  --export-web, export-web
                    Export the web build locally
  --doctor, doctor  Run Expo diagnostics
  --help, help      Show this help
USAGE
}

resolve_expo_cmd() {
  if [[ -n "${EXPO_CLI:-}" ]]; then
    # Optional escape hatch for projects that need a wrapper command.
    # shellcheck disable=SC2206
    EXPO_CMD=(${EXPO_CLI})
    return
  fi

  if [[ -f pnpm-lock.yaml ]] && command -v pnpm >/dev/null 2>&1; then
    EXPO_CMD=(pnpm exec expo)
  elif [[ -f yarn.lock ]] && command -v yarn >/dev/null 2>&1; then
    EXPO_CMD=(yarn expo)
  elif { [[ -f bun.lock ]] || [[ -f bun.lockb ]]; } && command -v bun >/dev/null 2>&1; then
    EXPO_CMD=(bunx expo)
  else
    EXPO_CMD=(npx expo)
  fi
}

run_doctor() {
  if [[ -f pnpm-lock.yaml ]] && command -v pnpm >/dev/null 2>&1; then
    pnpm exec expo-doctor
  elif [[ -f yarn.lock ]] && command -v yarn >/dev/null 2>&1; then
    yarn expo-doctor
  elif { [[ -f bun.lock ]] || [[ -f bun.lockb ]]; } && command -v bun >/dev/null 2>&1; then
    bunx expo-doctor
  else
    npx expo-doctor
  fi
}

resolve_expo_cmd

select_dev_port() {
  local candidate="${MURMUR_EXPO_PORT:-8081}"

  if ! command -v lsof >/dev/null 2>&1; then
    printf '%s' "$candidate"
    return
  fi

  while lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; do
    candidate=$((candidate + 1))
  done

  printf '%s' "$candidate"
}

MURMUR_DEV_PORT="$(select_dev_port)"

case "$MODE" in
  start|run)
    exec "${EXPO_CMD[@]}" start --go --lan --port "$MURMUR_DEV_PORT"
    ;;
  --ios|ios)
    exec "${EXPO_CMD[@]}" start --go --lan --ios --port "$MURMUR_DEV_PORT"
    ;;
  --android|android)
    exec "${EXPO_CMD[@]}" start --go --lan --android --port "$MURMUR_DEV_PORT"
    ;;
  --web|web)
    exec "${EXPO_CMD[@]}" start --web --port "$MURMUR_DEV_PORT"
    ;;
  --dev-client|dev-client)
    exec "${EXPO_CMD[@]}" start --dev-client --port "$MURMUR_DEV_PORT"
    ;;
  --tunnel|tunnel)
    exec "${EXPO_CMD[@]}" start --tunnel --port "$MURMUR_DEV_PORT"
    ;;
  --export-web|export-web)
    exec "${EXPO_CMD[@]}" export --platform web
    ;;
  --doctor|doctor)
    run_doctor
    ;;
  --help|help)
    show_usage
    ;;
  *)
    show_usage >&2
    exit 2
    ;;
esac
