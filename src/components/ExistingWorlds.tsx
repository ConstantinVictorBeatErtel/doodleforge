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
export function ExistingWorlds({ worlds, activeId, onSelect, onDelete, corner = "top-right" }: {
  worlds: ExistingWorld[];
  activeId?: string | null;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  corner?: "top-right" | "bottom-right";
}) {
  const [open, setOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
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
      {worlds.map((w) => <div key={w._id} className={`existing-worlds-row ${w._id === activeId ? "active" : ""}`}>
        {w.panoUrl ? <img src={w.panoUrl} alt="" /> : <span className="existing-worlds-thumb" aria-hidden="true">◎</span>}
        <button type="button" className="existing-worlds-label" onClick={() => { onSelect(w._id); setOpen(false); }}>
          <strong>{w.name}</strong>
          <small>{w.status === "ready" ? "ready" : w.status === "generating" ? "building…" : "failed"}</small>
        </button>
        {onDelete && (confirmId === w._id ? <span className="existing-worlds-actions"><small>Delete forever?</small><button type="button" onClick={() => { onDelete(w._id); setConfirmId(null); }}>Delete</button><button type="button" onClick={() => setConfirmId(null)}>Cancel</button></span>
          : <button type="button" aria-label={`Delete ${w.name}`} title="Delete this room and its files" onClick={() => setConfirmId(w._id)}>Delete</button>)}
      </div>)}
    </div>}
  </div>;
}
