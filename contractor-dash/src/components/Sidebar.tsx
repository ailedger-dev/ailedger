import { NavLink } from "react-router-dom";
import { Inbox as InboxIcon, BookOpen, LogOut, CircleUser, CircleDot, CircleAlert } from "lucide-react";
import { config } from "../config";
import type { SessionState } from "../lib/auth";

interface Props {
  session: SessionState;
  onLogout: () => void;
  apiUp: boolean | null;
}

export default function Sidebar({ session, onLogout, apiUp }: Props) {
  return (
    <aside className="w-60 shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col">
      <div className="px-4 py-5 border-b border-zinc-800">
        <div className="text-sm font-semibold">{config.displayName}</div>
        <div className="text-xs text-zinc-500 mt-1 flex items-center gap-1.5">
          <CircleUser className="w-3 h-3" />
          <span className="truncate" title={session.email}>{session.email}</span>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        <NavItem to="/app/inbox" icon={<InboxIcon className="w-4 h-4" />} label="Inbox" />
        <NavItem to="/app/docs" icon={<BookOpen className="w-4 h-4" />} label="Reading room" />
      </nav>

      <div className="px-4 py-3 border-t border-zinc-800">
        <div className="flex items-center gap-2 text-xs text-zinc-500 mb-3">
          {apiUp === true && (<><CircleDot className="w-3 h-3 text-emerald-400" /> <span>API connected</span></>)}
          {apiUp === false && (<><CircleAlert className="w-3 h-3 text-amber-400" /> <span>API unreachable</span></>)}
          {apiUp === null && (<><CircleDot className="w-3 h-3 text-zinc-600" /> <span>API probing…</span></>)}
        </div>
        <button
          onClick={() => {
            onLogout();
            window.location.assign("/logout");
          }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 rounded-md"
        >
          <LogOut className="w-4 h-4" /> Sign out
        </button>
      </div>
    </aside>
  );
}

function NavItem({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-2 text-sm rounded-md ${
          isActive ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        }`
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}
