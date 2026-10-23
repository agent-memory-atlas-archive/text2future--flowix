import { describe, expect, it } from 'vitest';
import { getCloudSyncAccess, type CloudSyncAccess } from './cloud-account';

describe('native account capability projection', () => {
  it('grants no capabilities until a native snapshot is available', () => {
    expect(getCloudSyncAccess(null)).toEqual({ canRead: false, canUpload: false, canDelete: false, restriction: 'signed_out' });
    expect(getCloudSyncAccess({ authenticated: true }).restriction).toBe('verifying');
    expect(getCloudSyncAccess({ authenticated: true }).canRead).toBe(false);
  });
  it('preserves independent read, upload and deletion capabilities from the account service', () => {
    const access: CloudSyncAccess = { canRead: true, canUpload: false, canDelete: true, restriction: 'storage_limited' };
    expect(getCloudSyncAccess({ authenticated: true, syncAccess: access })).toBe(access);
  });
});
