import React, { useMemo } from 'react';
import { BarChart3, LineChart, PieChart, Activity, TrendingUp, GitBranch } from 'lucide-react';
import { SvgBarChart } from './SvgBarChart';
import { SvgLineChart } from './SvgLineChart';
import { SvgPieChart } from './SvgPieChart';
import { SvgProgressMeter } from './SvgProgressMeter';
import { SvgFlowchart } from './SvgFlowchart';

export function CustomChart({ data = {}, onSend, onAction }) {
  // Normalize chart config
  const chartType = String(data?.type || data?.chartType || 'bar').toLowerCase();
  const title = data?.title || data?.header || '';
  const subtitle = data?.subtitle || data?.description || '';
  const chartData = data?.data || data?.items || data?.points || [];

  const IconComponent = useMemo(() => {
    switch (chartType) {
      case 'flowchart':
      case 'pipeline':
      case 'workflow':
        return GitBranch;
      case 'line':
      case 'area':
        return LineChart;
      case 'pie':
      case 'donut':
        return PieChart;
      case 'progress':
      case 'gauge':
        return Activity;
      default:
        return BarChart3;
    }
  }, [chartType]);

  const renderChart = () => {
    // Defensive fallback: if a flowchart / pipeline data payload was sent to CustomChart
    if (
      chartType.includes('flowchart') ||
      chartType === 'pipeline' ||
      chartType === 'workflow' ||
      chartType === 'stages' ||
      Boolean(data?.steps) ||
      Boolean(data?.stages) ||
      Boolean(data?.phases) ||
      Boolean(data?.nodes)
    ) {
      return <SvgFlowchart data={data} onSend={onSend} onAction={onAction} />;
    }

    switch (chartType) {
      case 'horizontal_bar':
      case 'bar_horizontal':
        return <SvgBarChart data={chartData} horizontal={true} />;
      case 'line':
        return <SvgLineChart data={chartData} isArea={false} strokeColor={data?.color} />;
      case 'area':
        return <SvgLineChart data={chartData} isArea={true} strokeColor={data?.color} />;
      case 'pie':
        return <SvgPieChart data={chartData} isDonut={false} />;
      case 'donut':
        return <SvgPieChart data={chartData} isDonut={true} />;
      case 'progress':
      case 'gauge':
        return (
          <SvgProgressMeter
            value={data?.value ?? chartData?.[0]?.value ?? 0}
            max={data?.max ?? 100}
            label={data?.label || chartData?.[0]?.label || ''}
            unit={data?.unit || '%'}
            status={data?.status || 'default'}
            color={data?.color}
            circular={chartType === 'gauge'}
          />
        );
      case 'bar':
      default:
        return <SvgBarChart data={chartData} horizontal={Boolean(data?.horizontal)} />;
    }
  };

  return (
    <div className="w-full flex flex-col gap-2">
      {(title || subtitle) && (
        <div className="flex items-start justify-between gap-2 border-b border-neutral-800/80 pb-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 shrink-0">
              <IconComponent size={15} />
            </div>
            <div className="flex flex-col min-w-0">
              {title && (
                <span className="text-xs font-semibold text-neutral-100 truncate">
                  {title}
                </span>
              )}
              {subtitle && (
                <span className="text-[11px] text-neutral-400 truncate">
                  {subtitle}
                </span>
              )}
            </div>
          </div>
          {data?.badge && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide bg-blue-500/15 text-blue-400 border border-blue-500/30 shrink-0">
              {data.badge}
            </span>
          )}
        </div>
      )}

      {/* Main Chart Body */}
      <div className="w-full pt-1">
        {renderChart()}
      </div>

      {/* Optional summary footer */}
      {data?.footer && (
        <div className="pt-2 border-t border-neutral-800/60 text-[11px] text-neutral-400 italic">
          {data.footer}
        </div>
      )}
    </div>
  );
}
