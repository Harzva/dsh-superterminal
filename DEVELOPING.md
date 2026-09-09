# Development

```sh
npm ci --legacy-peer-deps --ignore-scripts
pnpm check
pnpm run pack:dsh
pnpm run verify:dsh-offline
```

The checks build the client, validate TypeScript, and run the focused tests. The verification script installs the release tarball in a temporary official DSH 0.1.1-rc.2 profile, exercises PTY operations and cleanup, and does not use model credentials. Dependency installation needs network access. Generated artifacts and fixture logs are excluded from Git.

The UI uses additive DSH Slots. Requests resolve the exact live session owner. Terminal writes require a single-viewer lease and monotonic sequence; uncertain input is never automatically repeated. Launches use the session's existing sandbox policy. An unavailable required sandbox rejects the launch.

The supported provider lacks a public resize operation, so this release uses a narrow, guarded private-handle adapter pinned to official DSH 0.1.1-rc.2. Provider upgrades require review and isolated verification. Do not widen the peer range without that verification.

Client bundles are minified without source maps or development comments. Dependency notices remain in THIRD_PARTY_NOTICES.txt. Public error messages must use action-oriented copy, never raw exceptions, credentials, or diagnostic dumps.

Keep the package, loader, and RPC identifiers compatible with @harzva/dsh-terminal. The public product and repository are named DSH SuperTerminal and Harzva/dsh-superterminal.
