import { motion } from 'framer-motion';

export function SidebarButton({ children, active, onClick, icon }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl transition-all duration-200 relative group ${
        active
          ? 'text-emerald-400 bg-emerald-500/10'
          : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/5'
      }`}
    >
      <div className={`transition-transform duration-300 ${active ? 'scale-110' : 'group-hover:scale-110'}`}>
        {icon}
      </div>
      <span className={`text-sm text-start font-medium tracking-wide ${active ? 'opacity-100' : 'opacity-80 group-hover:opacity-100'}`}>
        {children}
      </span>
      {active && (
        <motion.div
           layoutId="sidebar-active"
           className="absolute left-0 w-1 h-6 bg-emerald-500 rounded-r-full shadow-[0_0_10px_rgba(16,185,129,0.5)]"
        />
      )}
    </button>
  );
}

