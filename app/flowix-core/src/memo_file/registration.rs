//! Legacy memo-ID registration and disk reconciliation live in
//! `ops::registration` and `ops::reconcile`. Registering an
//! existing Markdown file associates its notebook-relative path with an
//! internal cache ID without changing the file or reading `flowix_key`.
