export function SubTabBar({ tabs, activeId, onChange, className = '' }) {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold tracking-wide border transition-colors ${
            activeId === tab.id
              ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
              : 'bg-white/[0.02] border-white/10 text-neutral-400 hover:text-neutral-200'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
