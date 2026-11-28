"use client";

import { useState } from "react";
import type { Photo } from "@/lib/types";

/**
 * Photo order on a finished listing card, before it's scheduled/posted.
 * The order shown is exactly what eBay gets; the first photo is the cover
 * (search thumbnail). Drag to reorder, or use ◀ ▶ / "Make cover".
 */
export function CardPhotoOrder({
  photoIds,
  photoById,
  onReorder,
}: {
  photoIds: string[];
  photoById: (id: string) => Photo | undefined;
  onReorder: (fromIndex: number, toIndex: number) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const reset = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div className="result-field">
      <label>
        Photo order <span className="count">first photo = eBay thumbnail · drag or use the arrows</span>
      </label>
      <div className="card-photos">
        {photoIds.map((id, i) => {
          const p = photoById(id);
          if (!p) return null;
          const cls = ["card-photo"];
          if (dragIndex === i) cls.push("dragging");
          if (overIndex === i && dragIndex !== null && dragIndex !== i) cls.push("drop-target");
          return (
            <figure
              key={id}
              className={cls.join(" ")}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                setDragIndex(i);
              }}
              onDragEnter={() => setOverIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null) onReorder(dragIndex, i);
                reset();
              }}
              onDragEnd={reset}
            >
              <div className="card-photo-img">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.previewUrl} alt={`Photo ${i + 1}`} />
                {i === 0 ? (
                  <span className="thumb-cover-badge">Cover</span>
                ) : (
                  <span className="card-photo-num">{i + 1}</span>
                )}
              </div>
              <div className="card-photo-moves">
                <button type="button" aria-label="Move left" disabled={i === 0} onClick={() => onReorder(i, i - 1)}>
                  ◀
                </button>
                {i !== 0 && (
                  <button type="button" className="make-cover" onClick={() => onReorder(i, 0)}>
                    Cover
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Move right"
                  disabled={i === photoIds.length - 1}
                  onClick={() => onReorder(i, i + 1)}
                >
                  ▶
                </button>
              </div>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
