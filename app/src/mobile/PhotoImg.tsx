// ─── a part photo: web variant first, master if that 404s ────────────────────
//
// Thumbs, the hero and the admin gallery all show the cropped web variant
// (see photoWebUrl). The lightbox deliberately does NOT — it is the "see the
// original" surface, and pinch-zoom on the master gives the same pixels the
// crop would. The fallback is keyed on the path so a re-render with a new
// photo starts again from the variant rather than inheriting a stale "failed".
//
// Its own file so DiagramView's part list can use it too without importing
// MobileShell (which imports DiagramView). Before that, the diagram list
// loaded the master for a 52 px thumb — up to 3.2 MB for one row (PERF-6).
import { useState } from "react";
import { assetUrl, photoWebUrl } from "../assets";

export function PhotoImg({ path, alt, className, onClick }: {
  path: string; alt: string; className?: string; onClick?: () => void;
}) {
  const web = photoWebUrl(path);
  const [failed, setFailed] = useState<string | null>(null);
  const useWeb = !!web && failed !== path;
  return (
    <img className={className} src={useWeb ? web : assetUrl(path)} alt={alt} loading="lazy"
      onClick={onClick}
      onError={useWeb ? () => setFailed(path) : undefined} />
  );
}
