import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

/**
 * Sleek, accessible InfoTooltip component.
 * Uses a portal into document.body to prevent clipping by parent scrollbars or overflow-hidden cards.
 *
 * @param {Object} props
 * @param {string|React.ReactNode} [props.text] - Tooltip text or node (can also be passed as children)
 * @param {React.ReactNode} [props.children] - Alternative way to pass tooltip content
 * @param {'top'|'bottom'|'left'|'right'} [props.placement='top'] - Preferred placement
 * @param {number} [props.size=13.5] - Icon size in px
 * @param {string} [props.className] - Additional classes for the trigger wrapper
 * @param {string} [props.tooltipClassName] - Additional classes for the tooltip box
 * @param {React.ReactNode} [props.icon] - Custom icon replacement
 */
export function InfoTooltip({
  text,
  children,
  placement = 'top',
  size = 13.5,
  className = '',
  tooltipClassName = '',
  icon,
}) {
  const content = text || children;
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);
  const tooltipRef = useRef(null);
  const timeoutRef = useRef(null);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    // Use measured tooltip size if available, otherwise estimate
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    const tooltipWidth = tooltipRect?.width || 240;
    const tooltipHeight = tooltipRect?.height || 50;
    const gap = 6;

    let top = 0;
    let left = 0;

    if (placement === 'bottom') {
      top = triggerRect.bottom + scrollY + gap;
      left = triggerRect.left + scrollX + triggerRect.width / 2 - tooltipWidth / 2;
    } else if (placement === 'left') {
      top = triggerRect.top + scrollY + triggerRect.height / 2 - tooltipHeight / 2;
      left = triggerRect.left + scrollX - tooltipWidth - gap;
    } else if (placement === 'right') {
      top = triggerRect.top + scrollY + triggerRect.height / 2 - tooltipHeight / 2;
      left = triggerRect.right + scrollX + gap;
    } else {
      // 'top' (default)
      top = triggerRect.top + scrollY - tooltipHeight - gap;
      left = triggerRect.left + scrollX + triggerRect.width / 2 - tooltipWidth / 2;
    }

    // Boundary clamping (viewport padding: 12px)
    const viewportWidth = window.innerWidth;
    const minLeft = scrollX + 12;
    const maxLeft = scrollX + viewportWidth - tooltipWidth - 12;
    left = Math.max(minLeft, Math.min(left, maxLeft));

    // If top position went offscreen on top, flip to bottom
    if (placement === 'top' && top < scrollY + 8) {
      top = triggerRect.bottom + scrollY + gap;
    }

    setCoords({ top, left });
  }, [placement]);

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      updatePosition();
      setIsVisible(true);
    }, 80);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setIsVisible(false);
    }, 120);
  };

  useEffect(() => {
    if (isVisible) {
      updatePosition();
      const onResizeOrScroll = () => updatePosition();
      window.addEventListener('resize', onResizeOrScroll, { passive: true });
      window.addEventListener('scroll', onResizeOrScroll, { passive: true });
      return () => {
        window.removeEventListener('resize', onResizeOrScroll);
        window.removeEventListener('scroll', onResizeOrScroll);
      };
    }
  }, [isVisible, updatePosition]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  if (!content) return null;

  return (
    <span
      ref={triggerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseEnter}
      onBlur={handleMouseLeave}
      tabIndex={0}
      role="button"
      aria-label="More information"
      className={`inline-flex items-center justify-center cursor-help text-neutral-500 hover:text-emerald-400 focus:text-emerald-400 outline-none transition-colors shrink-0 select-none align-middle ${className}`}
      onClick={(e) => {
        // Allow mobile tap toggle
        e.preventDefault();
        e.stopPropagation();
        setIsVisible((prev) => !prev);
        if (!isVisible) updatePosition();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setIsVisible(false);
      }}
    >
      {icon || <Info size={size} className="stroke-[1.75]" />}

      {isVisible &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            style={{
              position: 'absolute',
              top: `${coords.top}px`,
              left: `${coords.left}px`,
            }}
            className={`z-[9999] max-w-xs sm:max-w-sm rounded-lg bg-neutral-900/95 border border-neutral-700/80 text-neutral-200 text-[11px] leading-relaxed px-3 py-2 shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100 pointer-events-auto select-text font-normal normal-case tracking-normal ${tooltipClassName}`}
          >
            {content}
          </div>,
          document.body
        )}
    </span>
  );
}

export default InfoTooltip;

