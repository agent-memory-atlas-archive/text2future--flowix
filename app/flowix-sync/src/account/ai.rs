use super::*;

impl AccountService {
    pub async fn ai_model_availability(
        &self,
    ) -> Result<crate::models::CloudAiModelAvailability, SyncError> {
        let generation = self.auth_generation();
        let access_token = self.access_token(generation).await?;
        let first = self.client.ai_model_availability(&access_token).await;
        let availability = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client.ai_model_availability(&refreshed).await?
        } else {
            first?
        };
        let _generation = self.require_auth_generation(generation)?;
        Ok(availability)
    }

    /// Monotonic identity for the current in-memory Cloud login session.
    /// Runtime adapters use this to refresh session-bound API credentials only
    /// after a sign-in transition, not before every request.
    pub fn ai_credential_session_generation(&self) -> u64 {
        self.auth_generation()
    }

    pub async fn ai_credit_balance(
        &self,
    ) -> Result<crate::models::CloudAiCreditBalance, SyncError> {
        let generation = self.auth_generation();
        let access_token = self.access_token(generation).await?;
        let first = self.client.ai_credit_balance(&access_token).await;
        let balance = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client.ai_credit_balance(&refreshed).await?
        } else {
            first?
        };
        let _generation = self.require_auth_generation(generation)?;
        Ok(balance)
    }

    pub async fn create_ai_credential(
        &self,
    ) -> Result<crate::models::CloudAiCredential, SyncError> {
        let generation = self.auth_generation();
        let access_token = self.access_token(generation).await?;
        let first = self.client.create_ai_credential(&access_token).await;
        let credential = if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client.create_ai_credential(&refreshed).await?
        } else {
            first?
        };
        let _generation = self.require_auth_generation(generation)?;
        Ok(credential)
    }

    pub async fn revoke_ai_credential(&self) -> Result<(), SyncError> {
        let generation = self.auth_generation();
        let access_token = self.access_token(generation).await?;
        let first = self.client.revoke_ai_credential(&access_token).await;
        if first.as_ref().is_err_and(SyncError::is_unauthorized) {
            let refreshed = self.force_refresh_access_token(generation).await?;
            self.client.revoke_ai_credential(&refreshed).await?;
        } else {
            first?;
        }
        let _generation = self.require_auth_generation(generation)?;
        Ok(())
    }
}
