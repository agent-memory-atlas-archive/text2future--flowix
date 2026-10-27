# Skill package release check

This standalone tool imports the production skill installer, shared YAML parser,
and path boundary checker directly. It does not compile Tauri or copy production
code into a separate test implementation.

```sh
cargo test --locked --manifest-path tools/skill-package-check/Cargo.toml
cargo run --locked --manifest-path tools/skill-package-check/Cargo.toml -- ../flowix-home/skill-files
```

The command installs each real market ZIP into a temporary notebook, checks every
resulting file byte, and verifies the source/time installation record. The test
suite covers failed staging, abandoned stages and retry, concurrent publication,
source metadata, CRLF and YAML compatibility, path boundaries and archive limits.

The website also provides `npm run verify:release`, which runs its structural
checks and then this native tool. Set `FLOWIX_MAIN_ROOT` if the two repositories
are not adjacent. Neither command writes to a user's notebook.
