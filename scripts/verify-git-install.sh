#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
if ! git diff --quiet || ! git diff --cached --quiet; then
	echo "verify-git-install requires a clean tracked working tree" >&2
	exit 1
fi
git ls-files --error-unmatch package.json >/dev/null
commit=$(git rev-parse HEAD)
mkdir -p "$root/.artifacts"
temporary_root=$(mktemp -d "$root/.artifacts/git-install.XXXXXX")
server_pid=""
cleanup() {
	if [[ -n "$server_pid" ]]; then
		kill "$server_pid" 2>/dev/null || true
		wait "$server_pid" 2>/dev/null || true
	fi
	rm -rf "$temporary_root"
}
trap cleanup EXIT

make -C "$root" apply PI_AGENT_DIR="$temporary_root/local-agent"
make -C "$root" verify-apply PI_AGENT_DIR="$temporary_root/local-agent"
unlink "$temporary_root/local-agent/extensions/flurdy-session-mode"
if make -C "$root" verify-apply PI_AGENT_DIR="$temporary_root/local-agent" >/dev/null 2>&1; then
	echo "Removed checkout link incorrectly passed verification" >&2
	exit 1
fi

http_root="$temporary_root/http"
mkdir -p "$http_root/flurdy"
git clone --bare --no-local "$root" "$http_root/flurdy/pi-session-mode.git" >/dev/null
git --git-dir="$http_root/flurdy/pi-session-mode.git" update-server-info
port=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$http_root" >"$temporary_root/http.log" 2>&1 &
server_pid=$!
url="http://localhost:$port/flurdy/pi-session-mode.git"
for _ in $(seq 1 50); do
	if git ls-remote "$url" HEAD >/dev/null 2>&1; then break; fi
	sleep 0.1
done
git ls-remote "$url" HEAD >/dev/null
agent_dir="$temporary_root/agent"
work_dir="$temporary_root/work"
mkdir -p "$agent_dir" "$work_dir"
(
	cd "$work_dir"
	PI_CODING_AGENT_DIR="$agent_dir" PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 GIT_TERMINAL_PROMPT=0 \
		pi install "git:$url@$commit"
)
installed="$agent_dir/git/localhost/flurdy/pi-session-mode"
test "$(git -C "$installed" rev-parse HEAD)" = "$commit"
node "$root/scripts/verify-installed.mjs" "$agent_dir" "$work_dir" "$installed"
echo "Immutable Git package and lease lifecycle: PASS ($commit)"
