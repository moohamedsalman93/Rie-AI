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

  let badgeColor = 'bg-blue-500/10 text-blue-400 border-blue-500/25';
  let badgeDot = 'bg-blue-400';
  let iconGlow = 'bg-blue-500/10 border-blue-500/20 text-blue-400';

  if (badgeVariant === 'success') {
    badgeColor = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25';
    badgeDot = 'bg-emerald-400';
    iconGlow = 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
  } else if (badgeVariant === 'warning') {
    badgeColor = 'bg-amber-500/10 text-amber-400 border-amber-500/25';
    badgeDot = 'bg-amber-400';
    iconGlow = 'bg-amber-500/10 border-amber-500/20 text-amber-400';
  } else if (badgeVariant === 'error' || badgeVariant === 'danger') {
    badgeColor = 'bg-red-500/10 text-red-400 border-red-500/25';
    badgeDot = 'bg-red-400';
    iconGlow = 'bg-red-500/10 border-red-500/20 text-red-400';
  } else if (badgeVariant === 'purple' || badgeVariant === 'violet') {
    badgeColor = 'bg-purple-500/10 text-purple-400 border-purple-500/25';
    badgeDot = 'bg-purple-400';
    iconGlow = 'bg-purple-500/10 border-purple-500/20 text-purple-400';
  }

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Header */}
      {(title || subtitle || badge) && (
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            {icon && (
              <div className={`flex h-8 w-8 items-center justify-center rounded-xl border ${iconGlow} shrink-0 mt-0.5 shadow-sm`}>
                <CustomUiIcon name={icon} size={16} />
              </div>
            )}
            <div className="flex flex-col min-w-0">
              {title && (
                <span className="text-sm font-semibold text-neutral-100 leading-snug">
                  {title}
                </span>
              )}
              {subtitle && (
                <span className="text-[11px] text-neutral-400 leading-tight mt-0.5">
                  {subtitle}
                </span>
              )}
            </div>
          </div>

          {badge && (
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wider border uppercase shrink-0 ${badgeColor}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${badgeDot}`} />
              {badge}
            </span>
          )}
        </div>
      )}

      {/* Description */}
      {description && (
        <p className="text-xs sm:text-[13px] text-neutral-300 leading-relaxed break-words font-normal">
          {description}
        </p>
      )}

      {/* Embedded Metrics / Insights Grid */}
      {metrics.length > 0 && (() => {
        const hasTextualInsights = metrics.some((m) => {
          const val = String(m?.value ?? m?.val ?? m?.count ?? '');
          return val.length > 10 || val.includes(' ');
        });

        const gridCols =
          metrics.length === 1
            ? 'grid-cols-1'
            : metrics.length === 2
            ? 'grid-cols-1 sm:grid-cols-2'
            : hasTextualInsights
            ? 'grid-cols-1 md:grid-cols-3'
            : 'grid-cols-2 sm:grid-cols-3';

        return (
          <div className={`grid gap-2.5 w-full pt-1 ${gridCols}`}>
            {metrics.map((m, mIdx) => {
              const mVal = m?.value ?? m?.val ?? m?.count ?? '-';
              const mLabel = m?.label ?? m?.title ?? m?.name ?? '';
              const mChange = m?.change ?? m?.trend ?? '';
              const isPositive = String(mChange).startsWith('+');
              const isNegative = String(mChange).startsWith('-');
              const isTextVal = String(mVal).length > 10 || String(mVal).includes(' ');

              return (
                <div
                  key={mIdx}
                  className="flex flex-col justify-between rounded-xl bg-neutral-950/40 border border-neutral-800/70 p-3 hover:border-neutral-700/60 transition-colors"
                >
                  {mLabel && (
                    <span className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider leading-snug mb-1.5 break-words">
                      {mLabel}
                    </span>
                  )}
                  <div className="flex flex-col gap-1 mt-auto">
                    <div className="flex items-baseline justify-between gap-1.5">
                      <span
                        className={
                          isTextVal
                            ? 'text-xs font-medium text-neutral-200 leading-relaxed break-words'
                            : 'font-mono text-base font-bold text-neutral-100 tracking-tight'
                        }
                      >
                        {mVal}
                      </span>
                      {mChange && (
                        <span
                          className={`flex items-center text-[10px] font-semibold font-mono shrink-0 ${
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
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Key-Value Item Rows */}
      {items.length > 0 && (
        <div className="flex flex-col divide-y divide-neutral-800/50 rounded-xl bg-neutral-950/40 border border-neutral-800/70 overflow-hidden text-xs">
          {items.map((it, itIdx) => {
            const isObj = typeof it === 'object' && it !== null;
            const itemLabel = isObj ? (it.label || it.key || it.name || '') : String(it);
            const itemVal = isObj ? (it.value ?? it.val ?? '') : '';

            return (
              <div key={itIdx} className="flex items-center justify-between px-3.5 py-2.5 gap-2 hover:bg-white/[0.02] transition-colors">
                <span className="text-neutral-400 font-medium truncate">{itemLabel}</span>
                {itemVal !== '' && (
                  <span className="text-neutral-200 font-medium break-words text-right">
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
            className="rounded-xl border border-neutral-800/80 bg-neutral-950/40 p-4 shadow-sm"
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
          <span className="text-xs font-semibold text-neutral-300 uppercase tracking-wider">
            {data.title}
          </span>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
          {data.cards.map((c, i) => (
            <div
              key={i}
              className="rounded-xl border border-neutral-800/80 bg-neutral-950/40 p-4 shadow-sm"
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
