//! Typed application results. Strings are produced only at the command boundary.
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteConflict {
    LocalEdit,
    AttachmentEdit,
    AttachmentDelete,
    NoteDelete,
    PathCollision,
    NotebookEdit,
}
impl RemoteConflict {
    fn code(self) -> &'static str {
        match self {
            Self::LocalEdit => "CLOUD_LOCAL_EDIT_CONFLICT",
            Self::AttachmentEdit => "CLOUD_ATTACHMENT_EDIT_CONFLICT",
            Self::AttachmentDelete => "CLOUD_ATTACHMENT_DELETE_CONFLICT",
            Self::NoteDelete => "CLOUD_DELETE_CONFLICT",
            Self::PathCollision => "CLOUD_PATH_COLLISION",
            Self::NotebookEdit => "CLOUD_NOTEBOOK_EDIT_CONFLICT",
        }
    }
}

#[derive(Debug)]
pub(crate) enum RemoteApplyError {
    Conflict {
        reason: RemoteConflict,
        detail: String,
    },
    Failure(String),
}
impl RemoteApplyError {
    pub(crate) fn conflict(reason: RemoteConflict, detail: impl Into<String>) -> Self {
        Self::Conflict {
            reason,
            detail: detail.into(),
        }
    }
}
impl From<String> for RemoteApplyError {
    fn from(message: String) -> Self {
        Self::Failure(message)
    }
}
impl fmt::Display for RemoteApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict { reason, detail } => write!(f, "{}: {detail}", reason.code()),
            Self::Failure(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for RemoteApplyError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteApplyOutcome {
    Applied,
    Deferred(RemoteConflict),
}
impl RemoteApplyOutcome {
    pub(super) fn from_result(
        result: Result<(), RemoteApplyError>,
    ) -> Result<Self, RemoteApplyError> {
        match result {
            Ok(()) => Ok(Self::Applied),
            Err(RemoteApplyError::Conflict { reason, .. }) => Ok(Self::Deferred(reason)),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_typed_conflicts_are_deferred_regardless_of_display_text() {
        let misleading_text =
            RemoteApplyError::Failure("CLOUD_LOCAL_EDIT_CONFLICT: transport failed".into());
        assert!(RemoteApplyOutcome::from_result(Err(misleading_text)).is_err());
        let conflict = RemoteApplyError::conflict(RemoteConflict::LocalEdit, "note.md");
        assert_eq!(
            RemoteApplyOutcome::from_result(Err(conflict)).unwrap(),
            RemoteApplyOutcome::Deferred(RemoteConflict::LocalEdit)
        );
        assert_eq!(
            RemoteApplyOutcome::from_result(Ok(())).unwrap(),
            RemoteApplyOutcome::Applied
        );
    }
}
