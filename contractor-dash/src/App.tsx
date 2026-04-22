import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Home from "./pages/Home";
import Logout from "./pages/Logout";
import { fetchSession, type SessionState } from "./lib/auth";

export default function App() {
  const [session, setSession] = useState<SessionState | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSession().then((s) => {
      if (!cancelled) setSession(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (session === null) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-400 text-sm">
        Loading…
      </div>
    );
  }

  const authed = session.authenticated;
  return (
    <Routes>
      <Route
        path="/"
        element={<Navigate replace to={authed ? "/app" : "/login"} />}
      />
      <Route
        path="/login"
        element={
          authed ? (
            <Navigate replace to="/app" />
          ) : (
            <Login onLogin={() => fetchSession().then(setSession)} />
          )
        }
      />
      <Route
        path="/app/*"
        element={
          authed ? (
            <Home session={session} onLogout={() => setSession({ authenticated: false })} />
          ) : (
            <Navigate replace to="/login" />
          )
        }
      />
      <Route path="/logout" element={<Logout onDone={() => setSession({ authenticated: false })} />} />
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}
