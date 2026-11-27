import React from 'react';
import type { GenUIComponent, GenUIComponentType } from '../../../packages/contracts/src/genui';
import type { GenUIComponentRenderer, GenUIRenderContext } from './types';
import {
  CaptionRenderer,
  CodeBlockRenderer,
  DataSummaryRenderer,
  DataTableRenderer,
  DividerRenderer,
  HeadingRenderer,
  MathBlockRenderer,
  RichTextRenderer,
  TextRenderer,
} from './ContentRenderers';
import {
  AdaptiveContainerRenderer,
  CardRenderer,
  HorizontalGroupRenderer,
  ResponsiveGridRenderer,
  SectionRenderer,
  VerticalGroupRenderer,
} from './LayoutRenderers';
import { LazyGenUIChart, type GenUIChartComponent } from './charts/LazyGenUIChart';
import {
  ActionButtonRenderer,
  CheckboxRenderer,
  ComparisonVizRenderer,
  MetricDisplayRenderer,
  NumericInputRenderer,
  ProgressIndicatorRenderer,
  RadioGroupRenderer,
  ResetControlRenderer,
  SegmentedControlRenderer,
  SelectControlRenderer,
  SliderRenderer,
  TextInputRenderer,
} from './VizAndInteractiveRenderers';
import {
  ApprovalRequestRenderer,
  ArtifactReferenceRenderer,
  ErrorRecoveryRenderer,
  ExecutionTimelineRenderer,
  MissionSummaryRenderer,
  TaskStatusRenderer,
  ToolExecutionSummaryRenderer,
} from './AgentExecutionRenderers';

const ChartWrapper: React.FC<{ component: GenUIChartComponent; ctx: GenUIRenderContext }> = ({ component }) => (
  <LazyGenUIChart component={component} />
);

export type RegistryMap = {
  [K in GenUIComponentType]: GenUIComponentRenderer<K>;
};

export const GENUI_COMPONENT_REGISTRY: RegistryMap = {
  text: TextRenderer,
  heading: HeadingRenderer,
  caption: CaptionRenderer,
  rich_text: RichTextRenderer,
  divider: DividerRenderer,
  code_block: CodeBlockRenderer,
  math_block: MathBlockRenderer,
  data_table: DataTableRenderer,
  data_summary: DataSummaryRenderer,

  vertical_group: VerticalGroupRenderer,
  horizontal_group: HorizontalGroupRenderer,
  responsive_grid: ResponsiveGridRenderer,
  card: CardRenderer,
  section: SectionRenderer,
  adaptive_container: AdaptiveContainerRenderer,

  bar_chart: ChartWrapper as GenUIComponentRenderer<'bar_chart'>,
  line_chart: ChartWrapper as GenUIComponentRenderer<'line_chart'>,
  scatter_chart: ChartWrapper as GenUIComponentRenderer<'scatter_chart'>,
  pie_chart: ChartWrapper as GenUIComponentRenderer<'pie_chart'>,
  doughnut_chart: ChartWrapper as GenUIComponentRenderer<'doughnut_chart'>,
  progress_indicator: ProgressIndicatorRenderer,
  metric_display: MetricDisplayRenderer,
  comparison_viz: ComparisonVizRenderer,

  numeric_input: NumericInputRenderer,
  text_input: TextInputRenderer,
  slider: SliderRenderer,
  select_control: SelectControlRenderer,
  checkbox: CheckboxRenderer,
  radio_group: RadioGroupRenderer,
  segmented_control: SegmentedControlRenderer,
  reset_control: ResetControlRenderer,
  action_button: ActionButtonRenderer,

  mission_summary: MissionSummaryRenderer,
  task_status: TaskStatusRenderer,
  execution_timeline: ExecutionTimelineRenderer,
  tool_execution_summary: ToolExecutionSummaryRenderer,
  artifact_reference: ArtifactReferenceRenderer,
  approval_request: ApprovalRequestRenderer,
  error_recovery: ErrorRecoveryRenderer,
};

export function isSupportedGenUIComponentType(type: unknown): type is GenUIComponentType {
  return typeof type === 'string' && Object.hasOwn(GENUI_COMPONENT_REGISTRY, type);
}

export function renderRegisteredComponent(component: GenUIComponent, ctx: GenUIRenderContext): React.ReactNode {
  if (!isSupportedGenUIComponentType(component.type)) {
    return null;
  }
  const Renderer = GENUI_COMPONENT_REGISTRY[component.type] as React.FC<{
    component: GenUIComponent;
    ctx: GenUIRenderContext;
  }>;
  return <Renderer key={component.id} component={component} ctx={ctx} />;
}
