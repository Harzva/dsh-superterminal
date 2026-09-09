# DSH Terminal

Native, resizable terminal panes for DeepSeek Harness. Run installed Shell, Codex, and Claude Code CLIs inside the current DSH session.

**DSH 原生多面板终端**：拖动调节大小，左右／上下拆分，用不同窗格承载不同 CLI。显示名 **DSH Terminal**，包名 **@harzva/dsh-terminal**，仓库 **Harzva/dsh-terminal**。

This is an **alpha** for a local macOS DSH Web runtime. Agent scheduling and Harvis integration are not included.

## Install

Use the prebuilt GitHub Release package. No source build hook is required:

~~~sh
dsh plugin --profile web add https://github.com/Harzva/dsh-terminal/releases/download/v0.1.0-alpha.2/harzva-dsh-terminal-0.1.0-alpha.2.tgz
~~~

Restart the selected DSH profile after installation. The source checkout does not contain built lib/ files; the github:Harzva/dsh-terminal shortcut is not the advertised install path.

The compatibility target is **DSH 0.1.1-rc.2**, Node.js 24+, the official local subprocess provider, and a supported DSH sandbox. Shell needs zsh; the Codex and Claude launchers appear as available only when their executables are on the DSH process's PATH. All launchers require POSIX sh; Codex/Claude initialization also uses standard filesystem utilities. Windows, remote subprocess providers, and DSH 0.1.2-rc.1 are not supported by this alpha. The latter changes a required sandbox-policy export.

## Open and arrange terminals

- 在 DSH 输入栏点击 **终端**，或输入 **/terminal** 并选择“打开终端”。侧栏终端入口也保留。
- 选择 **Shell / Codex / Claude Code** 后才创建真实进程；新建空白窗格不会自动启动 CLI。
- 使用左右双格、上下双格、主次三格、六格或十二格预设；窗格上的拆分按钮可继续组合布局。
- 拖动分隔线调整大小；分隔线也支持方向键与双击均分。每次调整都会改变真实 PTY 尺寸。
- 单格放大便于操作原生 TUI。切换布局或暂时收起窗格保留进程与当前页面里的终端组件。
- **返回 DSH** 保留终端；终端上的 **×** 结束该进程。正常停止实例会结束受管终端并清理可观察的子进程。

## Runtime and permissions

The UI uses additive DSH Slots and the framework's client command registry. It does not rewrite DSH's DOM or replace its root, conversation, or details regions. All entry points target a real DSH session through the same Host service.

Every request resolves the exact live Agent. The Host checks ownership, applies the current sandboxPolicy and sandbox.confine, and uses DSH's own managed subprocess lifetime. Sandbox mode changes are blocked while that session has a terminal being created, running, or awaiting cleanup. A missing sandbox provider in a restricted mode rejects the launch.

One viewer holds the write lease for a terminal. Explicit takeover invalidates the previous lease; input sequence numbers reject duplicates and late writes. Uncertain input delivery is not automatically retried. A failed cleanup remains retryable. The limit is 12 retained terminals per session.

### Version-pinned PTY compatibility

The audited official DSH release exposes PTY input and output but not a public resize method. This alpha therefore has a narrow compatibility adapter for the exact supported local-provider version. It checks the provider identity and underlying terminal shape, calls the existing terminal's resize operation, and exports TERM=xterm-256color inside the already-confined launch command.

This uses a **private DSH handle field**. It does not modify the provider, its prototype, the installed DSH package, or other terminals. An unrecognised runtime is rejected and any allocated handle is cleaned up. DSH upgrades require a new compatibility audit; do not assume an arbitrary newer build works.

### CLI configuration

Codex and Claude use independent state under the workspace's .dsh-terminal/{codex,claude}. Initialization runs in the same sandbox as the CLI, creates private directories and an ignore rule, and does not copy existing credentials. Git ignore rules cannot protect files already tracked by Git; this directory is local runtime data and must not be committed.

Authentication remains the native CLI's responsibility. The alpha has displayed Codex's native login menu. Claude reached its native interface in development but returned an Anthropic connection error with a fresh configuration on the verification machine. Neither login nor an agent's full model-task workflow is claimed as verified.

## Model Experience

This release does not register model-facing Tools, issue model requests, or put terminal output into DSH conversation history. Status badges describe process facts. A real terminal BEL can draw attention, but quiet output does not mean an agent has finished. There is no automatic AI input or Harvis takeover.

**KV Cache effect:** none directly; client polling invokes Host RPC only.

## Development and verification

~~~sh
npm ci --legacy-peer-deps --ignore-scripts
pnpm check
pnpm run pack:dsh
pnpm run verify:dsh-offline
~~~

check builds Host/Client artifacts, checks TypeScript, and runs the focused test suite. pack:dsh builds a fresh tarball and checks its file inventory. verify:dsh-offline verifies the packed artifact in an isolated official DSH profile; it does not modify a personal profile or use model credentials. Initial dependency installation requires network access, while the smoke makes no model-service calls. The script accepts an optional tarball path, records its fixture and restart parameters, and stops its test processes before returning.

The development approach follows ship-first-workflow: implement visible interactions first, then verify real behavior and the release artifact. The release's verification record is kept in [CHANGELOG.md](https://github.com/Harzva/dsh-terminal/blob/main/CHANGELOG.md).

## Known limitations and next work

- Native authentication and successful Claude connectivity still need user verification.
- Browser refresh replays a bounded raw stream, not historical resize events; exact screen reconstruction is not guaranteed. A lost output prefix stops input until the terminal is reopened.
- No process survival across Host restart, remote provider support, Windows support, or 12-busy-agent stress claim.
- Reliable agent attention events, Harvis scheduling, and AI input handoff remain future work.
- The private PTY adapter requires explicit review for each supported DSH version.

To disable, remove the dsh-terminal loader entry from the chosen profile and restart that profile. Do not delete its runtime state directory while a CLI is using it.

## References and license

MIT. Dependency notices are in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).

[Wave Terminal](https://github.com/wavetermdev/waveterm) informed pane layout and stable mounting; [Warp](https://github.com/warpdotdev/warp) informed native agent interaction; [Smart Terminal](https://github.com/muralianand12345/Smart-Terminal) informed command preview discussions. Their application code is not included. The terminal renderer is [xterm.js](https://github.com/xtermjs/xterm.js); DSH's managed subprocess implementation remains an external peer dependency.
