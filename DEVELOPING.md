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

The alpha.7 focused suite contains 82 passing tests, with no failures or skipped tests. Coverage includes workspace memory validation, independent-owner lifecycle and policy isolation, target-scoped assistant requests, Shell command boundaries, timestamped agent readiness, and handoff acceptance and rework persistence. TypeScript and the client build pass.

Isolated installation of the alpha.7 release tarball on official DSH 0.1.1-rc.2 verified six real PTYs, Shell command success and failure, independent-owner and handoff isolation, explicit acceptance, linked rework deduplication, cancellation, and cold recovery without rerunning tasks. Offline handoff lifecycle checks use an explicitly identified protocol simulator. Separate live Pi + DeepSeek checks verified a complete task result and return to the originating conversation. Codex login detection was checked; successful Codex model execution requires a configured login and is not claimed by these checks. After a DSH restart, saved task metadata can be recovered, but previous terminal processes are not revived.

Earlier Side Terminal browser checks covered native details docking and width adjustment, restoration of the original tool details, expansion and return without terminal recreation, the blank-conversation overlay fallback, both association modes, pane hiding and redisplay, task termination, restored names and layouts, explicit excerpt sharing, and target-specific draft placement without execution. A preview-server restart without refreshing the browser recovered the independent owner and saved task records; ended PTYs required an explicit restart. These checks did not cover account balances or native CLI task resumption.

An alpha.7 browser session exercised a failed Shell command record through expansion, copying, and explanation. Selecting terminal output exposed Explain, Suggest a Fix, and Hand Off actions; choosing Suggest a Fix only prefilled the request. A real Pi result was followed by explicit rework feedback, a second Pi result with additional assertion examples, user acceptance notes and confirmation, and successful return to the original DSH conversation. The source file's hash remained unchanged. The locally adapted Supervisor displayed the parent as requiring rework and its child as accepted, and generated a real suggestion. Assistant drafts survived hiding and reopening the panel and switching to another DSH owner and back.

Final-package browser checks confirmed that the accepted child task persisted after restart. Two live Shell panes supported switching targets while the assistant was open, including during a real suggestion request with an explicitly shared excerpt; returning restored the first target's result and sharing choice while the second retained its own draft. Placing a suggested Shell command in the draft did not execute it: the command-record count stayed unchanged. During service interruption, one recovery banner appeared, both terminal screens and drafts remained visible, input paused, and no duplicate terminal launch occurred.
