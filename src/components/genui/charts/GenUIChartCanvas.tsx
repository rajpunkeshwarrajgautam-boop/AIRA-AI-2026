import React, { useEffect, useRef, useState } from 'react';
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PieController,
  PointElement,
  ScatterController,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import type { GenUIComponent } from '../../../../packages/contracts/src/genui';

Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
  PieController,
  DoughnutController,
  ArcElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  Filler
);

export type GenUIChartComponent = Extract<
  GenUIComponent,
  { type: 'bar_chart' | 'line_chart' | 'scatter_chart' | 'pie_chart' | 'doughnut_chart' }
>;

interface ThemeColors {
  isDark: boolean;
  text: string;
  muted: string;
  grid: string;
  surface: string;
  palette: string[];
}

function readThemeColors(): ThemeColors {
  if (typeof document === 'undefined') {
    return {
      isDark: false,
      text: '#1c1917',
      muted: '#57534e',
      grid: 'rgba(28, 25, 23, 0.1)',
      surface: '#ffffff',
      palette: ['#d97757', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2'],
    };
  }
  const isDark = document.documentElement.classList.contains('dark');
  const styles = getComputedStyle(document.documentElement);
  const text = styles.getPropertyValue('--text-primary').trim() || (isDark ? '#f5f5f4' : '#1c1917');
  const muted = styles.getPropertyValue('--text-secondary').trim() || (isDark ? '#a8a29e' : '#57534e');
  const grid = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(28, 25, 23, 0.09)';
  const surface = styles.getPropertyValue('--surface-base').trim() || (isDark ? '#272624' : '#ffffff');
  return {
    isDark,
    text,
    muted,
    grid,
    surface,
    palette: ['#d97757', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4'],
  };
}

function tokenToColor(token: string | undefined, index: number, palette: string[]): string {
  switch (token) {
    case 'primary':
      return palette[0];
    case 'secondary':
      return palette[1];
    case 'tertiary':
      return palette[2];
    case 'accent':
      return palette[0];
    case 'success':
      return '#10b981';
    case 'warning':
      return '#f59e0b';
    default:
      return palette[index % palette.length];
  }
}

export const GenUIChartCanvas: React.FC<{ component: GenUIChartComponent }> = ({ component }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const observer = new MutationObserver(() => setThemeTick((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const theme = readThemeColors();
    let config: ChartConfiguration;

    if (component.type === 'bar_chart') {
      const p = component.props;
      config = {
        type: 'bar',
        data: {
          labels: p.labels,
          datasets: p.datasets.map((ds, i) => {
            const color = tokenToColor(ds.colorToken, i, theme.palette);
            return {
              label: ds.label,
              data: ds.values,
              backgroundColor: color,
              borderRadius: 6,
              maxBarThickness: 40,
            };
          }),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: p.horizontal ? 'y' : 'x',
          plugins: {
            legend: { labels: { color: theme.text, boxWidth: 12 } },
            tooltip: {
              callbacks: p.unit
                ? { label: (item) => `${item.dataset.label}: ${item.formattedValue} ${p.unit}` }
                : undefined,
            },
          },
          scales: {
            x: { stacked: p.stacked, ticks: { color: theme.muted }, grid: { color: theme.grid } },
            y: { stacked: p.stacked, ticks: { color: theme.muted }, grid: { color: theme.grid } },
          },
        },
      };
    } else if (component.type === 'line_chart') {
      const p = component.props;
      config = {
        type: 'line',
        data: {
          labels: p.labels,
          datasets: p.datasets.map((ds, i) => {
            const color = tokenToColor(ds.colorToken, i, theme.palette);
            return {
              label: ds.label,
              data: ds.values,
              borderColor: color,
              backgroundColor: p.area ? `${color}26` : color,
              fill: p.area,
              tension: p.smooth ? 0.35 : 0,
              pointRadius: 3,
              borderWidth: 2,
            };
          }),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: theme.text, boxWidth: 12 } },
          },
          scales: {
            x: { stacked: p.stacked, ticks: { color: theme.muted }, grid: { color: theme.grid } },
            y: { stacked: p.stacked, ticks: { color: theme.muted }, grid: { color: theme.grid } },
          },
        },
      };
    } else if (component.type === 'scatter_chart') {
      const p = component.props;
      config = {
        type: 'scatter',
        data: {
          datasets: p.series.map((s, i) => {
            const color = tokenToColor(s.colorToken, i, theme.palette);
            return {
              label: s.label,
              data: s.points.map((pt) => ({ x: pt.x, y: pt.y })),
              backgroundColor: color,
              borderColor: color,
              pointRadius: 4,
              showLine: p.series.length === 1 && p.series[0].points.length > 8,
              borderWidth: 1.5,
            };
          }),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: theme.text } } },
          scales: {
            x: {
              title: { display: true, text: p.xLabel, color: theme.muted },
              ticks: { color: theme.muted },
              grid: { color: theme.grid },
            },
            y: {
              title: { display: true, text: p.yLabel, color: theme.muted },
              ticks: { color: theme.muted },
              grid: { color: theme.grid },
            },
          },
        },
      };
    } else {
      const p = component.props;
      config = {
        type: component.type === 'pie_chart' ? 'pie' : 'doughnut',
        data: {
          labels: p.labels,
          datasets: [
            {
              data: p.values,
              backgroundColor: p.labels.map((_, i) => theme.palette[i % theme.palette.length]),
              borderColor: theme.surface,
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { color: theme.text, padding: 14 } } },
        },
      };
    }

    const chart = new Chart(ctx, config);
    return () => {
      chart.destroy();
    };
  }, [component, themeTick]);

  return (
    <div className="relative h-64 min-h-[240px] w-full sm:h-72">
      <canvas ref={canvasRef} role="img" aria-label={component.props.title} />
    </div>
  );
};

export default GenUIChartCanvas;
