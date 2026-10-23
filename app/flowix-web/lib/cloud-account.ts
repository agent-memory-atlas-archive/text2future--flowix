/** Native account capabilities are the local source of truth for Cloud sync UI. */
export interface CloudSyncAccess {
  canRead: boolean;
  canUpload: boolean;
  canDelete: boolean;
  restriction: 'signed_out' | 'verifying' | 'verification_failed' | 'membership_required' | 'storage_limited' | null;
}

interface AccountProjection {
  authenticated: boolean;
  syncAccess?: CloudSyncAccess;
}

/** A missing snapshot grants no capability while the account service initializes. */
export function getCloudSyncAccess(state: AccountProjection | null | undefined): CloudSyncAccess {
  return state?.syncAccess ?? {
    canRead: false,
    canUpload: false,
    canDelete: false,
    restriction: state?.authenticated ? 'verifying' : 'signed_out',
  };
}
