import { AnalyticsWorkspace } from "../../components/analytics/analytics-workspace";
export default async function AnalysisReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AnalyticsWorkspace initialReportId={id} />;
}
