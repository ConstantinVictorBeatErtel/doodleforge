import { useState } from "react";

export type ExistingWorld = {
  _id: string;
  name: string;
  status: "generating" | "ready" | "failed";
  panoUrl?: string | null;
  splatFileName?: string;
};

/**
 * Fixed corner button that opens a panel of every world already built and stored in
 * Convex, so a room can be reopened without generating a new one. Used both on the
 * landing screen (jump straight into a world) and inside the room viewer (switch rooms).
 */
export function ExistingWorlds({ worlds, activeId, onSelect, corner = "top-right" }: {
  worlds: ExistingWorld[];
  activeId?: string | null;
  onSelect: (id: string) => void;
  corner?: "top-right" | "bottom-right";
}) {
  const [open, setOpen] = useState(false);
  const ready = worlds.filter((w) => w.status === "ready");
  return <div className={`existing-worlds existing-worlds-${corner}`}>
    <button type="button" className="existing-worlds-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      Existing worlds{ready.length ? ` (${ready.length})` : ""}
    </button>
    {open && <div className="existing-worlds-panel" role="menu">
      <div className="existing-worlds-heading">
        <strong>Worlds in Convex</strong>
        <button type="button" aria-label="Close" onClick={() => setOpen(false)}>×</button>
      </div>
      {!worlds.length && <p className="hint">No worlds generated yet.</p>}
      {worlds.map((w) => <button type="button" key={w._id} className={`existing-worlds-row ${w._id === activeId ? "active" : ""}`}
        onClick={() => { onSelect(w._id); setOpen(false); }}>
        {w.panoUrl ? <img src={w.panoUrl} alt="" /> : <span className="existing-worlds-thumb" aria-hidden="true">◎</span>}
        <span className="existing-worlds-label">
          <strong>{w.name}</strong>
          <small>{w.status === "ready" ? "ready" : w.status === "generating" ? "building…" : "failed"}</small>
        </span>
      </button>)}
    </div>}
  </div>;
}
