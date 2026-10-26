import { Suspense } from "react";

import { ConversationsView } from "../../components/internal/conversations-view";

export default function InternalConversationsPage() {
  return <Suspense><ConversationsView /></Suspense>;
}
