// A minimal ESM resolve hook: append ".js" to extensionless relative specifiers.
//
// AgentsPoppy's @agentspoppy/core is compiled to dist/*.js with extensionless
// relative imports (`import ... from "./types"`), which Node's ESM loader won't
// resolve on its own. This lets assess-permissions.mjs import the REAL assessor
// (packages/core/dist/permissions.js) directly, so our manifest gate checks against
// the exact code the host runs — never a copy that could drift. Read-only, no deps.

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
    try {
      return await next(specifier + ".js", context);
    } catch {
      /* fall through to the default resolution below */
    }
  }
  return next(specifier, context);
}
