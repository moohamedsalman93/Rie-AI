import { motion } from 'framer-motion';

export function SidebarButton({ children, active, onClick, icon }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-150 relative group ${
        active
          ? 'text-white bg-white/[0.08]'
          : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.03]'
      }`}
    >
      <div className={`shrink-0 ${active ? 'text-emerald-400' : 'text-neutral-500 group-hover:text-neutral-300'}`}>
        {icon}
      </div>
      <span className="text-xs text-start font-medium tracking-normal truncate">
        {children}
      </span>
      {active && (
        <motion.div
           layoutId="sidebar-active"
           className="absolute left-0 w-0.5 h-4 bg-emerald-400 rounded-r-full"
        />
      )}
    </button>
  );
}

