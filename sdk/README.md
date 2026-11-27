# Deprecated SDK location

The private `@sdk/core` package formerly in this directory has been removed. It
was unpublished, had no repository consumers, and was not part of the release
workflow.

The canonical SDK is [`@stellarcred/sdk`](../frontend/packages/sdk), whose source,
tests, documentation, and package manifest live in `frontend/packages/sdk/`.
Use that package for all new integrations. Do not recreate a package manifest or
SDK implementation in this directory; CI's SDK layout guard rejects it.
