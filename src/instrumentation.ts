/** Refuses to start a production deploy that is missing required configuration. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { configProblems } = await import("@/lib/env");
  const { env } = await import("@/lib/env");
  const problems = configProblems();
  if (problems.length > 0) {
    for (const p of problems) console.error(`[config] ${p}`);
    throw new Error(`Refusing to start: ${problems.length} configuration problem(s)`);
  }
  // Short passphrases are allowed but called out: this is the only thing in
  // front of a paid API key if the deployment is publicly reachable.
  if (env.accessCode.length > 0 && env.accessCode.length < 12) {
    console.warn("[config] ACCESS_CODE is short; consider a longer passphrase for a public deployment");
  }

  // Printed on every boot so it is obvious which build is actually running.
  // `matching=identity` is the marker for the fix to the capped-conversation
  // bug: an older build prints nothing here and will never find a reply.
  const { base44Configured } = await import("@/lib/env");
  console.log(
    `[config] build=identity-matching adapter=${base44Configured() ? "live" : "mock"} ` +
      `timeout=${env.base44TimeoutMs > 0 ? Math.round(env.base44TimeoutMs / 1000) + "s" : "none"} ` +
      `cooldown=${env.cooldownSeconds}s cache=${env.cacheTtlSeconds}s`,
  );
}
