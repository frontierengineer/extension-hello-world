# Hello Frontier

The seed extension of the [Frontier extension registry](https://github.com/frontierengineer/extensions).
UI-only, zero host-side code, exists to prove the publish → scan → install round trip.

Publish flow used here (see [PUBLISHING.md](https://github.com/frontierengineer/extensions/blob/main/PUBLISHING.md)):
tag `vX.Y.Z` → the release workflow packs `extension.tgz` → the registry indexer
scans it and pins its sha256 into `index.json`.
