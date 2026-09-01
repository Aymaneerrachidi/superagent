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
}
