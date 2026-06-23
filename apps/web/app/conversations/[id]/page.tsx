import { redirect } from "next/navigation";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/?conversationId=${id}`);
}
