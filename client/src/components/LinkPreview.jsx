import { ExternalLink, Globe } from "lucide-react";

async function openExternal(href) {
  if (!href) return;
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
  } catch {
    window.open(href, "_blank", "noopener,noreferrer");
  }
}

function PreviewCard({ preview, onOpen }) {
  const { url, title, description, image, site_name: siteName, error, loading } = preview;
  const hostname = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();

  if (loading) {
    return (
      <div className="mt-2 overflow-hidden rounded-lg border border-neutral-600/40 bg-neutral-800/60 animate-pulse">
        <div className="h-24 bg-neutral-700/50" />
        <div className="space-y-2 p-3">
          <div className="h-3 w-2/3 rounded bg-neutral-600/70" />
          <div className="h-2 w-full rounded bg-neutral-700/60" />
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(url)}
      className="mt-2 w-full overflow-hidden rounded-lg border border-neutral-600/40 bg-neutral-800/80 text-left transition hover:border-neutral-500/60 hover:bg-neutral-800"
    >
      {image && !error && (
        <div className="max-h-36 w-full overflow-hidden border-b border-neutral-700/50 bg-neutral-900">
          <img
            src={image}
            alt=""
            className="h-full max-h-36 w-full object-cover"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        </div>
      )}
      <div className="flex items-start gap-2 p-3">
        <Globe size={14} className="mt-0.5 shrink-0 text-neutral-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
            <span className="truncate">{siteName || hostname}</span>
            <ExternalLink size={10} className="shrink-0 opacity-60" />
          </div>
          {title && (
            <p className="mt-0.5 line-clamp-2 text-sm font-medium text-neutral-100">{title}</p>
          )}
          {description && (
            <p className="mt-1 line-clamp-2 text-xs text-neutral-400">{description}</p>
          )}
          {!title && !description && (
            <p className="mt-0.5 truncate text-xs text-neutral-400">{url}</p>
          )}
          {error && (
            <p className="mt-1 text-[10px] text-amber-500/90">{error}</p>
          )}
        </div>
      </div>
    </button>
  );
}

export function LinkPreview({ previews }) {
  if (!previews?.length) return null;

  return (
    <div className="flex flex-col gap-0">
      {previews.map((preview) => (
        <PreviewCard
          key={preview.url}
          preview={preview}
          onOpen={openExternal}
        />
      ))}
    </div>
  );
}
