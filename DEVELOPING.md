# Development

```sh
npm ci --legacy-peer-deps --ignore-scripts
pnpm check
pnpm run pack:dsh
pnpm run verify:dsh-offline
```

The checks build the client, validate TypeScript, and run the focused tests. The verification script installs the release tarball in a temporary official DSH 0.1.1-rc.2 profile, exercises PTY operations and cleanup, and does not use model credentials. Dependency installation needs network access. Generated artifacts and fixture logs are excluded from Git.

Entry points and the overlay use additive DSH Slots; native docking temporarily occupies the existing single-provider details Slot as described below. Requests resolve the exact live session owner. Terminal writes require a single-viewer lease and monotonic sequence; uncertain input is never automatically repeated. Launches use the session's existing sandbox policy. An unavailable required sandbox rejects the launch.

The supported provider lacks a public resize operation, so this release uses a narrow, guarded private-handle adapter pinned to official DSH 0.1.1-rc.2. Provider upgrades require review and isolated verification. Do not widen the peer range without that verification.

Client bundles are minified without source maps or development comments. Dependency notices remain in THIRD_PARTY_NOTICES.txt. Public error messages must use action-oriented copy, never raw exceptions, credentials, or diagnostic dumps.

Keep the package, loader, and RPC identifiers compatible with @harzva/dsh-terminal. The public product and repository are named DSH SuperTerminal and Harzva/dsh-superterminal.

## Remote execution boundary

Alpha.12 adds SSH terminals through `remote-execution.mjs`, a Host-side module in the same package. The `./remote` export remains the Client-to-Host RPC contract. The pinned official local PTY provider hosts the OpenSSH client; there is no process-wide subprocess provider replacement.

The existing empty-pane launcher selects local or SSH execution. Target discovery parses explicit aliases from the Host's SSH config without invoking SSH; checks and launches are explicit. OpenSSH retains credential and host-key handling on the Host. Authentication and host trust must already support noninteractive connections. Remote execution requires the originating session's existing `danger-full-access` policy because local sandbox policy cannot confine a remote shell. Policy is rechecked around asynchronous admission.

Each task uses an isolated remote tmux server/socket and keeps its alias, config fingerprint, canonical working directory, and session owner attached to the terminal identity. Reconnect only attaches that exact task; it never creates a new session or replays input. Writer leases and queued input are invalidated before reacquisition. Remote PIDs are not inferred from the local SSH client PID, and unknown exit codes remain null. Remote CLI discovery uses the remote login shell and does not inherit local CLI configuration.

An SSH terminal is not yet a remote DSH AI workspace: native AI execution, automatic handoff, and Group admission reject remote terminals before any local executor is allocated. Advice can receive explicit excerpts and the execution identity, but does not gain remote file tools. Neither remote shell command-block instrumentation nor durable recovery across DSH restarts is shipped. Browser records retain the remote identity and never restart a missing remote task as a local launcher.

Hiding a panel preserves work. An SSH interruption retains the remote task for explicit reconnect. Ending a task targets its private tmux session; uncertain cleanup remains retryable. Teardown attempts scoped cleanup, but a DSH crash or unreachable host can leave a remote task running. Cancellation uses a private-directory lock and a closed marker to prevent a delayed creation from escaping cleanup. A small closed-marker directory may remain after uncertain creation. Never sweep unrelated tmux sessions or host files.

Extract a shared DSH Remote Host plugin only when another independently usable consumer needs the same execution service, or a deployment needs an independently replaceable backend. Reuse a compatible DSH provider if available before creating one. Sharing a Supervisor view of SuperTerminal tasks alone does not require another package. Any extracted provider must be optional for local terminals and retain the existing session and policy ownership.

Alpha.12 verification includes 174 passing tests, TypeScript and Client builds, and 32 checks against the exact release tarball installed into official DSH 0.1.1-rc.2. Separately, 23 real loopback OpenSSH/tmux checks exercise the actual Cordis context and official subprocess provider: raw output, resize, ownership, permission fencing, reconnect without replay, scoped cleanup, cancellation immediately after lock acquisition, and a CLI that fails before the first attach. They use no model calls or mocked transport. Browser checks cover target/directory display, matching terminal geometry, the same Shell PID after reconnect, draft retention, saved remote records, and ending a disconnected task without reattaching. The isolated Web candidate differs only by Host-side injection of the temporary SSH config; the release installer check uses the unmodified artifact. External-host compatibility and remote model execution are not claimed by these checks.


