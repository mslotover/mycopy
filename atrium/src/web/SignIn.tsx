import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "./api";
import { isStandalone } from "./phone";

export function SignIn() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: () => api<{ appName: string; google: boolean }>("/auth/config"), staleTime: Infinity });
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent" | "verifying">(token ? "verifying" : "idle");
  const [error, setError] = useState(params.get("error") ?? "");
  const [devLink, setDevLink] = useState("");
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  // On a phone's home screen the app opens on the task list; elsewhere on Home.
  const enter = () => location.assign(isStandalone() ? "/tasks" : "/");
  const tried = useRef(false);
  const name = config?.appName ?? "Atrium";

  useEffect(() => {
    if (!token || tried.current) return;
    tried.current = true;
    api("/auth/verify", { body: { token } }).then(enter).catch((e) => { setError(e.message); setState("idle"); });
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("busy");
    setError("");
    try {
      const res = await api<{ devLink?: string; devCode?: string }>("/auth/request", { body: { email } });
      setDevLink(res.devLink ?? "");
      setCode("");
      setState("sent");
    } catch (err) { setError(err instanceof Error ? err.message : "Something went wrong."); setState("idle"); }
  };

  const typeCode = async (value: string) => {
    const digits = value.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    setError("");
    if (digits.length < 6 || checking) return;
    setChecking(true);
    try { await api("/auth/verify", { body: { email, code: digits } }); enter(); }
    catch (err) { setError(err instanceof Error ? err.message : "Something went wrong."); setCode(""); setChecking(false); }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand-mark">{name[0]}</div>
        {state === "verifying" ? (<><h1>Signing you in…</h1><p>One moment.</p></>) : state === "sent" ? (
          <>
            <h1>Check your email</h1>
            <p>If <b>{email}</b> has been invited, an email is on its way with a sign-in link and a 6-digit code. Click the link, or type the code here. Both expire in 20 minutes.</p>
            <input className="field code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={7} placeholder="6-digit code" aria-label="6-digit code" autoFocus disabled={checking}
              value={code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code} onChange={(e) => typeCode(e.target.value)} />
            {error && <div className="err">{error}</div>}
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
