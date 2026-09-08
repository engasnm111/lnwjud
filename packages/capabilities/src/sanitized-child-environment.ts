/**
 * Environment passed to read-only diagnostics and scheduler commands.
 *
 * Desktop processes commonly carry credentials for unrelated providers in
 * their parent environment. Native diagnostics must retain session handles
 * such as DISPLAY/DBUS/PipeWire, but should never copy credential-looking
 * variables into a child process unless a caller explicitly injects a value
 * for that command (the current diagnostics callers do not).
 */
export function sanitizedChildEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(base).filter(([key]) => !/(?:^|[_-])(?:api[_-]?key|token|password|secret)(?:$|[_-])/iu.test(key)),
  );
}
