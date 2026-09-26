import { useEffect } from "react";
import { useWorkspace } from "../store/workspace";

/** Click-to-zoom for document images (Esc or click to close). */
export function ImageZoom() {
  const src = useWorkspace((s) => s.zoomImage);

  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        useWorkspace.setState({ zoomImage: null });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [src]);

  if (!src) return null;
  return (
    <div className="image-zoom" role="dialog" aria-label="Image" onClick={() => useWorkspace.setState({ zoomImage: null })}>
      <img src={src} alt="" draggable={false} />
    </div>
  );
}
