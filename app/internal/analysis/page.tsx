import { ImportedAnalyticsWorkspace } from "../../components/analytics/analytics-workspace";

// 数据导入与口径检查供内部维护，不从客户首页提供入口。
export default function InternalAnalysisPage() {
  return <ImportedAnalyticsWorkspace />;
}
