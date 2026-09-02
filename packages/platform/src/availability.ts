export type PlatformAvailabilityReason =
  | 'platform_unsupported'
  | 'desktop_session_unsupported'
  | 'native_provider_missing'
  | 'native_permission_required'
  | 'dependency_missing'
  | 'bundled_asset_integrity_failed'
  | 'secret_provider_unavailable'
  | 'process_ownership_unverified'
  | 'update_distribution_unsupported';

export type PlatformAvailabilityState =
  | { readonly available: true; readonly ready: true }
  | { readonly available: true; readonly ready: false; readonly reason: PlatformAvailabilityReason; readonly detail?: string }
  | { readonly available: false; readonly ready: false; readonly reason: PlatformAvailabilityReason; readonly detail?: string };
