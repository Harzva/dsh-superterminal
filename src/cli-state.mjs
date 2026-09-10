// Shared launch wrapper: workspace-local CLI state is protected and excluded from Git.
export const CLI_STATE_BOOTSTRAP = `export TERM=xterm-256color COLORTERM=truecolor
umask 077
base=$1
state=$2
shift 2
if [ -L "$base" ] || [ -L "$state" ] || [ -L "$base/.gitignore" ]; then
  printf 'DSH Terminal: refusing a symlinked CLI data directory\\n' >&2
  exit 1
fi
mkdir -p "$base" || exit 1
if [ ! -e "$base/.gitignore" ]; then
  ignore_tmp=$(mktemp "$base/.gitignore.XXXXXX") || exit 1
  printf '*\\n' > "$ignore_tmp" || exit 1
  ln "$ignore_tmp" "$base/.gitignore" 2>/dev/null || [ -f "$base/.gitignore" ] || exit 1
  rm -f "$ignore_tmp"
fi
if [ "$(cat "$base/.gitignore")" != '*' ]; then
  printf 'DSH Terminal: CLI data directory must be excluded from Git\\n' >&2
  exit 1
fi
mkdir -p "$state" || exit 1
chmod 700 "$base" "$state" || exit 1
exec "$@"`
