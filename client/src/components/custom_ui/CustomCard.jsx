import React from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { CustomUiIcon } from './CustomUiIcon';
import { CustomButtons } from './CustomButtons';

function SingleCard({ card = {}, onSend, onAction, disabled = false }) {
  const title = card?.title || card?.header || '';
  const subtitle = card?.subtitle || card?.subheading || '';
  const description = card?.description || card?.text || card?.content || '';
  const badge = card?.badge || card?.status || card?.tag || '';
  const badgeVariant = String(card?.badgeVariant || card?.statusVariant || 'info').toLowerCase();
  const icon = card?.icon || (badgeVariant === 'success' ? 'CheckCircle2' : 'Sparkles');

  const metrics = Array.isArray(card?.metrics) ? card.metrics : [];
  const items = Array.isArray(card?.items) ? card.items : Array.isArray(card?.list) ? card.list : [];
  const buttons = Array.isArray(card?.buttons) ? card.buttons : Array.isArray(card?.actions) ? card.actions : [];

  let badgeColor = 'bg-blue-500/15 text-blue-400 border-blue-500/30';
  let iconGlow = 'bg-blue-500/10 border-blue-500/25 text-blue-400';

  if (badgeVariant === 'success') {
    badgeColor = 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    iconGlow = 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400';
  } else if (badgeVariant === 'warning') {
    badgeColor = 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    iconGlow = 'bg-amber-500/10 border-amber-500/25 text-amber-400';
  } else if (badgeVariant === 'error' || badgeVariant === 'danger') {
    badgeColor = 'bg-red-500/15 text-red-400 border-red-500/30';
    iconGlow = 'bg-red-500/10 border-red-500/25 text-red-400';
  } else if (badgeVariant === 'purple' || badgeVariant === 'violet') {
    badgeColor = 'bg-purple-500/15 text-purple-400 border-purple-500/30';
    iconGlow = 'bg-purple-500/10 border-purple-500/25 text-purple-400';
  }

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Header */}
      {(title || subtitle || badge) && (
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            {icon && (
              <div className={`flex h-8 w-8 items-center justify-center rounded-xl border ${iconGlow} shrink-0`}>
                <CustomUiIcon name={icon} size={16} />
              </div>
            )}
            <div className="flex flex-col min-w-0">
              {title && (
                <span className="text-xs sm:text-sm font-semibold text-neutral-100 truncate leading-snug">
                  {title}
                </span>
              )}
              {subtitle && (
                <span className="text-[11px] text-neutral-400 truncate leading-tight mt-0.5">
                  {subtitle}
                </span>
              )}
            </div>
          </div>

          {badge && (
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide border uppercase shrink-0 ${badgeColor}`}>
              {badge}
            </span>
          )}
        </div>
      )}

      {/* Description */}
      {description && (
        <p className="text-xs text-neutral-300 leading-relaxed break-words">
          {description}
        </p>
      )}

      {/* Embedded Metrics Grid */}
      {metrics.length > 0 && (
        <div className={`grid gap-2 w-full pt-1 ${
          metrics.length === 1 ? 'grid-cols-1' : metrics.length === 2 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'
        }`}>
          {metrics.map((m, mIdx) => {
            const mVal = m?.value ?? m?.val ?? m?.count ?? '-';
            const mLabel = m?.label ?? m?.title ?? m?.name ?? '';
            const mChange = m?.change ?? m?.trend ?? '';
            const isPositive = String(mChange).startsWith('+');
            const isNegative = String(mChange).startsWith('-');

            return (
              <div
                key={mIdx}
                className="flex flex-col rounded-xl bg-neutral-950/60 border border-neutral-800/80 p-2.5 shadow-inner"
              >
                <span className="text-[10px] font-medium text-neutral-400 truncate uppercase tracking-wider">
                  {mLabel}
                </span>
                <div className="flex items-baseline justify-between gap-1 mt-1">
                  <span className="font-mono text-base font-bold text-neutral-100 truncate">
                    {mVal}
                  </span>
                  {mChange && (
                    <span
                      className={`flex items-center text-[10px] font-semibold font-mono ${
                        isPositive ? 'text-emerald-400' : isNegative ? 'text-red-400' : 'text-neutral-400'
                      }`}
                    >
                      {isPositive && <TrendingUp size={10} className="mr-0.5" />}
                      {isNegative && <TrendingDown size={10} className="mr-0.5" />}
                      {mChange}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Key-Value Item Rows */}
      {items.length > 0 && (
        <div className="flex flex-col divide-y divide-neutral-800/60 rounded-xl bg-neutral-950/50 border border-neutral-800/80 overflow-hidden text-xs">
          {items.map((it, itIdx) => {
            const isObj = typeof it === 'object' && it !== null;
            const itemLabel = isObj ? (it.label || it.key || it.name || '') : String(it);
            const itemVal = isObj ? (it.value ?? it.val ?? '') : '';

            return (
              <div key={itIdx} className="flex items-center justify-between px-3 py-2 gap-2">
                <span className="text-neutral-400 font-medium truncate">{itemLabel}</span>
                {itemVal !== '' && (
                  <span className="text-neutral-200 font-mono font-medium truncate text-right">
                    {String(itemVal)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Action Buttons */}
      {buttons.length > 0 && (
        <div className="pt-1">
          <CustomButtons
            buttons={buttons}
            onSend={onSend}
            onAction={onAction}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

export function CustomCard({ data = {}, onSend, onAction, disabled = false }) {
  // If data is an array of cards, render a card grid / carousel list
  if (Array.isArray(data)) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
        {data.map((c, i) => (
          <div
            key={i}
            className="rounded-2xl border border-neutral-700/60 bg-gradient-to-b from-neutral-900/90 to-neutral-950/90 p-4 shadow-xl backdrop-blur-md"
          >
            <SingleCard card={c} onSend={onSend} onAction={onAction} disabled={disabled} />
          </div>
        ))}
      </div>
    );
  }

  // If data has `cards: [...]`
  if (Array.isArray(data?.cards)) {
    return (
      <div className="flex flex-col gap-3 w-full">
        {data.title && (
          <span className="text-xs font-semibold text-neutral-200 uppercase tracking-wider">
            {data.title}
          </span>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
          {data.cards.map((c, i) => (
            <div
              key={i}
              className="rounded-2xl border border-neutral-700/60 bg-gradient-to-b from-neutral-900/90 to-neutral-950/90 p-4 shadow-xl backdrop-blur-md"
            >
              <SingleCard card={c} onSend={onSend} onAction={onAction} disabled={disabled} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Single card
  return <SingleCard card={data} onSend={onSend} onAction={onAction} disabled={disabled} />;
}