Alpha.13 adds a per-attachment readiness receipt after tmux has entered raw mode; neither terminal output nor a previous connection can unlock input. A failed connection stays retryable and never replays input. The 184-test suite and exact-package official DSH verification pass. Separate final built-Host acceptance checks pass on macOS arm64 with tmux 3.7c (25 checks) and Linux x86_64 with tmux 3.2a (30 checks), covering immediate first input, Unicode/ANSI, resize, process continuity, lease rejection, scoped close, natural exit, and owned-resource cleanup. These checks make no model calls and do not verify remote agent authentication, account quotas, or recovery across DSH restarts. Machine identities, test output, and installation provenance remain outside the public repository.

Appearance defaults to light and supports explicit dark or system preference. A shared client store synchronizes mounted workspaces without owning execution state. xterm changes `options.theme` in place, with a 4.5 minimum text contrast ratio; never remount a terminal, recreate a PTY, or reset a writer lease to change appearance. Browser validation confirms light/dark/system switching preserves the same live PTY, shell environment, output and unsent AI draft.

## Native detail-panel placement

The supported Client exposes `details` as a single-provider Slot, not an additive tab API. While Side Terminal is open and docked, a temporary registration with `priority: -1` supplies its seat. Disposing that registration restores the original details children. The title-bar action “工具详情” hides Side Terminal and opens the original details panel; the close action hides Side Terminal and closes the details panel. The native DSH layout owns the dock width and its resize interaction.

The terminal workspace renders through one stable React portal container. Docking, expanding into the overlay, and returning to the side panel move that container between seats without recreating the terminal components or their processes. Expanded mode disposes the temporary details registration. Blank conversations without a visible details region, unavailable docking capability, or failed docking use the overlay fallback. This integration does not add or claim a native terminal tab API.

## Side Terminal ownership and persistence

Bound mode resolves the currently selected live DSH session; each session retains its own terminal workspace. Independent mode creates or resumes a real DSH session owner for the originating workspace and sandbox mode. Switching modes changes the displayed workspace and never transfers a running terminal between owners.

The independent owner is created without copying conversation history, prompts, inboxes, or credentials. The source workspace and effective sandbox mode are validated before creation, after asynchronous work, and again when reconnecting to a persisted owner. A scope mismatch rejects the operation. Plugin teardown cancels in-flight scope creation before disposing owned handles and terminal processes.

Client workspace memory is scoped by browser origin and owner session ID. It stores only the layout tree, preset, selected slot, and up to 12 terminal ID / launcher / title records. Validation rejects duplicate slots, oversized values, invalid layouts, and malformed storage. Terminal output, prompts, excerpts, drafts, environment variables, and writer leases are excluded. Restoring metadata does not restore a PTY process. A missing process is shown as a saved record whose explicit restart opens a new terminal.

Hiding a pane or the side panel does not call the terminal close RPC. Ending a task uses an inline confirmation and the existing writer lease checks. Restored output is not considered writable until replay and control ownership are confirmed.

## Targeted assistant behavior

Assistant requests include the selected terminal ID, whose ownership is checked by the Host. The model receives only the request, that terminal's process metadata, and an optional user-approved output excerpt capped at 4,000 characters. Output excerpts are untrusted data, not instructions. No other terminal's output or conversation history is collected automatically.

Assistant questions, suggestions, excerpt consent, and drafts are retained in page memory under the exact owner session and terminal ID. Switching targets displays that target's own context; it does not transfer the previous target's draft or shared excerpt. Memory is bounded to 16 workspaces and 24 terminal contexts per workspace, and a page refresh clears it. Suggestion cards retain their target identity, and draft placement checks that identity again. Drafts are client-only text; placing or copying a draft never invokes `write` or submits an Enter key.

## Side Terminal validation

The alpha.8 focused suite has 105 passing tests, with no failures or skips. The added native-run cases cover exact owner identity, model selection, request replay, creation races, delegated policy and child permission fences, stopped-session restoration, scoped resource disposal, and the actual Cordis service-injection boundary. Persistence checkpoints use the public `ctx.get('sessions')` accessor; an undeclared `ctx.sessions` access fails in a real Cordis plugin even if a plain-object test fixture permits it.

