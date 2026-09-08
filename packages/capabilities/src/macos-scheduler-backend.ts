// Kept as a platform-named entry point so callers do not need to know that
// the implementation shares the bounded scheduler machinery with Linux.
export { MacosSchedulerCapabilityBackend } from './portable-scheduler-backend.js';
export type { PortableSchedulerBackendOptions, PortableSchedulerRunResult } from './portable-scheduler-backend.js';
