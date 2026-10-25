export function SubTabBar({ tabs, activeId, onChange, className = '' }) {
  return (
    <div className={`inline-flex flex-wrap items-center p-1 bg-neutral-900/80 rounded-xl border border-white/[0.06] gap-1 ${className}`}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-all ${
            activeId === tab.id
              ? 'bg-neutral-800 text-neutral-100 font-medium shadow-sm border border-white/10'
              : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.03] border border-transparent'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
