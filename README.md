# Jinko QR

Full source backup for the Jinko QR ordering and iMin printing system.

## Projects

- `JinkoOrderVercel/` — ordering/admin web app and Vercel API routes.
- `JinkoOrderVercel/print-agent/` — desktop print agent source, unpacked from the source archive.
- `JinkoIminPrintBridgeDriveUpdate/` — React Native iMin print bridge for Android/iOS.

## Source snapshot

- Version: `v1.0.30`
- Source archive: `[Full]JinkoSystemBackup-v1.0.30-2026-08-17-source-and-apk.zip`
- Archive SHA-256: `99c6bbf1cab6943d2a3856178bf04e6317caedc5332c7427c88f41214aa07f29`

APK, ZIP, database backups, environment files, and credentials are intentionally excluded from this public source repository. The iMin SDK binaries are also excluded by the mobile project's `.gitignore`; run `JinkoIminPrintBridgeDriveUpdate/scripts/setup-imin-sdk.sh` to restore them from iMin's official SDK package.

Public defaults use documentation placeholders for the API URL, printer IP, and shop phone. Configure the real values after cloning.

See each project's README for installation and deployment details.
