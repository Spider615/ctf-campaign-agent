import { ConversationDetailView } from "../../../components/internal/conversation-detail";

export default async function InternalConversationPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <ConversationDetailView conversationKey={decodeURIComponent(key)} />;
}
