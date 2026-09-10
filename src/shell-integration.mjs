import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CommandJournal } from './command-journal.mjs'
import { BASH_PREEXEC } from './bash-preexec.mjs'

// The private OSC uses a per-PTY nonce on every frame, unlike unauthenticated
// OSC 133 boundaries. It protects against unrelated output, not malicious code
// running as the same OS user. No frame authorizes execution or model input.
// Hook contracts: zsh.sourceforge.io/Doc/Release/Functions.html#Hook-Functions
// bash-preexec preserves existing prompt hooks; conflicting DEBUG is declined.
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
const expand = value => value.replaceAll('@{', '${')
const HOOKS = expand(String.raw`
_DSH_COMMAND_SEQUENCE=0
_DSH_COMMAND_ACTIVE=0
_DSH_COMMAND_READY=0
_dsh_command_precmd() {
  local _dsh_result=$?
  if [ "$_DSH_COMMAND_READY" -eq 0 ]; then
    builtin printf '\033]777;dsh-command;%s;0;R;\007' "$_DSH_COMMAND_NONCE"
    _DSH_COMMAND_READY=1
  elif [ "$_DSH_COMMAND_ACTIVE" -eq 1 ]; then
    builtin printf '\033]777;dsh-command;%s;%s;D;%s\007' "$_DSH_COMMAND_NONCE" "$_DSH_COMMAND_SEQUENCE" "$_dsh_result"
  fi
  _DSH_COMMAND_ACTIVE=0
  return 0
}
_dsh_command_preexec() {
  local _dsh_command="$1" _dsh_truncated=0 _dsh_encoded
  if [ -z "$_dsh_command" ] && [ -n "@{ZSH_VERSION-}" ]; then _dsh_command="$3"; fi
  if [ -z "$_dsh_command" ]; then return 0; fi
  if [ "@{#_dsh_command}" -gt 2048 ]; then _dsh_command="@{_dsh_command:0:2048}"; _dsh_truncated=1; fi
  _dsh_encoded=$(builtin printf '%s' "$_dsh_command" | command base64 | command tr -d '\r\n')
  if [ -z "$_dsh_encoded" ]; then return 0; fi
  _DSH_COMMAND_SEQUENCE=$((_DSH_COMMAND_SEQUENCE + 1))
  _DSH_COMMAND_ACTIVE=1
  builtin printf '\033]777;dsh-command;%s;%s;C;%s;%s\007' "$_DSH_COMMAND_NONCE" "$_DSH_COMMAND_SEQUENCE" "$_dsh_truncated" "$_dsh_encoded"
  return 0
}
`)

const ZSH_REGISTER = expand(String.raw`
# Zsh prints its partial-line marker before precmd. Keep the user's marker,
# adding a zero-width boundary so its padding never becomes command output.
PROMPT_EOL_MARK=$'%{\033]777;dsh-command;'"$_DSH_COMMAND_NONCE"$';0;P;\007%}'"@{PROMPT_EOL_MARK-'%B%S%#%s%b'}"
typeset -ga precmd_functions preexec_functions
precmd_functions=(_dsh_command_precmd "@{precmd_functions[@]}")
preexec_functions=(_dsh_command_preexec "@{preexec_functions[@]}")
`)
const BASH_REGISTER = expand(String.raw`
precmd_functions=(_dsh_command_precmd "@{precmd_functions[@]}")
preexec_functions=(_dsh_command_preexec "@{preexec_functions[@]}")
`)

/** Temporary startup wrappers load, but never edit, the user's normal rc files. */
export async function prepareShellIntegration(executable, args = [], options = {}) {
  const shell = basename(executable)
  const fallback = reason => ({ argv: [executable, ...args], env: {}, journal: new CommandJournal(null, reason), async dispose() {} })
  if (!['zsh', 'bash'].includes(shell)) return fallback('此 Shell 暂不支持命令记录')
  let directory
  try {
    // The Linux bwrap provider mounts a fresh /tmp, hiding host-created rc
    // wrappers there. /var/tmp remains readable in that same sandbox profile.
    directory = await mkdtemp(join(options.tempRoot ?? (process.platform === 'linux' ? '/var/tmp' : tmpdir()), 'dsh-shell-'))
    const nonce = randomBytes(24).toString('hex')
    const disable = `builtin printf '\\033]777;dsh-command;%s;0;X;configuration\\007' ${quote(nonce)}\nreturn 0\n`
    const header = `readonly _DSH_COMMAND_NONCE=${quote(nonce)}\n`
    const available = `if ! command -v base64 >/dev/null 2>&1 || ! command -v tr >/dev/null 2>&1; then\n${disable}fi\n`
    const environment = options.environment ?? process.env
    let argv, env = {}
    if (shell === 'zsh') {
      const restore = environment.ZDOTDIR === undefined ? 'unset ZDOTDIR' : `ZDOTDIR=${quote(environment.ZDOTDIR)}`
      const zshenv = `${restore}\n` + expand(String.raw`
if [[ -r "@{ZDOTDIR-$HOME}/.zshenv" ]]; then source "@{ZDOTDIR-$HOME}/.zshenv"; fi
typeset -g _DSH_USER_ZDOTDIR_SET=@{+ZDOTDIR}
typeset -g _DSH_USER_ZDOTDIR=@{ZDOTDIR-}
`) + `ZDOTDIR=${quote(directory)}\n`
      const zshrc = expand(String.raw`
if (( _DSH_USER_ZDOTDIR_SET )); then ZDOTDIR=$_DSH_USER_ZDOTDIR; else unset ZDOTDIR; fi
unset _DSH_USER_ZDOTDIR_SET _DSH_USER_ZDOTDIR
if [[ -r "@{ZDOTDIR-$HOME}/.zshrc" ]]; then source "@{ZDOTDIR-$HOME}/.zshrc"; fi
`) + available + header + HOOKS + ZSH_REGISTER
      await writeFile(join(directory, '.zshenv'), zshenv, { mode: 0o600 })
      await writeFile(join(directory, '.zshrc'), zshrc, { mode: 0o600 })
      env = { ZDOTDIR: directory }
      argv = [executable, '-i']
    } else {
      const bashrc = expand(String.raw`
if [[ -r "$HOME/.bashrc" ]]; then source "$HOME/.bashrc"; fi
`) + `if shopt -q extdebug || { [[ -z "\${bash_preexec_imported-}" ]] && [[ -n "$(trap -p DEBUG)" ]]; }; then\n${disable}fi\n`
        + available + header + `if [[ -z "\${bash_preexec_imported-}" ]]; then\n${BASH_PREEXEC}\nfi\n` + HOOKS + BASH_REGISTER
      const rc = join(directory, 'bashrc')
      await writeFile(rc, bashrc, { mode: 0o600 })
      argv = [executable, '--rcfile', rc, '-i']
    }
    return { argv, env, journal: new CommandJournal(nonce), async dispose() { await rm(directory, { recursive: true, force: true }) } }
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    return fallback('命令记录暂时无法启用，终端仍可正常使用')
  }
}
