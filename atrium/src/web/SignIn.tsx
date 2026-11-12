import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "./api";

export function SignIn() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: () => api<{ appName: string; google: boolean }>("/auth/config"), staleTime: Infinity });
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent" | "verifying">(token ? "verifying" : "idle");
  const [error, setError] = useState(params.get("error") ?? "");
  const [devLink, setDevLink] = useState("");
  const tried = useRef(false);
  const name = config?.appName ?? "Atrium";

  useEffect(() => {
    if (!token || tried.current) return;
    tried.current = true;
    api("/auth/verify", { body: { token } }).then(() => location.assign("/")).catch((e) => { setError(e.message); setState("idle"); });
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("busy");
    setError("");
    try {
      const res = await api<{ devLink?: string }>("/auth/request", { body: { email } });
      setDevLink(res.devLink ?? "");
      setState("sent");
    } catch (err) { setError(err instanceof Error ? err.message : "Something went wrong."); setState("idle"); }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand-mark">{name[0]}</div>
        {state === "verifying" ? (<><h1>Signing you in…</h1><p>One moment.</p></>) : state === "sent" ? (
          <>
            <h1>Check your email</h1>
            <p>If <b>{email}</b> has been invited, a sign-in link is on its way. It works once and expires in 20 minutes.</p>
            {devLink && <a className="btn primary" href={devLink}>Development mode: sign in now</a>}
            <button className="btn plain" onClick={() => setState("idle")}>Use a different email</button>
          </>
        ) : (
          <>
            <h1>Sign in to {name}</h1>
            <p>Enter your work email and we'll send you a sign-in link.</p>
            <form onSubmit={submit}>
              <input className="field" type="email" required autoFocus placeholder="you@company.com" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="btn primary" disabled={state === "busy" || !email}>{state === "busy" ? "Sending…" : "Continue with email"}</button>
            </form>
            {config?.google && (<><div className="or">or</div><a className="btn" href="/api/auth/google">Continue with Google</a></>)}
            {error && <div className="err">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
