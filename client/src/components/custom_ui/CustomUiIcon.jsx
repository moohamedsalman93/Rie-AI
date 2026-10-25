import React from 'react';
import * as LucideIcons from 'lucide-react';
import {
  Sparkles,
  BarChart3,
  PieChart,
  LineChart,
  Activity,
  Layers,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Info,
  ShieldCheck,
  TrendingUp,
  TrendingDown,
  ArrowRight,
  ExternalLink,
  Copy,
  Check,
  Play,
  RotateCw,
  Cpu,
  Database,
  Server,
  Terminal,
  Folder,
  FileText,
  Calendar,
  Clock,
  Zap,
  Globe,
  Settings,
  Star,
  Flame,
  Rocket,
  Box,
  Code2,
} from 'lucide-react';

const COMMON_ICONS = {
  sparkles: Sparkles,
  barchart: BarChart3,
  barchart3: BarChart3,
  chart: BarChart3,
  piechart: PieChart,
  pie: PieChart,
  donut: PieChart,
  linechart: LineChart,
  line: LineChart,
  activity: Activity,
  layers: Layers,
  check: Check,
  checkcircle: CheckCircle2,
  checkcircle2: CheckCircle2,
  success: CheckCircle2,
  alert: AlertCircle,
  alertcircle: AlertCircle,
  warning: AlertCircle,
  error: AlertCircle,
  help: HelpCircle,
  info: Info,
  shield: ShieldCheck,
  shieldcheck: ShieldCheck,
  trendingup: TrendingUp,
  trendingdown: TrendingDown,
  arrowright: ArrowRight,
  externallink: ExternalLink,
  copy: Copy,
  play: Play,
  refresh: RotateCw,
  cpu: Cpu,
  database: Database,
  server: Server,
  terminal: Terminal,
  folder: Folder,
  file: FileText,
  calendar: Calendar,
  clock: Clock,
  zap: Zap,
  globe: Globe,
  settings: Settings,
  star: Star,
  flame: Flame,
  rocket: Rocket,
  box: Box,
  code: Code2,
};

/**
 * Resolves a Lucide icon by name with fallback
 */
export function CustomUiIcon({ name, size = 16, className = '', defaultIcon: DefaultIcon = Sparkles, ...props }) {
  if (!name || typeof name !== 'string') {
    return <DefaultIcon size={size} className={className} {...props} />;
  }

  const normalized = name.toLowerCase().replace(/[-_\s]/g, '');

  if (COMMON_ICONS[normalized]) {
    const IconComponent = COMMON_ICONS[normalized];
    return <IconComponent size={size} className={className} {...props} />;
  }

  // Check direct lookup in LucideIcons export
  const pascalName = name
    .split(/[-_\s]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');

  if (LucideIcons[pascalName]) {
    const IconComponent = LucideIcons[pascalName];
    return <IconComponent size={size} className={className} {...props} />;
  }

  return <DefaultIcon size={size} className={className} {...props} />;
}
