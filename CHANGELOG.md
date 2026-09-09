# Changelog

## 0.1.0-alpha.2

- Introduces resizable split layouts with stable terminal components and live PTY resizing.
- Adds DSH composer and /terminal entry points alongside the sidebar entry.
- Packages a Host/Client DSH bundle with an explicit local-provider compatibility boundary.
- Preserves session ownership, sandbox confinement, writer leases, bounded output, and managed cleanup.

Verification (2026-09-09):

- Build, strict client TypeScript, and 16 focused tests passed.
- A fresh official DSH 0.1.1-rc.2 installation accepted the exact release tarball in an isolated profile. All five DSH peers resolved to the same official runtime instances.
- Six real PTYs passed unique-PID, xterm-256color, ANSI/Chinese, and resize/stty checks under the unchanged workspace-write policy. Test PTYs and the server stopped normally.
- Browser checks exercised the composer button, /terminal menu, split presets, pointer dragging, keyboard resizing, double-click equalization, and independent terminal closure. The retained Shell PID stayed unchanged through layout changes.
- Extension preflight passed. Its generated-client observer/URL warnings originate in bundled third-party dependencies; the plugin does not rewrite DSH's product DOM.
- DSH 0.1.2-rc.1 was tested and rejected because a required sandbox-policy export is absent; it is not included in the supported peer range.

Release package SHA-256: 885e8dec1441fa31dab5171e1fdd0af50bdf50ab846120e1b0e5c902f6e07ea7.