A browser-driven task on official DSH 0.1.1-rc.2 used the configured DeepSeek model to read a small project, edit its implementation, and execute its existing two tests. Independent verification confirmed both tests passed and their file was unchanged. Follow-up questions used the same helper session, in-flight steering was reflected in its response, and a later two-minute waiting process was stopped before completion: its exact PID disappeared and its completion file was absent. The source Shell remained interactive and recorded a successful `pwd`. Sending another explicit question resumed the same native context without restarting the abandoned command. The originating conversation did not receive or run these tasks.

Further live checks rejected a write under read-only policy, rejected a helper permission change and cross-owner access, and replayed an admitted request without adding messages or tools. Browser checks confirmed the native AI/Shell switch preserves each view, drafts stay with their terminal across target and sidebar changes, and assistant replies use DSH's own Markdown renderer. The independent offline installer verifies empty `runState` is read-only and does not allocate an executor; it does not simulate a successful native model task. The successful model checks above are separate real-provider runs.

## Native task ownership

Each terminal may hold one owned DSH AgentHandle. The first explicitly submitted request captures the source's actual model selection, composed agent preset, workspace and sandbox policy. Public delegated-composition helpers install the same preset generation and constrain approval to `never`. A marker binds the persisted helper to its source owner and terminal; restoration checks preset and policy before clearing an abandoned inbox. No parent conversation is copied and no continuable-subagent notification is registered, so task completion does not implicitly wake the parent.

The service keeps at most 12 resident helpers and admits at most 2 concurrently executing tasks. An idle handle still retains scoped resources until stopped, so `canStop` remains true and permission changes stay fenced. Stop cancels the agent, waits for idle, flushes its session, and disposes its handle to drain background jobs. Failure retains a retryable stop/close entry. Explicitly continuing after a successful stop restores the same helper history; closing the owning terminal ends that association.

The client projection includes only submitted user messages, assistant text and public tool steps, bounded to 120 entries and 80,000 text characters. System prompts, reasoning, provider request data, private diagnostics and tool metadata are excluded. Drafts and pending request IDs stay in page memory. An uncertain send retains its identifier; retries reconcile the original request rather than create another execution. An explicit pre-admission rejection clears the pending request while keeping the draft editable.

## Earlier validation

The alpha.7 focused suite contains 82 passing tests, with no failures or skipped tests. Coverage includes workspace memory validation, independent-owner lifecycle and policy isolation, target-scoped assistant requests, Shell command boundaries, timestamped agent readiness, and handoff acceptance and rework persistence. TypeScript and the client build pass.

Isolated installation of the alpha.7 release tarball on official DSH 0.1.1-rc.2 verified six real PTYs, Shell command success and failure, independent-owner and handoff isolation, explicit acceptance, linked rework deduplication, cancellation, and cold recovery without rerunning tasks. Offline handoff lifecycle checks use an explicitly identified protocol simulator. Separate live Pi + DeepSeek checks verified a complete task result and return to the originating conversation. Codex login detection was checked; successful Codex model execution requires a configured login and is not claimed by these checks. After a DSH restart, saved task metadata can be recovered, but previous terminal processes are not revived.

Earlier Side Terminal browser checks covered native details docking and width adjustment, restoration of the original tool details, expansion and return without terminal recreation, the blank-conversation overlay fallback, both association modes, pane hiding and redisplay, task termination, restored names and layouts, explicit excerpt sharing, and target-specific draft placement without execution. A preview-server restart without refreshing the browser recovered the independent owner and saved task records; ended PTYs required an explicit restart. These checks did not cover account balances or native CLI task resumption.

An alpha.7 browser session exercised a failed Shell command record through expansion, copying, and explanation. Selecting terminal output exposed Explain, Suggest a Fix, and Hand Off actions; choosing Suggest a Fix only prefilled the request. A real Pi result was followed by explicit rework feedback, a second Pi result with additional assertion examples, user acceptance notes and confirmation, and successful return to the original DSH conversation. The source file's hash remained unchanged. The locally adapted Supervisor displayed the parent as requiring rework and its child as accepted, and generated a real suggestion. Assistant drafts survived hiding and reopening the panel and switching to another DSH owner and back.

Final-package browser checks confirmed that the accepted child task persisted after restart. Two live Shell panes supported switching targets while the assistant was open, including during a real suggestion request with an explicitly shared excerpt; returning restored the first target's result and sharing choice while the second retained its own draft. Placing a suggested Shell command in the draft did not execute it: the command-record count stayed unchanged. During service interruption, one recovery banner appeared, both terminal screens and drafts remained visible, input paused, and no duplicate terminal launch occurred.
