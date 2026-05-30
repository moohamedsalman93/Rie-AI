/** Plain Beta label (accessibility: title + aria-label). */
export function BetaLabel({ className = "" }) {
  return (
    <span
      aria-label="Beta"
      title="Beta"
      className={`inline text-neutral-400 font-medium ${className}`}
    >
      Beta
    </span>
  );
}
