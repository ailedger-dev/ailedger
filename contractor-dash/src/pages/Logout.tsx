import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { logout } from "../lib/auth";

interface Props {
  onDone: () => void;
}

export default function Logout({ onDone }: Props) {
  const nav = useNavigate();
  useEffect(() => {
    let cancelled = false;
    logout().finally(() => {
      if (cancelled) return;
      onDone();
      nav("/login", { replace: true });
    });
    return () => {
      cancelled = true;
    };
  }, [nav, onDone]);
  return (
    <div className="flex h-full items-center justify-center text-zinc-400 text-sm">
      Signing out…
    </div>
  );
}
