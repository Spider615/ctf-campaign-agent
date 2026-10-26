import { Suspense } from "react";

import { StatsView } from "../../components/internal/stats-view";

export default function InternalStatsPage() {
  return <Suspense><StatsView /></Suspense>;
}
