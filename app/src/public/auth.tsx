// Public build: stands in for auth/AuthProvider. A visitor is a customer with
// no account: the app's customer view (no bins, no cost, no supplier), and no
// token, so nothing can reach the database as anyone.
export type Role = "customer" | "sales" | "warehouse" | "manager" | "admin" | null;
const session = { access_token: undefined, user: { id: "public", email: "" } };
export const useAuth = () => ({ session, role: "customer" as Role, signOut: async () => undefined });
export const AuthProvider = ({ children }: { children: unknown }) => children;
