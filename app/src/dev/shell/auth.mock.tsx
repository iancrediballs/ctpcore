// Shell harness: a signed-in admin (or ?role=customer), no token.
export type Role = "customer" | "sales" | "warehouse" | "manager" | "admin" | null;
const role = (new URLSearchParams(location.search).get("role") as Role) ?? "admin";
const session = { access_token: undefined, user: { id: "harness-" + role, email: role + "@harness.local" } };
export const useAuth = () => ({ session, role, signOut: async () => undefined });
