import React, { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../sync/supabase";
import { connectPowerSync, disconnectPowerSync } from "../sync/system";

export type Role = "customer" | "sales" | "warehouse" | "manager" | "admin" | null;

type AuthCtx = {
  session: Session | null;
  role: Role;
  loading: boolean;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthCtx>({
  session: null, role: null, loading: true, signOut: async () => {},
});
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setRole(null);
      disconnectPowerSync();
      return;
    }
    // role: prefer a JWT claim if present (B2 token hook), else app_user table.
    supabase
      .from("app_user")
      .select("role")
      .eq("id", session.user.id)
      .maybeSingle()
      .then(({ data }) => setRole(((data?.role as Role) ?? "customer")));
    // start background sync (non-fatal — Rust-backed reads still work if it fails)
    connectPowerSync().catch((e) => console.error("PowerSync connect failed:", e));
  }, [session]);

  const signOut = async () => {
    await disconnectPowerSync();
    await supabase.auth.signOut();
  };

  return (
    <Ctx.Provider value={{ session, role, loading, signOut }}>{children}</Ctx.Provider>
  );
}
